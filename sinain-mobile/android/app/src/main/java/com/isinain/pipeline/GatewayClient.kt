package com.isinain.pipeline

import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * WebSocket gateway client for OpenClaw agent RPC.
 * Port of iOS GatewayClient.swift using OkHttp WebSocket.
 *
 * Protocol:
 *  1. Server sends connect.challenge event
 *  2. Client responds with connect request + auth token
 *  3. Client sends 'agent' RPC, server replies with accepted then final response
 *  4. Reconnect with exponential backoff
 *  5. Circuit breaker: 5 failures in 2min → open for 5min, progressive up to 30min
 */
class GatewayClient(
    private val wsUrl: String,
    private val token: String,
    private val sessionKey: String
) : GatewayConnecting {

    var onStatusChange: ((String) -> Unit)? = null
    var onResponse: ((String) -> Unit)? = null

    private val log = PipelineLogger("GatewayClient")
    private val httpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)  // no timeout for WebSocket reads
        .build()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()

    private var webSocket: WebSocket? = null
    private var authenticated = false
    private var rpcId = 1
    private var closing = false
    private var pendingRunId: String? = null

    // Pending RPCs
    private data class PendingRpc(
        val continuation: CancellableContinuation<String?>,
        var timeoutFuture: ScheduledFuture<*>?,
        val expectFinal: Boolean
    )
    private val pending = ConcurrentHashMap<String, PendingRpc>()

    // Reconnect backoff
    private var reconnectDelay = 1.0
    private val maxReconnectDelay = 60.0
    private var reconnectFuture: ScheduledFuture<*>? = null

    // Circuit breaker
    private val recentFailures = mutableListOf<Long>()
    private var circuitOpenFlag = false
    private var circuitResetFuture: ScheduledFuture<*>? = null
    private val circuitThreshold = 5
    private val circuitWindowMs = 120_000L
    private var circuitResetDelay = 300_000L  // 5 min
    private val maxCircuitReset = 1_800_000L  // 30 min

    override val isConnected: Boolean
        get() = webSocket != null && authenticated

    override val isCircuitOpen: Boolean
        get() = circuitOpenFlag

    // ── Public API ────────────────────────────────────────────

    override fun start() {
        if (closing) return
        connect()
    }

    override suspend fun sendAgentRpc(message: String, idempotencyKey: String): String? {
        if (circuitOpenFlag) {
            log.warn("circuit breaker open, skipping RPC")
            return null
        }
        if (!isConnected) {
            log.warn("not connected, cannot send RPC")
            return null
        }

        val id = rpcId.toString()
        rpcId++

        return suspendCancellableCoroutine { continuation ->
            val timeoutFuture = scheduler.schedule({
                val rpc = pending.remove(id)
                if (rpc != null) {
                    onRpcFailure()
                    rpc.continuation.resume(null)
                }
            }, 60, TimeUnit.SECONDS)

            pending[id] = PendingRpc(continuation, timeoutFuture, true)

            continuation.invokeOnCancellation {
                pending.remove(id)?.timeoutFuture?.cancel(false)
            }

            pendingRunId = idempotencyKey

            val payload = JSONObject().apply {
                put("type", "req")
                put("method", "agent")
                put("id", id)
                put("params", JSONObject().apply {
                    put("message", message)
                    put("sessionKey", sessionKey)
                    put("idempotencyKey", idempotencyKey)
                    put("deliver", false)
                })
            }

            sendJson(payload)
            log.info("agent RPC sent (id=$id): ${message.take(100)}")
        }
    }

    override fun close() {
        closing = true
        reconnectFuture?.cancel(false)
        reconnectFuture = null
        circuitResetFuture?.cancel(false)
        circuitResetFuture = null
        webSocket?.close(1001, "going away")
        webSocket = null
        onDisconnect()
    }

    // ── Connection ────────────────────────────────────────────

    private fun connect() {
        if (closing || circuitOpenFlag) return
        onStatusChange?.invoke("connecting")
        log.info("connecting to $wsUrl")

        val request = Request.Builder().url(wsUrl).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                log.info("ws connected (awaiting challenge)")
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    handleMessage(json)
                } catch (e: Exception) {
                    log.error("failed to parse message: ${e.message}")
                }
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                log.error("ws failure: ${t.message}")
                webSocket = null
                onDisconnect()
                if (!closing) scheduleReconnect()
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                log.info("ws closing: $code $reason")
                ws.close(code, reason)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                log.info("ws closed: $code $reason")
                webSocket = null
                onDisconnect()
                if (!closing) scheduleReconnect()
            }
        })
    }

    // ── Message Handling ──────────────────────────────────────

    private fun handleMessage(msg: JSONObject) {
        val type = msg.optString("type", "")

        // 1. Handle connect.challenge
        if (type == "event" && msg.optString("event") == "connect.challenge") {
            log.info("received challenge, authenticating...")
            sendJson(JSONObject().apply {
                put("type", "req")
                put("id", "connect-1")
                put("method", "connect")
                put("params", JSONObject().apply {
                    put("minProtocol", 3)
                    put("maxProtocol", 3)
                    put("client", JSONObject().apply {
                        put("id", "gateway-client")
                        put("displayName", "ISinain Mobile (Android)")
                        put("version", "1.0.0")
                        put("platform", "android")
                        put("mode", "backend")
                    })
                    put("auth", JSONObject().apply {
                        put("token", token)
                    })
                })
            })
            return
        }

        // 2. Handle connect response (auth result)
        if (type == "res" && msg.optString("id") == "connect-1") {
            if (msg.optBoolean("ok", false)) {
                authenticated = true
                reconnectDelay = 1.0
                log.info("authenticated")
                onStatusChange?.invoke("connected")
            } else {
                val err = msg.opt("error") ?: "unknown auth error"
                log.error("auth failed: $err")
                reconnectDelay = maxOf(reconnectDelay, 30.0)
                webSocket?.close(1000, "auth failed")
                webSocket = null
            }
            return
        }

        // 3. Handle streaming events (filter by runId to prevent cross-talk)
        if (type == "event" && msg.optString("event") == "agent") {
            val payload = msg.optJSONObject("payload")
            if (payload != null) {
                // Only process events matching our pending RPC
                val eventRunId = payload.optString("runId", "")
                if (eventRunId != pendingRunId) return

                if (payload.optString("stream") == "assistant") {
                    val data = payload.optJSONObject("data")
                    val text = data?.optString("text", "") ?: ""
                    if (text.isNotEmpty()) {
                        onResponse?.invoke(text)
                    }
                }
            }
            return
        }

        // 4. Ignore other events
        if (type == "event") return

        // 5. Handle RPC responses
        val msgId: String? = when {
            msg.has("id") && msg.get("id") is Int -> msg.getInt("id").toString()
            msg.has("id") -> msg.optString("id")
            else -> null
        }

        if (type == "res" && msgId != null) {
            val pendingRpc = pending[msgId] ?: return
            val payload = msg.optJSONObject("payload") ?: JSONObject()

            // Skip intermediate "accepted" responses
            if (pendingRpc.expectFinal && payload.optString("status") == "accepted") {
                log.debug("rpc $msgId: accepted")
                return
            }

            log.debug("rpc $msgId: final")
            pendingRpc.timeoutFuture?.cancel(false)
            pending.remove(msgId)

            if (msg.optBoolean("ok", false)) {
                circuitResetDelay = 300_000L
                val result = payload.optJSONObject("result") ?: JSONObject()
                val payloads = result.optJSONArray("payloads") ?: JSONArray()
                val texts = mutableListOf<String>()
                for (i in 0 until payloads.length()) {
                    val text = payloads.optJSONObject(i)?.optString("text", "") ?: ""
                    if (text.isNotEmpty()) texts.add(text)
                }
                var responseText = texts.joinToString("\n")

                if (responseText.isEmpty()) {
                    val sentTexts = result.optJSONArray("messagingToolSentTexts")
                    if (sentTexts != null && sentTexts.length() > 0) {
                        val sentList = mutableListOf<String>()
                        for (i in 0 until sentTexts.length()) {
                            sentList.add(sentTexts.optString(i, ""))
                        }
                        responseText = sentList.joinToString("\n")
                    }
                }

                log.info("payloads: ${payloads.length()}, text: ${responseText.length} chars")
                if (responseText.isNotEmpty()) {
                    onResponse?.invoke(responseText)
                }
                pendingRpc.continuation.resume(responseText.ifEmpty { null })
            } else {
                val err = msg.opt("error") ?: "unknown RPC error"
                log.error("agent RPC error: $err")
                onRpcFailure()
                pendingRpc.continuation.resume(null)
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────

    private fun sendJson(payload: JSONObject) {
        webSocket?.send(payload.toString())
    }

    private fun onDisconnect() {
        authenticated = false
        for ((_, rpc) in pending) {
            rpc.timeoutFuture?.cancel(false)
            rpc.continuation.resume(null)
        }
        pending.clear()
        log.info("disconnected")
        onStatusChange?.invoke("disconnected")
    }

    private fun onRpcFailure() {
        val now = System.currentTimeMillis()
        recentFailures.add(now)
        val cutoff = now - circuitWindowMs
        recentFailures.removeAll { it < cutoff }

        if (recentFailures.size >= circuitThreshold && !circuitOpenFlag) {
            circuitOpenFlag = true
            log.warn("circuit breaker opened after ${recentFailures.size} failures, reset in ${circuitResetDelay / 1000}s")

            circuitResetFuture = scheduler.schedule({
                circuitOpenFlag = false
                recentFailures.clear()
                log.info("circuit breaker reset")
                if (!closing) connect()
            }, circuitResetDelay, TimeUnit.MILLISECONDS)

            circuitResetDelay = minOf(circuitResetDelay * 2, maxCircuitReset)
        }
    }

    private fun scheduleReconnect() {
        if (closing || circuitOpenFlag) return
        log.info("reconnecting in ${"%.1f".format(reconnectDelay)}s...")

        reconnectFuture = scheduler.schedule({
            reconnectFuture = null
            connect()
        }, (reconnectDelay * 1000).toLong(), TimeUnit.MILLISECONDS)

        reconnectDelay = minOf(reconnectDelay * 2, maxReconnectDelay)
    }
}
