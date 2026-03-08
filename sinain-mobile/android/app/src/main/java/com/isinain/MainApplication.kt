package com.isinain

import android.app.Application
import android.content.Context
import android.view.WindowManager
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.isinain.bridge.WearablesPackage

/**
 * MIUI Safety Strategy — INPUT_FEATURE_NO_INPUT_CHANNEL (0x0002)
 *
 * MIUI's WindowManagerService force-kills processes that add views with this
 * flag set. Stock Android silently ignores it, but MIUI treats it as a
 * security violation. React Native sets this flag on certain overlay views
 * (DevMenu, RedBox, etc.) which causes immediate process death on MIUI.
 *
 * Protection layers:
 *   Layer 1: WindowManagerGlobal.mParams patch (below) — catches ALL addView
 *            calls by replacing the global params list with a sanitizing wrapper.
 *            Since WindowManagerGlobal.addView() strips the flag from the params
 *            object BEFORE creating ViewRootImpl, the flag is removed before any
 *            IPC to WindowManagerService.
 *   Layer 2: android:forceDarkAllowed=false in theme — prevents MIUI's
 *            ForceDarkHelper from creating overlay views with the flag.
 *
 * REMOVED: WindowManager proxy classes (MiuiSafeContext, MiuiSafeWindowManagerImpl,
 * MiuiSafeWindowManager). These used Kotlin's "WindowManager by delegate" which
 * generates bridge methods for ALL interface methods compiled against API 36.
 * On API 29-33 devices, getMaximumWindowMetrics() (API 30+) either doesn't exist
 * or throws UnsupportedOperationException. This crashes during ReactRootView
 * creation (View → ViewConfiguration.get() → getMaximumWindowMetrics()).
 */
class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(WearablesPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    patchWindowManagerGlobal()
    loadReactNative(this)
  }

  /**
   * Patches WindowManagerGlobal singleton to intercept addView calls globally.
   *
   * Replaces the singleton's internal mParams ArrayList with a sanitizing wrapper
   * that strips INPUT_FEATURE_NO_INPUT_CHANNEL (0x0002) from every LayoutParams
   * added to it. This catches ALL view additions regardless of which WindowManager
   * instance or code path is used.
   *
   * In WindowManagerGlobal.addView():
   *   1. mParams.add(wparams)  ← our wrapper strips the flag HERE
   *   2. root = new ViewRootImpl(...)
   *   3. root.setView(view, wparams, ...)  ← wparams already clean
   *
   * The flag is stripped from the same object reference before setView is called,
   * so the clean params are what gets sent to WindowManagerService via IPC.
   */
  private fun patchWindowManagerGlobal() {
    try {
      val wmgClass = Class.forName("android.view.WindowManagerGlobal")
      val getInstance = wmgClass.getDeclaredMethod("getInstance")
      val wmg = getInstance.invoke(null)

      val paramsField = wmgClass.getDeclaredField("mParams")
      paramsField.isAccessible = true

      @Suppress("UNCHECKED_CAST")
      val originalList = paramsField.get(wmg) as ArrayList<WindowManager.LayoutParams>

      val sanitizingList = object : ArrayList<WindowManager.LayoutParams>(originalList) {
        override fun add(element: WindowManager.LayoutParams): Boolean {
          stripFlag(element)
          return super.add(element)
        }

        override fun add(index: Int, element: WindowManager.LayoutParams) {
          stripFlag(element)
          super.add(index, element)
        }

        override fun set(index: Int, element: WindowManager.LayoutParams): WindowManager.LayoutParams {
          stripFlag(element)
          return super.set(index, element)
        }

        private fun stripFlag(params: WindowManager.LayoutParams) {
          try {
            val field = WindowManager.LayoutParams::class.java.getField("inputFeatures")
            val value = field.getInt(params)
            if (value and 0x0002 != 0) {
              field.setInt(params, value and 0x0002.inv())
            }
          } catch (_: Exception) { }
        }
      }

      paramsField.set(wmg, sanitizingList)
      android.util.Log.i("MainApplication", "WindowManagerGlobal.mParams patched for MIUI safety")
    } catch (e: Exception) {
      android.util.Log.w("MainApplication", "Failed to patch WindowManagerGlobal: ${e.message}")
    }
  }
}
