package com.isinain.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import androidx.lifecycle.LifecycleService
import com.isinain.MainActivity
import com.isinain.pipeline.*
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream

/**
 * HUD Pipeline Foreground Service — the core Android advantage over iOS.
 *
 * This service runs with foregroundServiceType="connectedDevice", which means:
 *   - It persists indefinitely with the screen locked (no iOS-style suspension)
 *   - BLE to glasses stays active through Android Doze
 *   - PARTIAL_WAKE_LOCK keeps the CPU running for frame analysis
 *   - A persistent notification makes battery usage transparent to the user
 *
 * The service owns the full pipeline lifecycle:
 *   FrameProvider → FrameAnalyzer → SceneGate → VisionClient →
 *   ObservationBuilder → GatewayClient → EventEmitter
 *
 * Communication with React Native happens via the WearablesBridge,
 * which binds to this service.
 */
class HudPipelineService : LifecycleService() {

    companion object {
        const val CHANNEL_ID = "isinain_hud_pipeline"
        const val NOTIFICATION_ID = 1
        const val ACTION_START = "com.isinain.ACTION_START_PIPELINE"
        const val ACTION_STOP = "com.isinain.ACTION_STOP_PIPELINE"
    }

    private val log = PipelineLogger("HudService")

    // Binder for local binding (WearablesBridge <-> Service)
    inner class LocalBinder : Binder() {
        val service: HudPipelineService get() = this@HudPipelineService
    }
    private val binder = LocalBinder()

    // Wake lock
    private var wakeLock: PowerManager.WakeLock? = null

    // Pipeline components
    var config: PipelineConfig = PipelineConfig()
        private set
    private var orchestrator: PipelineOrchestrator? = null
    private var gateway: GatewayClient? = null
    var frameProviderImpl: ServiceFrameProvider? = null
        private set

    // Callbacks for bridge communication
    var eventEmitter: EventEmitting? = null
    var watchSync: WatchSyncing? = null

    // ── Service Lifecycle ─────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        log.info("service created")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        when (intent?.action) {
            ACTION_STOP -> {
                log.info("stop action received")
                stopPipeline()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_START, null -> {
                log.info("start action received")
                startForegroundWithNotification()
                acquireWakeLock()
            }
        }

        return START_STICKY
    }

    override fun onBind(intent: Intent): IBinder {
        super.onBind(intent)
        return binder
    }

    override fun onDestroy() {
        log.info("service destroyed")
        stopPipeline()
        releaseWakeLock()
        super.onDestroy()
    }

    // ── Pipeline Control ──────────────────────────────────────

    fun configure(newConfig: PipelineConfig) {
        config = newConfig
        log.info("configured: gateway=${config.gatewayWsUrl} model=${config.visionModel}")

        // Create gateway eagerly (like iOS BUG-2 fix: gateway survives stream stop/start)
        gateway?.close()
        gateway = GatewayClient(
            wsUrl = config.gatewayWsUrl,
            token = config.gatewayToken,
            sessionKey = config.sessionKey
        ).also {
            it.onStatusChange = { status ->
                eventEmitter?.emitPipelineStatus(
                    gatewayStatus = status,
                    rpcStatus = "idle",
                    tick = orchestrator?.let { o -> 0 } ?: 0
                )
            }
            it.start()
        }
    }

    fun startPipeline() {
        if (orchestrator?.isRunning == true) {
            log.info("pipeline already running")
            return
        }

        val emitter = eventEmitter ?: run {
            log.warn("no event emitter, cannot start pipeline")
            return
        }

        val gw = gateway ?: run {
            log.warn("no gateway configured, cannot start pipeline")
            return
        }

        val provider = ServiceFrameProvider()
        frameProviderImpl = provider

        orchestrator = PipelineOrchestrator(
            frameProvider = provider,
            analyzer = FrameAnalyzer(),
            gate = SceneGate(config.sceneGate),
            vision = VisionClient(),
            observation = ObservationBuilder(config.observationMaxEntries, config.observationMaxAgeS),
            gateway = gw,
            eventEmitter = emitter,
            watchSync = watchSync,
            config = config
        )
        orchestrator?.start()
        log.info("pipeline started")
    }

    fun stopPipeline() {
        orchestrator?.stop()
        orchestrator = null
        frameProviderImpl = null
        log.info("pipeline stopped")
    }

    /**
     * Called by WearablesBridge when a new frame arrives from MWDAT glasses.
     * Stores the frame for the pipeline to consume on its next tick.
     */
    fun onFrameReceived(jpegData: ByteArray) {
        frameProviderImpl?.updateFrame(jpegData)
    }

    val isPipelineRunning: Boolean
        get() = orchestrator?.isRunning == true

    // ── Foreground Notification ───────────────────────────────

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "HUD Pipeline",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Sinain HUD pipeline processing"
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun startForegroundWithNotification() {
        val notification = buildNotification("HUD Pipeline active")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingOpen = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, HudPipelineService::class.java).apply {
            action = ACTION_STOP
        }
        val pendingStop = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("ISinain HUD")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(pendingOpen)
            .addAction(Notification.Action.Builder(
                null, "Stop", pendingStop
            ).build())
            .setOngoing(true)
            .build()
    }

    fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    // ── Wake Lock ─────────────────────────────────────────────

    private fun acquireWakeLock() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "ISinain::HudPipeline"
        ).apply {
            acquire()
        }
        log.info("wake lock acquired")
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
        log.info("wake lock released")
    }
}

/**
 * Frame provider implementation for the service.
 * Thread-safe: frames written by MWDAT callback thread, read by pipeline coroutine.
 */
class ServiceFrameProvider : FrameProviding {
    @Volatile private var lastFrame: ByteArray? = null
    @Volatile private var lastFrameTime: Long = 0
    @Volatile override var isStreamActive: Boolean = false
        private set

    private val log = PipelineLogger("FrameProvider")

    fun updateFrame(jpegData: ByteArray) {
        lastFrame = jpegData
        lastFrameTime = System.currentTimeMillis()
        isStreamActive = true
    }

    fun markStreamInactive() {
        isStreamActive = false
    }

    override fun getLastFrameData(): ByteArray? = lastFrame

    override fun getFrameBase64(): String? {
        val data = lastFrame ?: return null
        return Base64.encodeToString(data, Base64.NO_WRAP)
    }

    override fun frameStaleness(): Double {
        if (lastFrameTime == 0L) return Double.MAX_VALUE
        return (System.currentTimeMillis() - lastFrameTime) / 1000.0
    }

    var streamRestartCallback: (() -> Unit)? = null

    override fun requestStreamRestart() {
        val callback = streamRestartCallback
        if (callback != null) {
            log.info("stream restart requested — invoking callback")
            callback()
        } else {
            log.warn("stream restart requested but no callback registered")
        }
    }
}
