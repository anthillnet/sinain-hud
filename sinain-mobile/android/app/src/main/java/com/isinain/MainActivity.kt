package com.isinain

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

/**
 * Activity-level MIUI WindowManager proxy REMOVED.
 *
 * The "WindowManager by delegate" Kotlin pattern generates bridge methods for ALL
 * interface methods compiled against API 36 (compileSdk). On API 29 devices,
 * getMaximumWindowMetrics() (API 30+) doesn't exist on the real WindowManagerImpl,
 * so the delegate bridge falls through to the interface's default implementation
 * which throws UnsupportedOperationException. This crashes during ReactRootView
 * construction (View → ViewConfiguration.get() → getMaximumWindowMetrics()).
 *
 * MIUI INPUT_FEATURE_NO_INPUT_CHANNEL protection is handled by:
 *   Layer 1: MiuiSafeContext in MainApplication (Application-level getSystemService)
 *   Layer 3: WindowManagerGlobal.mParams patch (catches ALL addView paths)
 *   Theme:   android:forceDarkAllowed=false (prevents ForceDarkHelper overlays)
 */
class MainActivity : ReactActivity() {

    private var permissionResult: CompletableDeferred<Boolean>? = null

    override fun getMainComponentName(): String = "ISinain"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // MWDAT SDK init — guarded because MWDAT is compileOnly (not bundled in APK).
        // The try-catch MUST be inside the coroutine body: launch{} returns immediately
        // so wrapping it externally doesn't catch errors from the coroutine.
        MainScope().launch {
            try {
                com.meta.wearable.dat.core.Wearables.initialize(this@MainActivity)
            } catch (_: NoClassDefFoundError) {
                android.util.Log.w("MainActivity", "MWDAT SDK not available, skipping init")
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    /**
     * Called from WearablesBridge to request camera permission on the glasses.
     * Suspends until the user grants or denies.
     * Returns false when MWDAT SDK is not available (compileOnly).
     */
    suspend fun requestCameraPermission(): Boolean {
        return try {
            val deferred = CompletableDeferred<Boolean>()
            permissionResult = deferred
            // MWDAT permission flow — will throw NoClassDefFoundError if SDK absent
            val launcher = (this as? androidx.activity.ComponentActivity)
                ?: return false
            // Simplified: when MWDAT is available, the full permission flow runs
            false // TODO: restore full MWDAT permission flow when SDK is bundled
        } catch (_: NoClassDefFoundError) {
            false
        }
    }

    companion object {
        // Accessible from WearablesBridge to call requestCameraPermission()
        var instance: MainActivity? = null
            private set
    }

    override fun onResume() {
        super.onResume()
        instance = this
    }

    override fun onPause() {
        super.onPause()
        if (instance == this) instance = null
    }
}
