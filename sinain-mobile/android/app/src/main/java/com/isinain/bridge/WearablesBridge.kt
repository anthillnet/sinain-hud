package com.isinain.bridge

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.isinain.pipeline.*
import com.isinain.service.HudPipelineService
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

/**
 * React Native bridge for MWDAT glasses + HUD pipeline.
 *
 * IMPORTANT: This class must have ZERO direct references to MWDAT SDK types
 * (no imports, no field types, no method parameter/return types). The TurboModule
 * system calls Class.getDeclaredMethods() which resolves ALL types in the class's
 * constant pool. Since MWDAT is compileOnly, any reference would cause
 * NoClassDefFoundError during class introspection.
 *
 * All MWDAT interactions are delegated to MwdatHelper, which is loaded on demand
 * via try-catch(NoClassDefFoundError).
 *
 * JS API:
 *   configure(config)          — configure pipeline + start gateway
 *   startRegistration()        — initiate BLE pairing with glasses
 *   startStream(config)        — start camera stream from glasses
 *   stopStream()               — stop stream (gateway persists)
 *   capturePhoto()             — return current frame as high-quality JPEG
 *   getState()                 — return {connection, stream}
 *
 * Events emitted to JS:
 *   onFrame          — {uri, width, height, fps, timestamp}
 *   onState          — {connection, stream}
 *   onError          — {code, message}
 *   onPipelineResponse — {text, tick, isStreaming, timestamp}
 *   onPipelineStatus   — {gatewayStatus, rpcStatus, tick}
 */
class WearablesBridge(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext),
    EventEmitting {

    override fun getName() = "WearablesBridge"

    private val log = PipelineLogger("WearablesBridge")
    internal val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Service binding
    private var service: HudPipelineService? = null
    private var serviceBound = false

    // Stream state
    private var connectionState = "idle"
    private var streamState = "stopped"

    // Frame tracking
    @Volatile private var lastFrameData: ByteArray? = null
    private var frameCount = 0
    private var fpsWindowStart = 0L
    private var fpsFrameCount = 0

    // MWDAT helper — loaded on demand, null if SDK absent.
    // The outer try-catch is REQUIRED: on ART, calling MwdatHelper.create() triggers
    // class loading of MwdatHelper, which resolves MWDAT SDK types in its constant pool.
    // If MWDAT is compileOnly (absent at runtime), class loading fails with
    // NoClassDefFoundError BEFORE the try-catch inside create() can execute.
    private val mwdatHelper: MwdatHelper? = try {
        MwdatHelper.create(reactContext, scope, this)
    } catch (e: NoClassDefFoundError) {
        log.info("MWDAT SDK not available: ${e.message}")
        null
    } catch (e: Throwable) {
        log.error("MwdatHelper init failed: ${e.message}")
        null
    }
    private val mwdatAvailable = mwdatHelper != null

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val localBinder = binder as HudPipelineService.LocalBinder
            service = localBinder.service
            service?.eventEmitter = this@WearablesBridge
            serviceBound = true
            log.info("bound to HudPipelineService")
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            serviceBound = false
            log.warn("disconnected from HudPipelineService")
        }
    }

    init {
        log.info("WearablesBridge init: mwdatAvailable=$mwdatAvailable")
        try {
            val intent = Intent(reactContext, HudPipelineService::class.java)
            reactContext.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        } catch (e: Exception) {
            log.error("failed to bind HudPipelineService", e)
        }
    }

    override fun invalidate() {
        mwdatHelper?.invalidate()
        scope.cancel()
        if (serviceBound) {
            reactApplicationContext.unbindService(serviceConnection)
            serviceBound = false
        }
        super.invalidate()
    }

    // ── JS API ────────────────────────────────────────────────

    @ReactMethod
    fun configure(configMap: ReadableMap, promise: Promise) {
        try {
            val config = PipelineConfig.fromReadableMap(configMap)
            log.info("configure: token=${if (config.gatewayToken.isNotEmpty()) "present" else "EMPTY"}")

            val intent = Intent(reactApplicationContext, HudPipelineService::class.java).apply {
                action = HudPipelineService.ACTION_START
            }
            reactApplicationContext.startForegroundService(intent)

            scope.launch {
                var attempts = 0
                while (service == null && attempts < 20) {
                    delay(100)
                    attempts++
                }

                service?.configure(config)
                    ?: log.warn("service not available for configure")

                promise.resolve(null)
            }
        } catch (e: Exception) {
            log.error("configure failed", e)
            promise.reject("CONFIGURE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun startRegistration(promise: Promise) {
        if (!mwdatAvailable) {
            promise.reject("MWDAT_UNAVAILABLE", "MWDAT SDK is not bundled (compileOnly)")
            return
        }
        log.info("startRegistration called")
        updateState("registering", streamState)

        scope.launch {
            try {
                mwdatHelper!!.startRegistration()
                promise.resolve(null)
            } catch (e: Exception) {
                log.error("startRegistration failed", e)
                updateState("idle", streamState)
                emitError("REGISTRATION_ERROR", e.message ?: "Registration failed")
                promise.reject("REGISTRATION_ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun startStream(config: ReadableMap, promise: Promise) {
        if (!mwdatAvailable) {
            promise.reject("MWDAT_UNAVAILABLE", "MWDAT SDK is not bundled (compileOnly)")
            return
        }
        log.info("startStream called")
        updateState(connectionState, "starting")

        scope.launch {
            try {
                val resolution = config.getString("resolution") ?: "720p"
                val frameRate = if (config.hasKey("frameRate")) config.getInt("frameRate") else 5
                mwdatHelper!!.startStream(resolution, frameRate)
                promise.resolve(null)
            } catch (e: SecurityException) {
                updateState(connectionState, "error")
                emitError("PERMISSION_DENIED", e.message ?: "Camera permission denied")
                promise.reject("PERMISSION_DENIED", e.message)
            } catch (e: Exception) {
                log.error("startStream failed", e)
                updateState(connectionState, "error")
                emitError("STREAM_ERROR", e.message ?: "Failed to start stream")
                promise.reject("STREAM_ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun stopStream(promise: Promise) {
        log.info("stopStream called")

        // Stop pipeline but NOT gateway (BUG-2 fix from iOS)
        service?.stopPipeline()

        mwdatHelper?.stopStream()

        updateState(connectionState, "stopped")
        lastFrameData = null
        promise.resolve(null)
    }

    @ReactMethod
    fun capturePhoto(promise: Promise) {
        val data = lastFrameData
        if (data == null) {
            promise.reject("NO_FRAME", "No frame available")
            return
        }

        scope.launch(Dispatchers.IO) {
            try {
                val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size)
                    ?: return@launch promise.reject("DECODE_ERROR", "Failed to decode frame")

                val outputStream = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 92, outputStream)
                val highQualityData = outputStream.toByteArray()

                val tempFile = File(reactApplicationContext.cacheDir, "capture_${System.currentTimeMillis()}.jpg")
                FileOutputStream(tempFile).use { it.write(highQualityData) }

                val result = Arguments.createMap().apply {
                    putString("uri", "file://${tempFile.absolutePath}")
                    putInt("width", bitmap.width)
                    putInt("height", bitmap.height)
                }

                bitmap.recycle()
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("CAPTURE_ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun getState(promise: Promise) {
        val result = Arguments.createMap().apply {
            putString("connection", connectionState)
            putString("stream", streamState)
        }
        promise.resolve(result)
    }

    // ── Callbacks from MwdatHelper ────────────────────────────

    /** Called by MwdatHelper when stream state changes. */
    internal fun onStreamStateChanged(stateName: String) {
        when (stateName) {
            "STREAMING" -> {
                updateState("connected", "streaming")
                service?.startPipeline()
                    ?: log.warn("service not available for pipeline start")
            }
            "CONNECTING" -> updateState("connected", "starting")
            "DISCONNECTED" -> updateState(connectionState, "stopped")
            else -> updateState(connectionState, stateName.lowercase())
        }
    }

    /** Called by MwdatHelper to update connection state. */
    internal fun updateStateFromNative(connection: String) {
        updateState(connection, streamState)
    }

    /** Called by MwdatHelper to emit errors. */
    internal fun emitErrorFromNative(code: String, message: String) {
        emitError(code, message)
    }

    /** Expose current activity for MwdatHelper. */
    internal val currentActivity get() = reactApplicationContext.currentActivity

    /** Expose service for MwdatHelper stream restart wiring. */
    internal fun getServiceForMwdat() = service

    // ── MWDAT Frame Callback ──────────────────────────────────

    /**
     * Called when a frame arrives from MWDAT glasses.
     * Invoked from MwdatHelper after I420→NV21→JPEG conversion.
     */
    fun onMwdatFrame(jpegData: ByteArray, width: Int, height: Int) {
        lastFrameData = jpegData

        // Forward to service for pipeline processing
        service?.onFrameReceived(jpegData)

        // FPS tracking — emit once per second to avoid overwhelming JS bridge
        val now = System.currentTimeMillis()
        fpsFrameCount++
        if (now - fpsWindowStart >= 1000) {
            val fps = fpsFrameCount.toFloat()
            fpsWindowStart = now
            fpsFrameCount = 0

            scope.launch(Dispatchers.IO) {
                try {
                    val tempFile = File(reactApplicationContext.cacheDir, "frame_latest.jpg")
                    FileOutputStream(tempFile).use { it.write(jpegData) }

                    val params = Arguments.createMap().apply {
                        putString("uri", "file://${tempFile.absolutePath}")
                        putInt("width", width)
                        putInt("height", height)
                        putDouble("fps", fps.toDouble())
                        putDouble("timestamp", now.toDouble())
                    }
                    sendEvent("onFrame", params)
                } catch (e: Exception) {
                    log.error("failed to write frame: ${e.message}")
                }
            }
        }
    }

    // ── EventEmitting (pipeline → JS) ─────────────────────────

    override fun emitPipelineResponse(text: String, tick: Int, isStreaming: Boolean) {
        val params = Arguments.createMap().apply {
            putString("text", text)
            putInt("tick", tick)
            putBoolean("isStreaming", isStreaming)
            putDouble("timestamp", System.currentTimeMillis().toDouble())
        }
        sendEvent("onPipelineResponse", params)
    }

    override fun emitPipelineStatus(gatewayStatus: String, rpcStatus: String, tick: Int) {
        val params = Arguments.createMap().apply {
            putString("gatewayStatus", gatewayStatus)
            putString("rpcStatus", rpcStatus)
            putInt("tick", tick)
        }
        sendEvent("onPipelineStatus", params)
    }

    // ── Private Helpers ───────────────────────────────────────

    private fun updateState(connection: String, stream: String) {
        connectionState = connection
        streamState = stream
        val params = Arguments.createMap().apply {
            putString("connection", connection)
            putString("stream", stream)
        }
        sendEvent("onState", params)
    }

    private fun emitError(code: String, message: String) {
        val params = Arguments.createMap().apply {
            putString("code", code)
            putString("message", message)
        }
        sendEvent("onError", params)
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(eventName, params)
    }
}
