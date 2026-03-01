import AVFoundation

/// Plays a silent audio loop to keep the app process alive when backgrounded.
/// Uses `.playback` category with `.mixWithOthers` so it won't interrupt the user's music.
/// This is the one justified singleton — it must survive bridge recreation.
final class BackgroundKeepAlive {
    static let shared = BackgroundKeepAlive()

    private var player: AVAudioPlayer?
    private var isRunning = false

    private init() {}

    func start() {
        guard !isRunning else { return }
        isRunning = true

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, options: .mixWithOthers)
            try session.setActive(true)
        } catch {
            print("[BackgroundKeepAlive] audio session error: \(error)")
        }

        guard let url = Bundle.main.url(forResource: "silence", withExtension: "caf") else {
            print("[BackgroundKeepAlive] silence.caf not found in bundle")
            return
        }

        do {
            let audioPlayer = try AVAudioPlayer(contentsOf: url)
            audioPlayer.numberOfLoops = -1
            audioPlayer.volume = 0.0
            audioPlayer.play()
            self.player = audioPlayer
            print("[BackgroundKeepAlive] started silent audio loop")
        } catch {
            print("[BackgroundKeepAlive] player error: \(error)")
        }
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        player?.stop()
        player = nil

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            print("[BackgroundKeepAlive] deactivate error: \(error)")
        }
        print("[BackgroundKeepAlive] stopped")
    }
}
