package com.isinain.bridge

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import com.isinain.MainActivity
import com.isinain.pipeline.PipelineLogger
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.camera.startStreamSession
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.VideoQuality
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import java.io.ByteArrayOutputStream

/**
 * Isolates all MWDAT SDK interactions into a separate class.
 *
 * This class is loaded ONLY when MWDAT SDK is actually present at runtime.
 * WearablesBridge must never reference this class's type directly — only via
 * try-catch(NoClassDefFoundError) or through the MwdatHelper.create() factory.
 *
 * Why: React Native's TurboModule system calls Class.getDeclaredMethods() on
 * bridge modules, which resolves ALL types in the class's constant pool.
 * If WearablesBridge had MWDAT types in field declarations or method signatures,
 * the class would fail to load when MWDAT is compileOnly.
 */
class MwdatHelper(
    private val context: Context,
    private val scope: CoroutineScope,
    private val bridge: WearablesBridge
) {
    private val log = PipelineLogger("MwdatHelper")
    private val deviceSelector = AutoDeviceSelector()

    var deviceMonitorJob: Job? = null
    var frameCollectorJob: Job? = null
    var stateMonitorJob: Job? = null

    // Stored as Any? in WearablesBridge, but actually StreamSession
    private var streamSession: com.meta.wearable.dat.camera.StreamSession? = null
    private var lastStreamConfig: StreamConfiguration? = null

    suspend fun startRegistration() {
        val activity = bridge.currentActivity
            ?: throw IllegalStateException("No activity available for registration")

        Wearables.startRegistration(activity)

        val result = withTimeoutOrNull(60_000) {
            Wearables.registrationState.first { it is RegistrationState.Registered }
        }

        if (result != null) {
            bridge.updateStateFromNative("registered")
            log.info("registration completed")

            deviceMonitorJob?.cancel()
            deviceMonitorJob = scope.launch {
                deviceSelector.activeDevice(Wearables.devices).collect { device ->
                    if (device != null) {
                        log.info("device connected: ${device.identifier}")
                        bridge.updateStateFromNative("registered")
                    } else {
                        log.warn("device disconnected")
                        bridge.updateStateFromNative("disconnected")
                    }
                }
            }
        } else {
            bridge.updateStateFromNative("idle")
            throw IllegalStateException("Registration timed out after 60s")
        }
    }

    suspend fun startStream(resolution: String, frameRate: Int) {
        // Check camera permission on the glasses
        val permResult = Wearables.checkPermissionStatus(Permission.CAMERA)
        val permStatus = permResult.getOrNull()
        if (permStatus !is PermissionStatus.Granted) {
            log.info("camera permission not granted, requesting...")
            val activity = MainActivity.instance
                ?: throw IllegalStateException("No activity available for permission request")
            val granted = activity.requestCameraPermission()
            if (!granted) {
                throw SecurityException("Camera permission denied on glasses")
            }
        }

        val videoQuality = when (resolution) {
            "1080p" -> VideoQuality.HIGH
            "720p" -> VideoQuality.MEDIUM
            "480p" -> VideoQuality.LOW
            else -> VideoQuality.MEDIUM
        }
        val streamConfig = StreamConfiguration(videoQuality, frameRate)
        lastStreamConfig = streamConfig

        val session = Wearables.startStreamSession(
            context,
            deviceSelector,
            streamConfig
        )
        streamSession = session

        // Wire stream restart callback
        bridge.getServiceForMwdat()?.let { svc ->
            svc.frameProviderImpl?.streamRestartCallback = {
                scope.launch { restartStream() }
            }
        }

        // Monitor stream state
        stateMonitorJob?.cancel()
        stateMonitorJob = scope.launch {
            session.state.collect { state ->
                log.info("stream state: $state")
                bridge.onStreamStateChanged(state.name)
            }
        }

        // Collect video frames
        frameCollectorJob?.cancel()
        frameCollectorJob = scope.launch(Dispatchers.Default) {
            session.videoStream.collect { frame ->
                try {
                    val frameBytes = ByteArray(frame.buffer.remaining())
                    frame.buffer.get(frameBytes)
                    frame.buffer.rewind()
                    val nv21 = convertI420toNV21(frameBytes, frame.width, frame.height)
                    val yuvImage = YuvImage(nv21, ImageFormat.NV21, frame.width, frame.height, null)
                    val out = ByteArrayOutputStream()
                    yuvImage.compressToJpeg(Rect(0, 0, frame.width, frame.height), 75, out)
                    bridge.onMwdatFrame(out.toByteArray(), frame.width, frame.height)
                } catch (e: Exception) {
                    log.error("frame conversion failed: ${e.message}")
                }
            }
        }
    }

    fun stopStream() {
        frameCollectorJob?.cancel()
        frameCollectorJob = null
        stateMonitorJob?.cancel()
        stateMonitorJob = null
        streamSession?.close()
        streamSession = null
    }

    fun invalidate() {
        deviceMonitorJob?.cancel()
        frameCollectorJob?.cancel()
        stateMonitorJob?.cancel()
        streamSession?.close()
        streamSession = null
    }

    private suspend fun restartStream() {
        log.info("restarting stream session")
        val config = lastStreamConfig ?: run {
            log.warn("no stream config stored, cannot restart")
            return
        }
        try {
            frameCollectorJob?.cancel()
            stateMonitorJob?.cancel()
            streamSession?.close()
            streamSession = null

            delay(500)

            val session = Wearables.startStreamSession(
                context,
                deviceSelector,
                config
            )
            streamSession = session

            stateMonitorJob = scope.launch {
                session.state.collect { state ->
                    log.info("stream state (restart): $state")
                    bridge.onStreamStateChanged(state.name)
                }
            }

            frameCollectorJob = scope.launch(Dispatchers.Default) {
                session.videoStream.collect { frame ->
                    try {
                        val frameBytes = ByteArray(frame.buffer.remaining())
                        frame.buffer.get(frameBytes)
                        frame.buffer.rewind()
                        val nv21 = convertI420toNV21(frameBytes, frame.width, frame.height)
                        val yuvImage = YuvImage(nv21, ImageFormat.NV21, frame.width, frame.height, null)
                        val out = ByteArrayOutputStream()
                        yuvImage.compressToJpeg(Rect(0, 0, frame.width, frame.height), 75, out)
                        bridge.onMwdatFrame(out.toByteArray(), frame.width, frame.height)
                    } catch (e: Exception) {
                        log.error("frame conversion failed (restart): ${e.message}")
                    }
                }
            }
        } catch (e: Exception) {
            log.error("stream restart failed: ${e.message}")
            bridge.emitErrorFromNative("RESTART_ERROR", e.message ?: "Stream restart failed")
        }
    }

    private fun convertI420toNV21(input: ByteArray, width: Int, height: Int): ByteArray {
        val output = ByteArray(input.size)
        val size = width * height
        val quarter = size / 4
        input.copyInto(output, 0, 0, size)
        for (n in 0 until quarter) {
            output[size + n * 2] = input[size + quarter + n]     // V
            output[size + n * 2 + 1] = input[size + n]           // U
        }
        return output
    }

    companion object {
        /** Returns null if MWDAT SDK is not available (compileOnly). */
        fun create(context: Context, scope: CoroutineScope, bridge: WearablesBridge): MwdatHelper? {
            return try {
                MwdatHelper(context, scope, bridge)
            } catch (_: NoClassDefFoundError) {
                null
            }
        }
    }
}
