# React Native Development

## Build & Metro
- Metro bundler cache invalidation: `npx react-native start --reset-cache` when module resolution breaks
- Gradle sync failures after native dependency changes: clean build with `cd android && ./gradlew clean`
- CocoaPods version mismatches: pin pod versions in Podfile, run `pod install --repo-update`
- New Architecture (TurboModules/Fabric): requires explicit opt-in per native module

## Native Bridges
- WearablesBridge pattern: Kotlin/Swift native module → React Native JS via NativeEventEmitter
- Keep bridge methods minimal — pass serialized JSON strings, parse on each side
- ForegroundService (Android): PARTIAL_WAKE_LOCK survives screen lock; iOS requires BackgroundKeepAlive workaround
- Always test bridge on both platforms — type mismatches silently fail

## Debugging
- Flipper for network/layout inspection; Reactotron for state debugging
- Hermes vs JSC: Hermes is default since RN 0.70 — check engine-specific Date/Intl quirks
- Native crash logs: `adb logcat` (Android), Xcode console (iOS) — JS stack traces often incomplete
- Red box errors in dev: usually syntax or import issues; yellow box = deprecation warnings

## Architecture Decisions
- Pipeline runs in ForegroundService (Android) / BackgroundKeepAlive (iOS) — not in JS thread
- Camera/vision: native ML Kit (Android) + Vision framework (iOS) — no JS camera dependency
- State sync between native and JS: use events, not polling — NativeEventEmitter with typed payloads
- OkHttp for Android network, URLSession for iOS — avoid JS fetch for latency-sensitive paths
