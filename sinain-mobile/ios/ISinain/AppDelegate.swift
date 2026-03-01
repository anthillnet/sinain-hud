import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import MWDATCore

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    var reactNativeDelegate: ReactNativeDelegate?
    var reactNativeFactory: RCTReactNativeFactory?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // MWDAT SDK — must be called before any other SDK call
        do {
            try Wearables.configure()
            print("[MWDAT] SDK configured successfully")
        } catch {
            print("[MWDAT] SDK configuration failed: \(error)")
        }

        let delegate = ReactNativeDelegate()
        let factory = RCTReactNativeFactory(delegate: delegate)
        delegate.dependencyProvider = RCTAppDependencyProvider()

        reactNativeDelegate = delegate
        reactNativeFactory = factory

        window = UIWindow(frame: UIScreen.main.bounds)

        factory.startReactNative(
            withModuleName: "ISinain",
            in: window,
            launchOptions: launchOptions
        )

        // Background/foreground lifecycle
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.handleEnterBackground()
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.handleEnterForeground()
        }

        return true
    }

    private func handleEnterBackground() {
        print("[AppDelegate] background: starting keep-alive")
        BackgroundKeepAlive.shared.start()
    }

    private func handleEnterForeground() {
        print("[AppDelegate] foreground: stopping keep-alive")
        BackgroundKeepAlive.shared.stop()
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        // Handle callback from Meta AI app after registration
        if url.absoluteString.contains("metaWearablesAction") {
            Task { try? await Wearables.shared.handleUrl(url) }
            return true
        }
        return RCTLinkingManager.application(app, open: url, options: options)
    }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
    override func sourceURL(for bridge: RCTBridge) -> URL? {
        self.bundleURL()
    }

    override func bundleURL() -> URL? {
#if DEBUG
        RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
        Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
    }
}
