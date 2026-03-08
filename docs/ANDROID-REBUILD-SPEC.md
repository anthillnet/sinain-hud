# sinain-mobile Android Rebuild: Comprehensive Technical Specification

## Document Purpose

This specification contains every detail needed to rebuild the sinain-mobile Android application from `npx react-native init` to a working APK on a Xiaomi MIUI device. It is organized in implementation order -- a developer should be able to follow it top-to-bottom. Every hard-won lesson from the original build is documented in place, at the exact point where it matters.

---

## Table of Contents

1. [System Requirements and Prerequisites](#1-system-requirements-and-prerequisites)
2. [Project Initialization](#2-project-initialization)
3. [Android Build Configuration](#3-android-build-configuration)
4. [MIUI Compatibility Layer](#4-miui-compatibility-layer)
5. [Pipeline Architecture](#5-pipeline-architecture)
6. [ForegroundService Design](#6-foregroundservice-design)
7. [React Native Bridge](#7-react-native-bridge)
8. [JavaScript Layer](#8-javascript-layer)
9. [MWDAT SDK Integration](#9-mwdat-sdk-integration)
10. [Testing and Deployment](#10-testing-and-deployment)
11. [Known Issues and Workarounds](#11-known-issues-and-workarounds)

---

## 1. System Requirements and Prerequisites

### Development Machine

| Requirement | Value | Notes |
|---|---|---|
| Node.js | >= 22.11.0 | Required by RN 0.84 |
| JDK | Temurin 17 | AGP requires JDK 17. Set `org.gradle.java.home` in `gradle.properties` |
| Android SDK | API 36 (compile), API 29 (min) | Install via Android Studio SDK Manager |
| NDK | 27.1.12297006 | Must match exactly |
| Build Tools | 36.0.0 | |
| Kotlin | 2.1.20 | Set in root `build.gradle` `ext.kotlinVersion` |

### Target Device

- **Xiaomi Mi 10T Pro** -- Android 10 (API 29), MIUI
- **Meta Ray-Ban** glasses (connected via Bluetooth/MWDAT SDK)

### Credentials Required

| Key | Where to Set | Purpose |
|---|---|---|
| `OPENCLAW_TOKEN` | `.env` | OpenClaw gateway authentication |
| `OPENROUTER_API_KEY` | `.env` | OpenRouter vision API (Gemini Flash) |
| `GATEWAY_WS_URL` | `.env` (optional) | Override default `wss://<your-domain>` |
| `github_token` | `~/.gradle/gradle.properties` | MWDAT GitHub Packages access |

---

## 2. Project Initialization

### Step 2.1: Create React Native Project

```bash
npx react-native@0.84.0 init ISinain --version 0.84.0
cd ISinain
```

This produces the scaffold. The `app.json` must contain:
```json
{"name": "ISinain", "displayName": "ISinain"}
```

### Step 2.2: Install JS Dependencies

The `package.json` dependencies (beyond the RN defaults):

```json
{
  "dependencies": {
    "react": "19.2.3",
    "react-native": "0.84.0",
    "@react-native/new-app-screen": "0.84.0",
    "react-native-safe-area-context": "^5.5.2"
  },
  "devDependencies": {
    "react-native-dotenv": "^3.4.11"
  }
}
```

Run `npm install`.

### Step 2.3: Configure Babel for .env

File: `babel.config.js`

```javascript
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    ['module:react-native-dotenv', {
      envName: 'APP_ENV',
      moduleName: '@env',
      path: '.env',
      safe: false,
      allowUndefined: true,
    }],
  ],
};
```

### Step 2.4: Create .env and Type Declaration

File: `.env.example`
```
OPENCLAW_TOKEN=
OPENROUTER_API_KEY=
GATEWAY_WS_URL=
```

File: `src/pipeline/env.d.ts`
```typescript
declare module '@env' {
  export const OPENCLAW_TOKEN: string;
  export const OPENROUTER_API_KEY: string;
  export const GATEWAY_WS_URL: string;
}
```

### Step 2.5: Directory Structure

```
ISinain/
  android/
    app/
      src/main/
        java/com/isinain/
          pipeline/           # 9 files: Models, PipelineConfig, PipelineLogger,
                              #          FrameAnalyzer, SceneGate, VisionClient,
                              #          GatewayClient, ObservationBuilder,
                              #          PipelineOrchestrator
          service/            # 1 file: HudPipelineService (+ ServiceFrameProvider)
          bridge/             # 2 files: WearablesBridge, WearablesPackage
          MainActivity.kt     # Activity + MiuiSafeWindowManager
          MainApplication.kt  # Application + MiuiSafeContext + WindowManagerGlobal patch
        res/
          values/
            styles.xml        # AppTheme with forceDarkAllowed=false
            strings.xml       # app_name = "ISinain"
          drawable/
            rn_edit_text_material.xml
        AndroidManifest.xml
      build.gradle            # App-level
      proguard-rules.pro
      debug.keystore
    build.gradle              # Root-level
    settings.gradle
    gradle.properties
  src/
    App.tsx                   # Root component
    types.ts                  # All TS interfaces
    pipeline/
      config.ts               # Reads .env, produces PipelineConfig
      env.d.ts
    hooks/
      useWearables.ts          # Device connection + frame events
      usePipeline.ts           # Pipeline response + status events
      useWatchSync.ts          # Watch sync (debounced)
    components/
      StatusHeader.tsx
      CameraPreview.tsx
      Controls.tsx
      ResponseFeed.tsx
  index.js
  .env
  .env.example
  babel.config.js
  metro.config.js
  tsconfig.json
  package.json
```

---

## 3. Android Build Configuration

### Step 3.1: Root build.gradle

File: `android/build.gradle`

Critical points:
- `minSdkVersion = 29` -- **NOT 31**. Xiaomi Mi 10T Pro is API 29. MIUI gives a misleading "Invalid apk" error if minSdk is too high, rather than a proper version mismatch message.
- `compileSdkVersion = 36`, `targetSdkVersion = 36`
- `kotlinVersion = "2.1.20"`
- MWDAT GitHub Packages repository with `github_token` from gradle properties or `GITHUB_TOKEN` env var

```groovy
buildscript {
    ext {
        buildToolsVersion = "36.0.0"
        minSdkVersion = 29
        compileSdkVersion = 36
        targetSdkVersion = 36
        ndkVersion = "27.1.12297006"
        kotlinVersion = "2.1.20"
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle")
        classpath("com.facebook.react:react-native-gradle-plugin")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("https://maven.pkg.github.com/facebook/meta-wearables-dat-android")
            credentials {
                username = ""
                password = providers.gradleProperty("github_token")
                    .orElse(providers.environmentVariable("GITHUB_TOKEN"))
                    .getOrElse("")
            }
        }
    }
}

apply plugin: "com.facebook.react.rootproject"
```

### Step 3.2: settings.gradle

File: `android/settings.gradle`

Must also include the MWDAT Maven repository in `dependencyResolutionManagement` -- Gradle's `allprojects.repositories` block in `build.gradle` does not apply to settings-level dependency resolution.

```groovy
pluginManagement { includeBuild("../node_modules/@react-native/gradle-plugin") }
plugins { id("com.facebook.react.settings") }
extensions.configure(com.facebook.react.ReactSettingsExtension){ ex -> ex.autolinkLibrariesFromCommand() }

dependencyResolutionManagement {
    repositories {
        maven {
            url = uri("https://maven.pkg.github.com/facebook/meta-wearables-dat-android")
            credentials {
                username = ""
                password = providers.gradleProperty("github_token")
                    .orElse(providers.environmentVariable("GITHUB_TOKEN"))
                    .getOrElse("")
            }
        }
    }
}

rootProject.name = 'ISinain'
include ':app'
includeBuild('../node_modules/@react-native/gradle-plugin')
```

### Step 3.3: gradle.properties

File: `android/gradle.properties`

```properties
org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m
android.useAndroidX=true
reactNativeArchitectures=arm64-v8a
newArchEnabled=false
hermesEnabled=true
edgeToEdgeEnabled=false

# Force JDK 17 -- MUST point to your local JDK 17 installation
org.gradle.java.home=/path/to/temurin-17/Contents/Home
```

**CRITICAL**: `newArchEnabled=false` -- the New Architecture causes issues with MIUI. `reactNativeArchitectures=arm64-v8a` -- the target device is arm64 only, no need to build x86 or armv7.

### Step 3.4: App-level build.gradle

File: `android/app/build.gradle`

```groovy
apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

react {
    autolinkLibrariesWithApp()
}

def enableProguardInReleaseBuilds = false
def jscFlavor = 'io.github.react-native-community:jsc-android:2026004.+'

android {
    ndkVersion rootProject.ext.ndkVersion
    buildToolsVersion rootProject.ext.buildToolsVersion
    compileSdk rootProject.ext.compileSdkVersion

    namespace "com.isinain"
    defaultConfig {
        applicationId "com.isinain"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }

    buildFeatures { buildConfig true }

    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled enableProguardInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
    }
}

dependencies {
    implementation("com.facebook.react:react-android")

    if (hermesEnabled.toBoolean()) {
        implementation("com.facebook.react:hermes-android")
    } else {
        implementation jscFlavor
    }

    // Kotlin coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Lifecycle (LifecycleService for ForegroundService)
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")

    // OkHttp (HTTP + WebSocket)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // ML Kit Text Recognition
    implementation("com.google.mlkit:text-recognition:16.0.1")

    // MWDAT SDK -- compileOnly to avoid fat-AAR dex-merge conflicts
    compileOnly("com.meta.wearable:mwdat-core:0.4.0")
    compileOnly("com.meta.wearable:mwdat-camera:0.4.0")

    // JSON parsing
    implementation("org.json:json:20231013")
}
```

**CRITICAL -- MWDAT as `compileOnly`**: The MWDAT SDK packages (`mwdat-core`, `mwdat-camera`) are fat-AARs that bundle partial copies of Facebook libraries (`fbjni`, `fbcore`). These CONFLICT with React Native's transitive dependencies at dex-merge time. Using `compileOnly` means the SDK classes are available at compile time but NOT in the APK. All SDK calls MUST be wrapped in `try-catch(NoClassDefFoundError)`. See Section 9 for the full strategy.

### Step 3.5: AndroidManifest.xml

File: `android/app/src/main/AndroidManifest.xml`

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- Network -->
    <uses-permission android:name="android.permission.INTERNET" />

    <!-- Bluetooth for MWDAT glasses -->
    <uses-permission android:name="android.permission.BLUETOOTH" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />

    <!-- Foreground service -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <!-- Bypass Doze -->
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

    <!-- Notifications (Android 13+) -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <application
      android:name=".MainApplication"
      android:label="@string/app_name"
      android:icon="@mipmap/ic_launcher"
      android:roundIcon="@mipmap/ic_launcher_round"
      android:allowBackup="false"
      android:theme="@style/AppTheme"
      android:usesCleartextTraffic="${usesCleartextTraffic}"
      android:supportsRtl="true">

      <!-- MWDAT metadata -->
      <meta-data android:name="com.meta.wearable.mwdat.APPLICATION_ID"
                 android:value="com.isinain" />
      <meta-data android:name="com.meta.wearable.mwdat.ANALYTICS_OPT_OUT"
                 android:value="true" />

      <activity
        android:name=".MainActivity"
        android:label="@string/app_name"
        android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"
        android:launchMode="singleTask"
        android:windowSoftInputMode="adjustResize"
        android:exported="true">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="isinain" />
        </intent-filter>
      </activity>

      <!-- foregroundServiceType MUST be connectedDevice -->
      <service
        android:name=".service.HudPipelineService"
        android:foregroundServiceType="connectedDevice"
        android:exported="false" />

    </application>
</manifest>
```

**Key decisions**:
- `foregroundServiceType="connectedDevice"` -- NOT "camera" or "mediaProjection". The pipeline connects to external glasses via BLE, which maps to `connectedDevice`. Using `camera` would require camera hardware permission and is semantically wrong; `mediaProjection` requires user consent dialog.
- `FOREGROUND_SERVICE_CONNECTED_DEVICE` permission -- required on API 34+ for `connectedDevice` type.
- Deep link scheme `isinain://` registered for potential future use.

### Step 3.6: styles.xml

File: `android/app/src/main/res/values/styles.xml`

```xml
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="android:editTextBackground">@drawable/rn_edit_text_material</item>
        <!-- CRITICAL: Disable forced dark mode. MIUI's ForceDarkHelper creates
             overlay views with INPUT_FEATURE_NO_INPUT_CHANNEL flag, which MIUI's
             WindowManagerService then force-kills the process for. -->
        <item name="android:forceDarkAllowed">false</item>
    </style>
</resources>
```

---

## 4. MIUI Compatibility Layer

This is the most hard-won section of the entire spec. MIUI (Xiaomi's Android skin) has a modified WindowManagerService that **force-kills** any process that adds a view with the `INPUT_FEATURE_NO_INPUT_CHANNEL` flag (0x0002) set on `WindowManager.LayoutParams.inputFeatures`. Stock Android silently ignores this flag. React Native sets it on overlay views (DevMenu, RedBox, error dialogs).

**Three layers of defense are required because views can be added through different code paths:**

### Layer 1: MiuiSafeContext (Application level)

File: `android/app/src/main/java/com/isinain/MainApplication.kt`

This ContextWrapper intercepts `getSystemService(WINDOW_SERVICE)` at the Application level, returning a proxy WindowManager that strips the flag. It catches calls from any code that obtains a WindowManager through the Application context.

```kotlin
private class MiuiSafeContext(base: Context) : ContextWrapper(base) {
    private val safeWm by lazy {
        MiuiSafeWindowManagerImpl(
            baseContext.getSystemService(WINDOW_SERVICE) as WindowManager
        )
    }

    override fun getSystemService(name: String): Any? {
        if (name == WINDOW_SERVICE) return safeWm
        return super.getSystemService(name)
    }

    override fun getApplicationContext(): Context {
        val appCtx = super.getApplicationContext()
        return if (appCtx is MiuiSafeContext) appCtx else MiuiSafeContext(appCtx)
    }
}
```

The proxy WindowManager implementation:

```kotlin
private class MiuiSafeWindowManagerImpl(
    private val delegate: WindowManager
) : WindowManager by delegate {

    private fun stripInputFeature(params: ViewGroup.LayoutParams) {
        if (params is WindowManager.LayoutParams) {
            try {
                val field = WindowManager.LayoutParams::class.java.getField("inputFeatures")
                val value = field.getInt(params)
                if (value and 0x0002 != 0) {
                    field.setInt(params, value and 0x0002.inv())
                }
            } catch (_: Exception) { }
        }
    }

    override fun addView(view: View, params: ViewGroup.LayoutParams) {
        stripInputFeature(params)
        delegate.addView(view, params)
    }

    override fun updateViewLayout(view: View, params: ViewGroup.LayoutParams) {
        stripInputFeature(params)
        delegate.updateViewLayout(view, params)
    }
}
```

Installed in `MainApplication.attachBaseContext()`:

```kotlin
override fun attachBaseContext(base: Context) {
    super.attachBaseContext(MiuiSafeContext(base))
}
```

### Layer 2: MiuiSafeWindowManager (Activity level)

File: `android/app/src/main/java/com/isinain/MainActivity.kt`

Same proxy pattern but applied to the Activity's WindowManager. This catches calls that go through `Activity.getWindowManager()` directly rather than through the Context.

```kotlin
class MainActivity : ReactActivity() {
    private var miuiSafeWm: MiuiSafeWindowManager? = null

    override fun getWindowManager(): WindowManager {
        if (miuiSafeWm == null) {
            miuiSafeWm = MiuiSafeWindowManager(super.getWindowManager())
        }
        return miuiSafeWm!!
    }

    override fun getSystemService(name: String): Any? {
        if (name == Context.WINDOW_SERVICE) return windowManager
        return super.getSystemService(name)
    }
}
```

### Layer 3: WindowManagerGlobal.mParams Patch (Reflection)

File: `android/app/src/main/java/com/isinain/MainApplication.kt`

This is the nuclear option. Some code paths bypass both Context and Activity to call `WindowManagerGlobal.addView()` directly. The patch uses reflection to replace the singleton's internal `mParams` ArrayList with a sanitizing wrapper that strips the flag from every LayoutParams added to it.

```kotlin
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
    } catch (e: Exception) {
        Log.w("MainApplication", "Failed to patch WindowManagerGlobal: ${e.message}")
    }
}
```

Called in `MainApplication.onCreate()` before `loadReactNative()`.

### Why All Three Layers?

| Code path | Which layer catches it |
|---|---|
| `context.getSystemService(WINDOW_SERVICE)` | Layer 1 (MiuiSafeContext) |
| `activity.getWindowManager()` | Layer 2 (MiuiSafeWindowManager) |
| `WindowManagerGlobal.addView()` via cached WindowManagerImpl | Layer 3 (mParams patch) |
| MIUI ForceDarkHelper overlay views | `forceDarkAllowed=false` in theme |

---

## 5. Pipeline Architecture

The pipeline is 9 Kotlin files (~1,500 lines) in `com.isinain.pipeline/`. It is a dependency-injected chain of interfaces, making each component independently testable.

### 5.1: Data Flow Overview

```
                                 Every 4 seconds
                                      |
                                      v
  MWDAT Glasses -(BLE)-> ServiceFrameProvider
                                      |
                                      v
                              PipelineOrchestrator
                                  |        |
                          FrameAnalyzer    |
                          (blur, brightness,|
                           dHash, ML Kit)  |
                                  |        |
                                  v        |
                              SceneGate    |
                          (classify frame) |
                                  |        |
                          DROP? -(yes)-> skip
                                  |
                                  v (SCENE/TEXT/MOTION/AMBIENT)
                              VisionClient
                          (Gemini Flash via OpenRouter)
                                  |
                                  v
                          ObservationBuilder
                          (circular buffer + markdown)
                                  |
                                  v
                           GatewayClient
                          (WebSocket RPC to OpenClaw)
                                  |
                                  v
                          EventEmitter -> JS layer
                          WatchSync -> Apple Watch (N/A on Android)
```

### 5.2: Models.kt (Interfaces and Data Classes)

**Location**: `/com/isinain/pipeline/Models.kt`
**Lines**: ~96

Defines all data types and protocol interfaces. These are the contracts for dependency injection.

**Data classes**:
- `FrameAnalysis` -- blur score, brightness avg, perceptual hash (hex string), text region count, text region confidences, native OCR text, analysis time in ms
- `FrameClass` -- enum: SCENE, TEXT, MOTION, AMBIENT, DROP (with `from(raw: String)` companion factory)
- `GateResult` -- classification + reason string
- `VisionResult` -- description, OCR text, latency in ms

**Interfaces** (8 total):
- `FrameProviding` -- `getLastFrameData(): ByteArray?`, `getFrameBase64(): String?`, `frameStaleness(): Double`, `isStreamActive: Boolean`, `requestStreamRestart()`
- `FrameAnalyzing` -- `suspend fun analyze(jpegData: ByteArray): FrameAnalysis?`
- `SceneGating` -- `classify(analysis: FrameAnalysis): GateResult`, `markProcessing()`, `markDone()`
- `VisionAnalyzing` -- `suspend fun analyzeFrame(base64Jpeg, apiKey, model, timeoutMs, classification): VisionResult`
- `ObservationBuilding` -- `tick: Int`, `add(description, ocrText, classification?)`, `buildMessage(description, ocrText, classification): String`
- `GatewayConnecting` -- `isConnected`, `isCircuitOpen`, `start()`, `close()`, `suspend fun sendAgentRpc(message, idempotencyKey): String?`
- `EventEmitting` -- `emitPipelineResponse(text, tick, isStreaming)`, `emitPipelineStatus(gatewayStatus, rpcStatus, tick)`
- `WatchSyncing` -- `sendToWatch(text, tick, isStreaming, gatewayConnected)`

### 5.3: PipelineConfig.kt

**Location**: `/com/isinain/pipeline/PipelineConfig.kt`
**Lines**: ~65

Two data classes:

**PipelineConfig**:
| Field | Default | Purpose |
|---|---|---|
| gatewayWsUrl | `wss://<your-domain>` | WebSocket gateway URL |
| gatewayToken | `""` | Auth token |
| sessionKey | `"agent:main:sinain"` | Agent session key |
| openRouterApiKey | `""` | OpenRouter API key |
| visionModel | `"google/gemini-2.5-flash"` | Vision model name |
| visionTimeoutMs | 15,000 | Per-request timeout |
| tickIntervalS | 4.0 | Pipeline tick interval |
| maxStalenessMultiplier | 3.0 | Frame staleness threshold = tick * multiplier |
| maxStaleRestarts | 2 | Max stream restart attempts |
| staleRestartCooldownS | 30.0 | Cooldown between restarts |
| observationMaxEntries | 20 | Circular buffer size |
| observationMaxAgeS | 300.0 | Max age of buffer entries (5 min) |
| sceneGate | SceneGateConfig() | Scene gate thresholds |

Includes `fromReadableMap(ReadableMap)` companion to create from React Native bridge.

**SceneGateConfig**:
| Field | Default | Purpose |
|---|---|---|
| blurThreshold | 50.0 | Laplacian variance below this = blurry |
| brightnessMin | 20.0 | Too dark |
| brightnessMax | 240.0 | Too bright |
| duplicateHashDist | 5 | Hamming distance below this = duplicate |
| sceneHashDist | 15 | Hamming distance above this = major scene change |
| textMinRegions | 2 | Min text blocks for TEXT classification |
| textMinConfidence | 0.3 | Min ML Kit confidence per block |
| brightnessDelta | 30.0 | Brightness change threshold for MOTION |
| sceneCooldownMs | 2,000 | Min time between SCENE sends |
| textCooldownMs | 5,000 | Min time between TEXT sends |
| motionCooldownMs | 3,000 | Min time between MOTION sends |
| ambientIntervalMs | 30,000 | Heartbeat interval |

### 5.4: PipelineLogger.kt

**Location**: `/com/isinain/pipeline/PipelineLogger.kt`
**Lines**: ~17

Wraps Android `Log.*` with a consistent tag format `"ISinain.$subsystem"`. Provides debug, info, warn, error methods. Use `adb logcat -s 'ISinain.*'` to filter.

### 5.5: FrameAnalyzer.kt

**Location**: `/com/isinain/pipeline/FrameAnalyzer.kt`
**Lines**: ~218

Implements `FrameAnalyzing`. Runs on `Dispatchers.Default` (CPU-bound work).

**Processing chain for each JPEG frame**:

1. **Decode JPEG** -- `BitmapFactory.decodeByteArray()`. Returns null if decode fails.

2. **Grayscale conversion** -- Manual pixel extraction using `bitmap.getPixels()`, then ITU-R BT.601 luminance formula: `0.299*R + 0.587*G + 0.114*B`. Produces `IntArray` of grayscale values.

3. **Blur detection (Laplacian variance)** -- Applies 3x3 Laplacian kernel `[0,1,0,1,-4,1,0,1,0]` to the grayscale array. Computes variance of the output. Higher variance = sharper image. A bias of +128 is added to match iOS unsigned output behavior. The formula: `variance = meanSquares - mean^2`.

4. **Brightness** -- Mean of all grayscale pixel values.

5. **Perceptual dHash** -- Scales bitmap to 9x8, converts to grayscale, computes horizontal gradient (64-bit hash). Column-to-column comparison: if left pixel > right pixel, set bit. Output is a 16-character hex string.

6. **ML Kit Text Recognition** -- Creates `InputImage.fromBitmap()`, runs through `TextRecognition.getClient()` with `TextRecognizerOptions.DEFAULT_OPTIONS`. Uses `suspendCancellableCoroutine` to bridge the Task-based callback to coroutines. Returns region count, per-block confidences (averaging line confidences when available, defaulting to 0.8), and full OCR text sorted by vertical position (top of bounding box).

**Key implementation details**:
- `TextRecognizer` is created once as a class member (reused across calls)
- Bitmap is recycled after analysis to prevent memory leaks
- Analysis time is tracked at 0.1ms precision

### 5.6: SceneGate.kt

**Location**: `/com/isinain/pipeline/SceneGate.kt`
**Lines**: ~139

Implements `SceneGating`. Pure logic, no platform APIs. Maintains state between calls:
- `inFlight: Boolean` -- prevents overlapping sends
- `prevHash: String?` -- last accepted frame's perceptual hash
- `prevBrightness: Double?` -- last accepted frame's brightness
- `lastSend: Map<FrameClass, Double>` -- timestamp of last send per class
- `lastAmbientTime: Double` -- timestamp of last ambient heartbeat

**Classification priority chain** (evaluated top-to-bottom, first match wins):

| Priority | Condition | Result | Reason |
|---|---|---|---|
| 1 | `inFlight == true` | DROP | "in-flight" |
| 2 | `blurScore < blurThreshold` | DROP | "blurry" |
| 3 | `brightness < min OR > max` | DROP | "exposure" |
| 4 | `prevHash == null` (first frame) | SCENE | "first frame" |
| 5 | `hammingDistance < duplicateHashDist` | DROP or AMBIENT | "duplicate" or "heartbeat" |
| 6 | `hammingDistance > sceneHashDist` | SCENE | "major change" |
| 7 | `confidentTextRegions >= textMinRegions` | TEXT | "N text regions" |
| 8 | `abs(brightnessDelta) > threshold` | MOTION | "brightness delta N" |
| 9 | `timeSinceAmbient >= ambientInterval` | AMBIENT | "heartbeat" |
| 10 | Default | DROP | "no trigger" |

The `markProcessing()` / `markDone()` pair sets/clears the `inFlight` flag.

The Hamming distance function: parse hex strings to ULong, XOR, count set bits via `countOneBits()`.

**Cooldown system**: Each classification type (SCENE, TEXT, MOTION) has its own cooldown. A frame that would trigger a classification is silently dropped if the cooldown hasn't elapsed.

### 5.7: VisionClient.kt

**Location**: `/com/isinain/pipeline/VisionClient.kt`
**Lines**: ~187

Implements `VisionAnalyzing`. Uses OkHttp for HTTP calls to OpenRouter.

**OkHttp configuration**:
- Base client: 30s connect/read/write timeouts
- Per-request: `newBuilder()` with specific `callTimeout` from `visionTimeoutMs`

**API call structure**: Sends a multipart content array (text prompt + image_url with base64 data URI) to `https://openrouter.ai/api/v1/chat/completions`.

**Classification-aware prompts** (3 variants):

| Classification | Prompt Focus | Max Tokens | Detail |
|---|---|---|---|
| SCENE (default) | Full scene description + text extraction | 1200 | auto |
| TEXT | Text extraction first, brief context second | 1500 | auto |
| MOTION | Activity/movement description | 1200 | auto |

All prompts require output in format:
```
SCENE: [description]
TEXT: [extracted text or none]
```

**Response parsing**: The `parseResponse()` companion function finds `SCENE:` and `TEXT:` markers, extracts the content between them. "none" or "none." OCR text is normalized to empty string.

**Error handling**: SocketTimeoutException returns empty VisionResult. Non-2xx responses log the first 200 chars of the body and return empty.

### 5.8: GatewayClient.kt

**Location**: `/com/isinain/pipeline/GatewayClient.kt`
**Lines**: ~349

Implements `GatewayConnecting`. The most complex component.

**WebSocket protocol** (OpenClaw gateway):
1. Server sends `connect.challenge` event
2. Client responds with `connect` request containing auth token, client metadata, protocol version 3
3. Server responds with success/failure on id `"connect-1"`
4. Client sends `agent` RPC with message, sessionKey, idempotencyKey, deliver=false
5. Server sends `accepted` intermediate response, then final response with payloads
6. Server may also emit `agent` streaming events (payload.stream == "assistant")

**Reconnect strategy**:
- Exponential backoff starting at 1s, doubling up to 60s
- Resets to 1s on successful authentication

**Circuit breaker**:
- Tracks recent failures in a sliding window (120s)
- Opens after 5 failures within the window
- When open: starts at 5min reset delay, doubles up to 30min maximum
- On successful RPC: resets the delay back to 5min
- Uses `ScheduledExecutorService` for timer management

**RPC handling**:
- Each RPC gets a unique incrementing ID
- 60-second timeout per RPC (via scheduled future)
- `ConcurrentHashMap` for pending RPCs (thread-safe)
- Intermediate "accepted" responses are skipped; only final responses resolve the continuation
- Response text extracted from `payload.result.payloads[].text` array, joined with newlines
- Fallback: if payloads empty, checks `payload.result.messagingToolSentTexts[]`

**Callbacks**: `onStatusChange` and `onResponse` lambdas for external notification.

### 5.9: ObservationBuilder.kt

**Location**: `/com/isinain/pipeline/ObservationBuilder.kt`
**Lines**: ~220

Implements `ObservationBuilding`.

**Circular buffer**: Stores up to 20 entries, each with timestamp, description, OCR text, and classification. Entries older than 5 minutes are pruned on every access. Tick counter increments on every `add()`.

**Message format** (markdown):

```markdown
[sinain-wearable live context -- tick #N] [motion detected]

## What I See
[description or "[frame -- no description available]"]

### Visible Text
```
[ocr text, max 500 chars]
```

## Recent Context
- [Ns ago] [scene] Description text -- "OCR snippet..."
- [Ns ago] [text] Description text

## Instructions
**Display constraint:** Mobile phone screen. 2-4 concise sentences.
[context-aware instruction]

Respond naturally -- this will appear on the user's mobile screen.
```

**Context-aware instructions** (evaluated in priority order):

1. **Error patterns in OCR** (error, exception, failed, traceback, etc.) -- "Identify the specific error, explain root cause, suggest fix"
2. **Non-empty OCR text** -- "Provide insight, translation, context. Do NOT just repeat the text"
3. **MOTION classification** -- "Describe activity, offer relevant context"
4. **People keywords in description** (person, meeting, conversation, etc.) -- "Offer situational tip: conversation starters, meeting facilitation"
5. **Screen keywords** (monitor, code, terminal, etc.) -- "Investigate errors, offer guidance, share insight"
6. **Default** -- "Share observation, fun fact, or practical tip. NEVER respond with filler"

All instructions include the mandate: "ALWAYS provide a substantive response. Do NOT respond with emoji, NO_REPLY, or filler."

### 5.10: PipelineOrchestrator.kt

**Location**: `/com/isinain/pipeline/PipelineOrchestrator.kt`
**Lines**: ~252

The main tick loop. Takes all pipeline components via constructor injection.

**Lifecycle**:
- `start()` -- Creates `CoroutineScope(Dispatchers.Default + SupervisorJob())`, launches tick loop
- `stop()` -- Cancels scope, resets state
- Notifies watch on start: "Pipeline active -- processing every Ns"

**Tick flow** (executed every `tickIntervalS` seconds):

1. **Guard**: Skip if not running or still processing previous tick
2. **Warm-up**: If pipeline started less than `maxStalenessS` ago and no frames yet, skip silently
3. **Staleness check**: If frame staleness > maxStalenessS, request stream restart (max 2 attempts with 30s cooldown)
4. **Get frame**: `frameProvider.getLastFrameData()`. Skip if null.
5. **Reset stale tracking** on successful frame read
6. **Analyze**: `analyzer.analyze(frameData)`. Skip if null.
7. **Gate**: `gate.classify(analysis)`. If DROP, return.
8. **Mark processing**: `gate.markProcessing()`, set `processing = true`
9. **Get base64**: `frameProvider.getFrameBase64()`. Skip if null.
10. **Vision API**: Call if openRouterApiKey is set. Prefer native OCR over vision OCR.
11. **Skip if both empty**: No description AND no OCR = skip.
12. **Build observation**: `observation.add()` + `observation.buildMessage()`
13. **Send**: If gateway connected and circuit closed, send via `gateway.sendAgentRpc()`. Otherwise, emit vision description directly.
14. **Emit status**: Report gateway status + RPC status + tick to JS layer
15. **Finally**: Clear `processing`, call `gate.markDone()`

**Error resilience**: The entire processing block is in try-finally to ensure `processing` flag and gate are always reset.

---

## 6. ForegroundService Design

### 6.1: HudPipelineService

**Location**: `/com/isinain/service/HudPipelineService.kt`
**Lines**: ~263 (including ServiceFrameProvider)

Extends `LifecycleService` (not plain `Service`) for lifecycle-aware coroutine support.

**Why ForegroundService?** This is the core Android advantage over iOS. iOS suspends the camera/video pipeline when the screen locks. Android's ForegroundService with `connectedDevice` type runs indefinitely -- BLE stays active through Doze, PARTIAL_WAKE_LOCK keeps the CPU running for frame analysis.

**Service lifecycle**:
- `ACTION_START` -- calls `startForegroundWithNotification()` + `acquireWakeLock()`
- `ACTION_STOP` -- calls `stopPipeline()`, `stopForeground()`, `stopSelf()`
- `START_STICKY` return -- system restarts service if killed
- Binding via `LocalBinder` pattern for in-process communication with WearablesBridge

**Pipeline control**:
- `configure(PipelineConfig)` -- Creates GatewayClient eagerly (survives stream stop/start -- this is a fix for a bug where stopping the stream killed the gateway)
- `startPipeline()` -- Creates ServiceFrameProvider + all pipeline components + PipelineOrchestrator, starts the tick loop
- `stopPipeline()` -- Stops orchestrator, nulls provider
- `onFrameReceived(jpegData)` -- Called by bridge on each MWDAT frame

**Notification**:
- Channel: `"isinain_hud_pipeline"`, `IMPORTANCE_LOW` (no sound/vibration)
- Shows "HUD Pipeline active" with tap-to-open (PendingIntent to MainActivity) and "Stop" action (PendingIntent to service with ACTION_STOP)
- Uses `android.R.drawable.ic_menu_view` as small icon (replace with custom icon for production)
- On API 34+, calls `startForeground(id, notification, FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)`

**Wake lock**:
- `PARTIAL_WAKE_LOCK` with tag `"ISinain::HudPipeline"`
- Acquired on ACTION_START, released in onDestroy
- Keeps CPU running but allows screen to turn off

### 6.2: ServiceFrameProvider

**Location**: Same file as HudPipelineService
**Lines**: ~42

Implements `FrameProviding`. Thread-safe via `@Volatile` fields.

- `lastFrame: ByteArray?` -- Latest JPEG frame from MWDAT
- `lastFrameTime: Long` -- Timestamp of last frame update
- `isStreamActive: Boolean` -- Set true on first frame, can be manually set false

- `getFrameBase64()` -- `Base64.encodeToString(data, Base64.NO_WRAP)` (no line breaks)
- `frameStaleness()` -- `(now - lastFrameTime) / 1000.0` seconds. Returns `Double.MAX_VALUE` if never received a frame.
- `streamRestartCallback: (() -> Unit)?` -- Set by WearablesBridge to enable stream restart from the pipeline

---

## 7. React Native Bridge

### 7.1: WearablesBridge

**Location**: `/com/isinain/bridge/WearablesBridge.kt`
**Lines**: ~557

The bridge between JS and native. Implements `EventEmitting` to receive pipeline events. This is the largest and most complex file.

**Service binding**: On init, binds to HudPipelineService via `BIND_AUTO_CREATE`. Sets itself as the service's `eventEmitter`. Unbinds in `invalidate()`.

**JS API (6 methods)**:

| Method | Signature | Behavior |
|---|---|---|
| `configure` | `(configMap: ReadableMap, promise: Promise)` | Starts foreground service, waits for binding (up to 2s polling), calls `service.configure()` |
| `startRegistration` | `(promise: Promise)` | Launches Meta AI app for BLE pairing, waits up to 60s for `RegistrationState.Registered`, starts device connection monitor |
| `startStream` | `(config: ReadableMap, promise: Promise)` | Checks camera permission, maps config to `StreamConfiguration`, creates `StreamSession`, starts state monitor + frame collector |
| `stopStream` | `(promise: Promise)` | Stops pipeline (NOT gateway), cancels frame/state jobs, closes StreamSession |
| `capturePhoto` | `(promise: Promise)` | Re-encodes latest frame at quality 92, writes to cache dir temp file, returns `{uri, width, height}` |
| `getState` | `(promise: Promise)` | Returns `{connection, stream}` |

**Events emitted to JS** (5 types):

| Event | Payload |
|---|---|
| `onFrame` | `{uri, width, height, fps, timestamp}` |
| `onState` | `{connection, stream}` |
| `onError` | `{code, message}` |
| `onPipelineResponse` | `{text, tick, isStreaming, timestamp}` |
| `onPipelineStatus` | `{gatewayStatus, rpcStatus, tick}` |

**Frame processing**: Frames from MWDAT arrive as I420 (YUV420 planar). The conversion to JPEG is:
1. Copy I420 buffer to ByteArray
2. Convert I420 to NV21 (semi-planar): copy Y plane, interleave U/V into VU pairs
3. Create `YuvImage(nv21, NV21, width, height, null)`
4. `compressToJpeg(rect, 75, outputStream)` -- quality 75 for pipeline, 92 for photo capture
5. Forward JPEG bytes to both `lastFrameData` (for capturePhoto) and `service.onFrameReceived()` (for pipeline)

**I420 to NV21 conversion algorithm**:
```
I420: [Y Y Y Y ...][U U ...][V V ...]
NV21: [Y Y Y Y ...][V U V U ...]

For N pixels:
  - Y plane size = width * height
  - U plane size = V plane size = width * height / 4
  - Copy Y plane as-is
  - For each index n in [0, quarter):
      output[Y_size + n*2]     = input[Y_size + quarter + n]  // V
      output[Y_size + n*2 + 1] = input[Y_size + n]            // U
```

**FPS tracking**: Counts frames per 1-second window. Writes latest frame to `frame_latest.jpg` in cache dir and emits `onFrame` event once per second (not per frame) to avoid overwhelming the JS bridge.

**Stream restart**: `restartStream()` closes the current session, waits 500ms cooldown, creates new session with same config, re-attaches state and frame collectors.

### 7.2: WearablesPackage

**Location**: `/com/isinain/bridge/WearablesPackage.kt`
**Lines**: ~20

Standard `ReactPackage` that registers `WearablesBridge`. Added to `MainApplication`'s package list:

```kotlin
override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
        context = applicationContext,
        packageList = PackageList(this).packages.apply {
            add(WearablesPackage())
        },
    )
}
```

---

## 8. JavaScript Layer

### 8.1: Entry Point

File: `index.js`
```javascript
import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';
AppRegistry.registerComponent(appName, () => App);
```

### 8.2: Types

File: `src/types.ts` -- All shared TypeScript interfaces.

Key types: `FrameData`, `PhotoResult`, `WearableState`, `StreamConfig`, `WearableError`, `FrameClass`, `GatewayStatus` (union: disconnected/connecting/connected/error), `RpcStatus` (union: idle/sending/accepted/streaming/received/error/timeout), `VisionResult`, `PipelineState`, `MessageEntry`.

### 8.3: Config

File: `src/pipeline/config.ts` -- Reads `.env` via `react-native-dotenv` `@env` module. Produces `PipelineConfig` with gateway (wsUrl, token, sessionKey) and vision (apiKey, model) sections. Defaults: `wss://<your-domain>`, `agent:main:sinain`, `google/gemini-2.5-flash`.

### 8.4: Hooks

**useWearables** (`src/hooks/useWearables.ts`):
- Subscribes to `onFrame`, `onState`, `onError` native events via `NativeEventEmitter`
- Fetches initial state via `getState()` on mount
- Exposes: `connection`, `frame`, `error`, `isStreaming`, `startRegistration()`, `startStream(config?)`, `stopStream()`, `capturePhoto()`
- `isStreaming` is derived: `state.stream === 'streaming'`

**usePipeline** (`src/hooks/usePipeline.ts`):
- Subscribes to `onPipelineResponse` and `onPipelineStatus` native events
- Pure event listener -- zero JS pipeline code
- Exposes: `gatewayStatus`, `lastRpcStatus`, `tick`, `lastResponse`, `lastVision`, `error`

**useWatchSync** (`src/hooks/useWatchSync.ts`):
- Debounced (200ms) sync to WatchBridge native module
- Memoizes by JSON key to avoid redundant sends
- Sends max 10 messages with status payload
- No-op if WatchBridge is not available (no Apple Watch on Android)

### 8.5: Components

**StatusHeader**: Displays app title, device connection status (green/red dot), gateway status (green/orange/red dot), tick counter.

**CameraPreview**: Shows latest frame image (with cache-busting `?t=timestamp`), or placeholder text. Overlays: FPS badge (bottom-right), resolution badge (bottom-left). Uses `resizeMode="contain"`.

**Controls**: Three buttons:
- Register (grey) -- starts BLE pairing
- Stream/Stop (blue/red toggle) -- starts/stops camera stream
- Capture Photo (green, disabled when not streaming) -- takes high-quality snapshot

**ResponseFeed**: Inverted FlatList of MessageEntry items. Fade-in animation for new messages (300ms, native driver). Positional opacity gradient (newest = 1.0, decreasing by 0.12 per item, minimum 0.25). Streaming indicator (blue dot) for in-progress messages.

### 8.6: App.tsx

Root component orchestrating everything:

1. Calls `configure()` on mount with env config
2. Captures finalized responses when tick advances (into `messageHistory`, max 15 entries)
3. Derives `streamingEntry` from RPC status (shown at top of feed during processing)
4. Builds `displayMessages` array: streaming entry + history, or history, or placeholder
5. Passes messages to `useWatchSync`
6. Layout: SafeAreaView -> StatusHeader -> CameraPreview -> ResponseFeed -> Controls -> Photo thumbnail -> Error display

---

## 9. MWDAT SDK Integration

### 9.1: The Problem

MWDAT SDK (Meta Wearables DAT) is distributed as fat-AARs (`mwdat-core:0.4.0`, `mwdat-camera:0.4.0`) that embed partial copies of Facebook libraries (fbjni, fbcore, soloader). React Native also depends on these libraries. At dex-merge time, Gradle encounters duplicate class definitions and fails the build.

### 9.2: Current Strategy -- compileOnly

The MWDAT dependencies are declared as `compileOnly`:
```groovy
compileOnly("com.meta.wearable:mwdat-core:0.4.0")
compileOnly("com.meta.wearable:mwdat-camera:0.4.0")
```

This means:
- **Compile time**: All MWDAT classes are visible. Code compiles without errors.
- **Runtime**: MWDAT classes are NOT in the APK. Any attempt to use them throws `NoClassDefFoundError`.

### 9.3: Runtime Guards

Every MWDAT SDK call MUST be wrapped:

```kotlin
// Class-level: nullable with try-catch initialization
private val deviceSelector: AutoDeviceSelector? = try {
    AutoDeviceSelector()
} catch (_: NoClassDefFoundError) { null }

private val mwdatAvailable = deviceSelector != null
```

```kotlin
// Method-level: guard and early return
@ReactMethod
fun startRegistration(promise: Promise) {
    if (!mwdatAvailable) {
        promise.reject("MWDAT_UNAVAILABLE", "MWDAT SDK is not bundled (compileOnly)")
        return
    }
    // ... actual MWDAT code
}
```

```kotlin
// Activity-level: try-catch for initialization
try {
    MainScope().launch {
        Wearables.initialize(this@MainActivity)
    }
} catch (_: NoClassDefFoundError) {
    Log.w("MainActivity", "MWDAT SDK not available, skipping init")
}
```

### 9.4: Why Not Just Exclude fbjni?

Attempting to exclude fbjni globally:
```groovy
// DO NOT DO THIS -- breaks native builds
configurations.all {
    exclude group: 'com.facebook.fbjni'
}
```

This breaks CMake prefab. React Native's native C++ build depends on fbjni headers, and excluding it makes the prefab "fbjni" target unavailable, causing build failure.

### 9.5: Future Migration Path (When SDK Conflicts Are Resolved)

When Meta releases an MWDAT version without fat-AAR conflicts, or when you are ready to invest in fixing it:

1. Change `compileOnly` to `implementation`
2. If fat-AAR conflicts persist, try dependency shadowing/relocation using `shadow` plugin
3. Alternatively, unpack the AAR, remove the conflicting classes, repackage
4. Remove all `try-catch(NoClassDefFoundError)` guards
5. Remove `mwdatAvailable` checks
6. Test full BLE pairing + streaming flow

### 9.6: MWDAT API Surface Used

| Class/Method | Purpose |
|---|---|
| `Wearables.initialize(activity)` | SDK init in MainActivity.onCreate |
| `Wearables.startRegistration(activity)` | Launch Meta AI app for BLE pairing |
| `Wearables.registrationState` | Flow to monitor registration progress |
| `Wearables.devices` | Flow of connected devices |
| `Wearables.checkPermissionStatus(Permission.CAMERA)` | Check glasses camera permission |
| `AutoDeviceSelector()` | Automatic device selection |
| `AutoDeviceSelector.activeDevice(devicesFlow)` | Flow of the active device |
| `Wearables.startStreamSession(context, selector, config)` | Create streaming session |
| `StreamSession.state` | Flow of stream state (CONNECTING, STREAMING, DISCONNECTED) |
| `StreamSession.videoStream` | Flow of VideoFrame objects |
| `VideoFrame.buffer` | ByteBuffer containing I420 frame data |
| `VideoFrame.width`, `VideoFrame.height` | Frame dimensions |
| `StreamConfiguration(quality, frameRate)` | Stream config: VideoQuality.LOW/MEDIUM/HIGH |

---

## 10. Testing and Deployment

### 10.1: Build Commands

**Debug build** (requires Metro running):
```bash
cd android
./gradlew assembleDebug
```
APK location: `android/app/build/outputs/apk/debug/app-debug.apk`

**Release build** (JS bundled in APK):
```bash
# Bundle JS first
npx react-native bundle --platform android --dev false \
  --entry-file index.js \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res

cd android
./gradlew assembleRelease
```
APK location: `android/app/build/outputs/apk/release/app-release.apk`

### 10.2: Metro Dev Server

For debug builds:
```bash
# Terminal 1: Start Metro
npx react-native start

# Terminal 2: Reverse port for USB-connected device
adb reverse tcp:8081 tcp:8081
```

### 10.3: APK Installation on MIUI

**CRITICAL**: MIUI blocks USB installs even with "Install via USB" enabled in Developer Options. `adb install` often fails silently or with misleading errors.

**Workaround**:
```bash
# Push APK to device
adb push app-debug.apk /sdcard/Download/

# On the device:
# 1. Open Files app
# 2. Navigate to Download
# 3. Tap the APK
# 4. Approve installation
```

This works because installing from the file manager uses a content:// URI path that MIUI trusts.

If `adb install` works on your MIUI version, use it. But expect it to fail and have the push-and-tap workflow ready.

### 10.4: Logcat Debugging

```bash
# All ISinain logs
adb logcat -s 'ISinain.*'

# Specific subsystems
adb logcat -s 'ISinain.Pipeline'
adb logcat -s 'ISinain.GatewayClient'
adb logcat -s 'ISinain.SceneGate'
adb logcat -s 'ISinain.VisionClient'
adb logcat -s 'ISinain.FrameAnalyzer'
adb logcat -s 'ISinain.HudService'
adb logcat -s 'ISinain.WearablesBridge'
adb logcat -s 'ISinain.FrameProvider'

# React Native JS logs
adb logcat -s 'ReactNativeJS'

# MIUI WindowManager kills (if app is force-killed)
adb logcat | grep -i "InputFeature\|force-kill\|WindowManager"
```

### 10.5: Verifying the Pipeline

1. **Gateway connection**: Check logcat for `ISinain.GatewayClient: authenticated`
2. **Frame reception**: Check for `ISinain.FrameProvider` or `ISinain.WearablesBridge: onMwdatFrame`
3. **Gate decisions**: Check `ISinain.SceneGate: gate: scene -- major change` vs `gate: drop -- duplicate`
4. **Vision API**: Check `ISinain.VisionClient: scene 500 chars in 2.1s`
5. **RPC**: Check `ISinain.GatewayClient: agent RPC sent` and `rpc N: final`

### 10.6: Common Build Errors

| Error | Cause | Fix |
|---|---|---|
| "fbjni not found" in CMake | fbjni excluded globally | Use `compileOnly` for MWDAT, not global exclusion |
| Duplicate class com.facebook.* | MWDAT as `implementation` | Change to `compileOnly` |
| "Invalid apk" on MIUI | minSdk too high for device | Set `minSdkVersion = 29` (API level of target device) |
| AGP error with JDK version | Wrong JDK | Set `org.gradle.java.home` in gradle.properties to JDK 17 |
| "Unable to load script" on device | Metro not accessible | Run `adb reverse tcp:8081 tcp:8081` or bundle JS into APK |

---

## 11. Known Issues and Workarounds

### 11.1: MIUI Process Kills

**Symptom**: App crashes immediately on launch or when DevMenu/RedBox appears, with no stack trace in logcat.

**Cause**: MIUI's WindowManagerService kills processes that add views with `INPUT_FEATURE_NO_INPUT_CHANNEL` (0x0002).

**Fix**: All three MIUI safety layers (Section 4) + `forceDarkAllowed=false` in theme.

### 11.2: MWDAT Fat-AAR Conflicts

**Symptom**: `DuplicateClassException` at build time when MWDAT is `implementation`.

**Fix**: Use `compileOnly` scope. Guard all SDK calls with `try-catch(NoClassDefFoundError)`.

### 11.3: Frame Staleness and Stream Recovery

**Symptom**: Pipeline stops producing observations after glasses disconnect/reconnect.

**Fix**: Pipeline orchestrator detects staleness (frame age > tickInterval * 3), triggers stream restart via `ServiceFrameProvider.streamRestartCallback`. Max 2 restart attempts with 30s cooldown.

### 11.4: Gateway Circuit Breaker Stuck Open

**Symptom**: Pipeline stops sending to gateway, logcat shows "circuit breaker open".

**Cause**: 5+ RPC failures within 2 minutes (usually 429 rate limiting or network issues).

**Fix**: Circuit breaker auto-resets: 5min, then 10min, then 20min, then 30min (progressive doubling). On successful RPC, reset delay reverts to 5min. No manual intervention needed, but can restart pipeline via UI.

### 11.5: ML Kit First-Call Latency

**Symptom**: First frame analysis takes several seconds.

**Cause**: ML Kit downloads and initializes the text recognition model on first use.

**Fix**: This is expected. The pipeline has a warm-up period (skips ticks until `maxStalenessS` after start). Subsequent calls are fast (~50-200ms).

### 11.6: Memory Pressure from Bitmap Operations

**Symptom**: OOM on low-memory devices.

**Fix**: `bitmap.recycle()` is called after every analysis. The frame provider stores only one frame at a time (`@Volatile` single reference). Frame JPEG quality is 75 (not 100) to reduce memory.

### 11.7: WebSocket Reconnection After Network Change

**Symptom**: Gateway shows "disconnected" after WiFi/cellular switch.

**Fix**: OkHttp WebSocket detects connection loss via `onFailure`. The reconnect scheduler kicks in with exponential backoff. No manual reconnection needed.

### 11.8: Duplicate config.ts Files

**Note**: The current codebase has a duplicated `config.ts` at both `src/pipeline/config.ts` and `src/pipeline/pipeline/config.ts`. The app imports from `./pipeline/config`. Clean this up during rebuild -- keep only `src/pipeline/config.ts`.

---

## Appendix A: File-by-File Implementation Order

For a clean rebuild, implement in this order:

1. `npx react-native init` + install dependencies + babel config
2. `android/build.gradle`, `settings.gradle`, `gradle.properties`
3. `AndroidManifest.xml`, `styles.xml`, `strings.xml`
4. `MainApplication.kt` (MiuiSafeContext + WindowManagerGlobal patch + WearablesPackage registration)
5. `MainActivity.kt` (MiuiSafeWindowManager + MWDAT init guard)
6. `pipeline/Models.kt` (interfaces + data classes)
7. `pipeline/PipelineConfig.kt`
8. `pipeline/PipelineLogger.kt`
9. `pipeline/FrameAnalyzer.kt`
10. `pipeline/SceneGate.kt`
11. `pipeline/VisionClient.kt`
12. `pipeline/GatewayClient.kt`
13. `pipeline/ObservationBuilder.kt`
14. `pipeline/PipelineOrchestrator.kt`
15. `service/HudPipelineService.kt` (+ ServiceFrameProvider)
16. `bridge/WearablesPackage.kt`
17. `bridge/WearablesBridge.kt`
18. `src/types.ts`
19. `src/pipeline/env.d.ts` + `src/pipeline/config.ts`
20. `src/hooks/useWearables.ts`
21. `src/hooks/usePipeline.ts`
22. `src/hooks/useWatchSync.ts`
23. `src/components/StatusHeader.tsx`
24. `src/components/CameraPreview.tsx`
25. `src/components/Controls.tsx`
26. `src/components/ResponseFeed.tsx`
27. `src/App.tsx`
28. `index.js`
29. `.env` + `.env.example`

## Appendix B: Total Line Counts

| Layer | Files | Lines |
|---|---|---|
| Pipeline (Kotlin) | 9 | ~1,543 |
| Service (Kotlin) | 1 | ~311 |
| Bridge (Kotlin) | 2 | ~577 |
| App (Kotlin) | 2 | ~277 |
| **Kotlin total** | **14** | **~2,708** |
| JS/TS | 11 | ~815 |
| Build config | 6 | ~250 |
| XML | 3 | ~75 |
| **Grand total** | **34** | **~3,848** |

---

### Critical Files for Implementation

- `/Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-mobile/android/app/src/main/java/com/isinain/MainApplication.kt` - Contains all three MIUI compatibility layers (MiuiSafeContext, MiuiSafeWindowManagerImpl, WindowManagerGlobal patch). Getting this wrong means instant process death on Xiaomi devices.
- `/Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-mobile/android/app/src/main/java/com/isinain/bridge/WearablesBridge.kt` - The 557-line bridge is the most complex single file. It handles MWDAT integration, I420-to-NV21 conversion, service binding, frame forwarding, event emission, and stream restart. Every other component flows through it.
- `/Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-mobile/android/app/src/main/java/com/isinain/pipeline/GatewayClient.kt` - The 349-line WebSocket client with circuit breaker, reconnection, and the full OpenClaw RPC protocol. Most subtle bugs live here (race conditions, timeout handling, progressive backoff).
- `/Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-mobile/android/app/build.gradle` - The dependency configuration where MWDAT `compileOnly` strategy is defined. One wrong scope keyword causes either dex-merge failure or native build failure.
- `/Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-mobile/android/app/src/main/java/com/isinain/pipeline/PipelineOrchestrator.kt` - The 252-line tick loop that ties all pipeline components together. The staleness detection, warm-up logic, and fallback routing (gateway vs direct) are all here.