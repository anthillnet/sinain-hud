# sinain-mobile

Cross-platform React Native companion app for SinainHUD. Streams live camera frames from Ray-Ban Meta smart glasses via the Meta Wearables Device Access Toolkit (MWDAT) SDK and runs an on-device image processing pipeline.

## Platforms

| Platform | Native code | Notes |
|----------|-------------|-------|
| **iOS** | Swift (`ios/ISinain/`) | CocoaPods, MWDAT SDK |
| **Android** | Kotlin (`android/.../isinain/`) | Foreground service, MIUI compat |

## Quick Start

```bash
npm install
```

### iOS

```bash
cd ios && pod install && cd ..
npx react-native run-ios --device
```

### Android

See [docs/ANDROID-REBUILD-SPEC.md](../docs/ANDROID-REBUILD-SPEC.md) for the full build guide — it covers JDK/NDK requirements, Gradle configuration, MIUI compatibility, and deployment to Xiaomi devices.

```bash
npx react-native run-android
```

## Pipeline Architecture

The on-device pipeline is configured in `src/pipeline/config.ts` (TypeScript), with native counterparts:
- **iOS**: `ios/ISinain/Config/PipelineConfig.swift`
- **Android**: `android/app/src/main/java/com/isinain/pipeline/PipelineConfig.kt`

## License

MIT — see [LICENSE](../LICENSE) in the repo root.
