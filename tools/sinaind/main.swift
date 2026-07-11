// sinaind — SinainHUD supervisor (runtime-architecture §7 step 1).
//
// A single native process that owns every child service: spawn, pipe→log,
// health probes, restart-with-backoff, graceful shutdown. Replaces the bash
// supervision in start.sh, whose pipeline plumbing was the direct cause of
// the 2026-07-11 half-death (start.sh killed at session teardown → pipe_log
// consumers gone → children die of EPIPE → core survives headless).
//
// Design properties the bash version cannot have:
//   - Immune to terminal/session teardown: SIGHUP ignored; --daemon re-execs
//     into its own session (setsid), no controlling TTY.
//   - Owns child stdout/stderr pipes directly; a child crash never takes the
//     log path (or siblings) down with it.
//   - Crashed children restart with exponential backoff; a live-but-deaf core
//     (port bound, /health failing) is detected and restarted — previously
//     that state persisted silently for hours ("range was idle").
//   - Single structured session log + machine-readable state.json for the
//     overlay to surface degraded state.
//
// Usage: sinaind [--dev] [--no-sense] [--no-overlay] [--paranoid] [--daemon]
//                [--root <repo-root>]

import Foundation

// MARK: - CLI

var flagDev = false
var flagNoSense = false
var flagNoOverlay = false
var flagParanoid = false
var flagDaemon = false
var rootOverride: String? = nil

var argIter = CommandLine.arguments.dropFirst().makeIterator()
while let arg = argIter.next() {
    switch arg {
    case "--dev": flagDev = true
    case "--no-sense": flagNoSense = true
    case "--no-overlay": flagNoOverlay = true
    case "--paranoid": flagParanoid = true
    case "--daemon": flagDaemon = true
    case "--root":
        guard let v = argIter.next() else { FileHandle.standardError.write("--root requires a path\n".data(using: .utf8)!); exit(2) }
        rootOverride = v
    case "--help", "-h":
        print("""
        sinaind — SinainHUD supervisor

        Usage: sinaind [flags]
          --dev          Run dev toolchain (tsx watch, flutter run) instead of
                         compiled core / built overlay app
          --no-sense     Skip sense_client (disables ALL capture)
          --no-overlay   Skip the overlay app
          --paranoid     Fully offline mode (loads .env.paranoid)
          --daemon       Detach into own session and return immediately
          --root <path>  Repo root (default: inferred from binary location)
        """)
        exit(0)
    default:
        FileHandle.standardError.write("unknown flag: \(arg)\n".data(using: .utf8)!)
        exit(2)
    }
}

// MARK: - Repo root

let fm = FileManager.default

func resolveRoot() -> String {
    if let r = rootOverride {
        return URL(fileURLWithPath: r, relativeTo: URL(fileURLWithPath: fm.currentDirectoryPath)).standardizedFileURL.path
    }
    // Binary lives at <root>/tools/sinaind/sinaind
    let bin = URL(fileURLWithPath: CommandLine.arguments[0],
                  relativeTo: URL(fileURLWithPath: fm.currentDirectoryPath)).standardizedFileURL
    return bin.deletingLastPathComponent()          // tools/sinaind
              .deletingLastPathComponent()          // tools
              .deletingLastPathComponent().path     // root
}

let root = resolveRoot()
guard fm.fileExists(atPath: "\(root)/sinain-core/package.json") else {
    FileHandle.standardError.write("sinaind: \(root) does not look like a sinain-hud checkout (pass --root)\n".data(using: .utf8)!)
    exit(2)
}

let home = fm.homeDirectoryForCurrentUser.path

// MARK: - Daemonize (before anything opens files/timers)

// Two-step: parent spawns itself with SINAIND_CHILD=1 and exits; the child
// calls setsid() so terminal/session teardown can never reach it.
let isDaemonChild = ProcessInfo.processInfo.environment["SINAIND_CHILD"] == "1"
if flagDaemon && !isDaemonChild {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0],
                          relativeTo: URL(fileURLWithPath: fm.currentDirectoryPath)).standardizedFileURL
    p.arguments = Array(CommandLine.arguments.dropFirst())
    var env = ProcessInfo.processInfo.environment
    env["SINAIND_CHILD"] = "1"
    p.environment = env
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch {
        FileHandle.standardError.write("sinaind: failed to daemonize: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    print("sinaind: detached (pid \(p.processIdentifier)) — log: \(ProcessInfo.processInfo.environment["SINAIN_SESSION_LOG"] ?? "~/.sinain/logs/backend.log")")
    exit(0)
}
if isDaemonChild { setsid() }

// Everything the supervisor or its children create is private to the user —
// the session log holds OCR/vision/transcript output.
umask(0o077)
signal(SIGPIPE, SIG_IGN)
signal(SIGHUP, SIG_IGN)

// MARK: - Session log

let logDir = ProcessInfo.processInfo.environment["SINAIN_LOG_DIR"] ?? "\(home)/.sinain/logs"
let logPath = ProcessInfo.processInfo.environment["SINAIN_SESSION_LOG"] ?? "\(logDir)/backend.log"
try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)

// Rotate at 5 MB like start.sh so "Open Session Log" stays snappy.
if let size = (try? fm.attributesOfItem(atPath: logPath)[.size]) as? Int, size > 5_000_000 {
    try? fm.removeItem(atPath: logPath + ".1")
    try? fm.moveItem(atPath: logPath, toPath: logPath + ".1")
}
if !fm.fileExists(atPath: logPath) { fm.createFile(atPath: logPath, contents: nil) }

let logQ = DispatchQueue(label: "sinaind.log")
let logHandle: FileHandle = {
    guard let h = FileHandle(forWritingAtPath: logPath) else {
        FileHandle.standardError.write("sinaind: cannot open \(logPath)\n".data(using: .utf8)!)
        exit(1)
    }
    h.seekToEndOfFile()
    return h
}()

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

/// Append one line to the session log (and stdout when interactive).
/// Matches the pipe_log format: "[tag] text".
func logLine(_ tag: String, _ text: String) {
    logQ.async {
        let line = "[\(tag)] \(text)\n"
        if let d = line.data(using: .utf8) { logHandle.write(d) }
        if !isDaemonChild { FileHandle.standardOutput.write(line.data(using: .utf8) ?? Data()) }
    }
}

func slog(_ text: String) { logLine("sinaind", "\(iso.string(from: Date())) \(text)") }

logQ.async {
    let header = "\n# SinainHUD session started \(iso.string(from: Date())) (sinaind)\n"
    logHandle.write(header.data(using: .utf8)!)
}

// MARK: - Small helpers

@discardableResult
func runTool(_ path: String, _ args: [String], cwd: String? = nil) -> (status: Int32, stdout: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    if let cwd = cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return (127, "") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func pgrep(_ pattern: String) -> [Int32] {
    let (_, out) = runTool("/usr/bin/pgrep", ["-f", pattern])
    return out.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
        .filter { $0 != ProcessInfo.processInfo.processIdentifier }
}

func pkill(_ pattern: String, force: Bool = false) {
    // Never match ourselves: pgrep first, signal individually.
    for pid in pgrep(pattern) { kill(pid, force ? SIGKILL : SIGTERM) }
}

func portListeners(_ port: Int) -> [Int32] {
    let (_, out) = runTool("/usr/sbin/lsof", ["-i", ":\(port)", "-sTCP:LISTEN", "-t"])
    return out.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
}

/// Poll until no process matches `pattern`, up to `timeout` seconds.
@discardableResult
func waitGone(_ pattern: String, timeout: Int) -> Bool {
    for _ in 0..<timeout {
        if pgrep(pattern).isEmpty { return true }
        Thread.sleep(forTimeInterval: 1)
    }
    return pgrep(pattern).isEmpty
}

func probeHealth(timeout: TimeInterval = 2) -> Bool {
    guard let url = URL(string: "http://127.0.0.1:9500/health") else { return false }
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        ok = (resp as? HTTPURLResponse)?.statusCode == 200
        sem.signal()
    }.resume()
    sem.wait()
    return ok
}

/// Minimal .env parser: KEY=VALUE lines, ignores comments/blank; strips one
/// layer of matching quotes. No interpolation (matches what our .env files use).
func parseEnvFile(_ path: String) -> [String: String] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
        var line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("#") || line.isEmpty { continue }
        if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
        guard let eq = line.firstIndex(of: "=") else { continue }
        let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
        var val = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
        if val.count >= 2, (val.hasPrefix("\"") && val.hasSuffix("\"")) || (val.hasPrefix("'") && val.hasSuffix("'")) {
            val = String(val.dropFirst().dropLast())
        }
        if !key.isEmpty { out[key] = val }
    }
    return out
}

// MARK: - Previous-instance + stale-process cleanup

let stateDir = "\(home)/.sinain/supervisor"
try? fm.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
let pidPath = "\(stateDir)/sinaind.pid"
let statePath = "\(stateDir)/state.json"

// Take over from a previous sinaind: its shutdown handler stops its children.
if let prevStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
   let prev = Int32(prevStr.trimmingCharacters(in: .whitespacesAndNewlines)),
   prev != ProcessInfo.processInfo.processIdentifier, kill(prev, 0) == 0 {
    slog("previous sinaind (pid \(prev)) running — asking it to shut down")
    kill(prev, SIGTERM)
    for _ in 0..<30 {
        if kill(prev, 0) != 0 { break }
        Thread.sleep(forTimeInterval: 1)
    }
    if kill(prev, 0) == 0 {
        slog("previous sinaind did not exit — SIGKILL")
        kill(prev, SIGKILL)
        Thread.sleep(forTimeInterval: 1)
    }
}
try? "\(ProcessInfo.processInfo.processIdentifier)\n".write(toFile: pidPath, atomically: true, encoding: .utf8)

// Same sweep as start.sh kill_stale: previous services from any launcher,
// including setproctitle-renamed daemons and core-orphaned helpers.
let stalePatterns = [
    "sinain_hud.app/Contents/MacOS/sinain_hud",
    "flutter run -d macos",
    "python3 -m sense_client",
    "Python -m sense_client",
    "sinain-chat-agent/sidecar.py",
    "sinain-sense", "sinain-kg", "sinain-memoryd", "sinain-chat",
    "tools/sck-capture/sck-capture",
    "sinain-memory/kg_daemon.py",
    "sinain-memory/memoryd.py",
    "whisper-server.*\\.sinain/models",
    "tsx.*src/index.ts",
    "sinain-core/dist/index.js",
]

func killStale() {
    var killed = false
    for pat in stalePatterns where !pgrep(pat).isEmpty {
        pkill(pat)
        killed = true
    }
    for pid in portListeners(9500) { kill(pid, SIGTERM); killed = true }
    if killed {
        // Grace before -9: a core mid-distillation (or an orphaned
        // knowledge_integrator child) must not die mid-RocksDB-write.
        if !waitGone("tsx.*src/index.ts", timeout: 25) { slog("stale core did not exit within 25s — forcing") }
        waitGone("sinain-core/dist/index.js", timeout: 5)
        if !waitGone("sinain-memory/(knowledge_integrator|reconstruct|session_distiller)", timeout: 20) {
            slog("stale distillation child did not exit within 20s — forcing")
        }
        for pat in ["sinain_hud.app/Contents/MacOS/sinain_hud", "sck-capture", "tsx.*src/index.ts", "sinain-core/dist/index.js"] {
            pkill(pat, force: true)
        }
        for pid in portListeners(9500) { kill(pid, SIGKILL) }
        Thread.sleep(forTimeInterval: 1)
        slog("killed stale processes from previous run")
    }
}

// MARK: - Child environment

var childEnv = ProcessInfo.processInfo.environment
childEnv["SINAIN_SESSION_LOG"] = logPath
childEnv.removeValue(forKey: "SINAIND_CHILD")

if flagParanoid {
    let paranoidEnv = parseEnvFile("\(root)/.env.paranoid")
    if paranoidEnv.isEmpty {
        slog("FATAL: --paranoid but \(root)/.env.paranoid missing or empty")
        exit(1)
    }
    for (k, v) in paranoidEnv { childEnv[k] = v }
    slog("PARANOID MODE — fully offline, zero cloud APIs")
}

// Privacy preset → sense_client vars (core loads PRIVACY_MODE via dotenv,
// which children don't inherit — mirror start.sh's mapping).
var privacyMode = childEnv["PRIVACY_MODE"] ?? ""
if privacyMode.isEmpty {
    for envFile in ["\(root)/sinain-core/.env", "\(root)/.env"] {
        if let v = parseEnvFile(envFile)["PRIVACY_MODE"], !v.isEmpty { privacyMode = v; break }
    }
}
if privacyMode.isEmpty { privacyMode = "off" }
let (ocrPrivacy, imgPrivacy): (String, String) = {
    switch privacyMode {
    case "paranoid": return ("none", "none")
    case "strict": return ("summary", "none")
    case "standard": return ("redacted", "none")
    default: return ("full", "full")
    }
}()
if childEnv["PRIVACY_OCR_OPENROUTER"] == nil { childEnv["PRIVACY_OCR_OPENROUTER"] = ocrPrivacy }
if childEnv["PRIVACY_IMAGES_OPENROUTER"] == nil { childEnv["PRIVACY_IMAGES_OPENROUTER"] = imgPrivacy }

// Capture ownership: sense_client owns sck-capture (video AND audio); core
// reads audio from the FIFO. With --no-sense there is NO capture of any kind.
if flagNoSense {
    if childEnv["AUDIO_AUTO_START"] == nil { childEnv["AUDIO_AUTO_START"] = "false" }
} else {
    if childEnv["SINAIN_CAPTURE_OWNER"] == nil { childEnv["SINAIN_CAPTURE_OWNER"] = "sense" }
    if childEnv["AUDIO_CAPTURE_CMD"] == nil { childEnv["AUDIO_CAPTURE_CMD"] = "fifo" }
}

// MARK: - Child specs

struct ChildSpec {
    let name: String        // supervisor identity + state.json key
    let tag: String         // log prefix, matches pipe_log tags
    let executable: String
    let arguments: [String]
    let cwd: String
    let critical: Bool      // core: gates sibling startup, health-probed
    // restartOnCleanExit=false: exit 0 is a deliberate stop, leave it down.
    // The overlay quits cleanly on purpose (user quit, first-run wizard
    // relaunch, self-update restart — the latter two `open` their own
    // successor); respawning it produced a second instance every time.
    var restartOnCleanExit: Bool = true
}

func which(_ name: String) -> String? {
    let paths = (childEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin").split(separator: ":")
    for p in paths {
        let cand = "\(p)/\(name)"
        if fm.isExecutableFile(atPath: cand) { return cand }
    }
    return nil
}

func buildSpecs() -> [ChildSpec] {
    var specs: [ChildSpec] = []
    let coreDir = "\(root)/sinain-core"

    if flagDev {
        guard let npm = which("npm") else { slog("FATAL: npm not found in PATH"); exit(1) }
        specs.append(ChildSpec(name: "core", tag: "core", executable: npm,
                               arguments: ["run", "dev"], cwd: coreDir, critical: true))
    } else {
        guard let node = which("node") else { slog("FATAL: node not found in PATH"); exit(1) }
        let dist = "\(coreDir)/dist/index.js"
        if !fm.fileExists(atPath: dist) {
            guard let npm = which("npm") else { slog("FATAL: npm not found in PATH"); exit(1) }
            slog("core dist/ missing — building once (npm run build)")
            let (status, _) = runTool(npm, ["run", "build"], cwd: coreDir)
            guard status == 0, fm.fileExists(atPath: dist) else {
                slog("FATAL: npm run build failed (exit \(status)) — run it manually in sinain-core/")
                exit(1)
            }
        }
        specs.append(ChildSpec(name: "core", tag: "core", executable: node,
                               arguments: [dist], cwd: coreDir, critical: true))
    }

    if !flagNoSense {
        if let py = which("python3") {
            specs.append(ChildSpec(name: "sense", tag: "sense", executable: py,
                                   arguments: ["-m", "sense_client"], cwd: root, critical: false))
        } else {
            slog("python3 not found — sense_client skipped")
        }
    }

    let chatDir = "\(root)/sinain-chat-agent"
    if fm.fileExists(atPath: "\(chatDir)/sidecar.py") {
        let venvPy = "\(chatDir)/.venv/bin/python"
        let py = fm.isExecutableFile(atPath: venvPy) ? venvPy : which("python3")
        if let py = py {
            specs.append(ChildSpec(name: "chat", tag: "chat", executable: py,
                                   arguments: ["sidecar.py"], cwd: chatDir, critical: false))
        }
    }

    if !flagNoOverlay {
        let products = "\(root)/overlay/build/macos/Build/Products"
        let appBins = ["\(products)/Release/sinain_hud.app/Contents/MacOS/sinain_hud",
                       "\(products)/Debug/sinain_hud.app/Contents/MacOS/sinain_hud"]
        if !flagDev, let appBin = appBins.first(where: { fm.isExecutableFile(atPath: $0) }) {
            specs.append(ChildSpec(name: "overlay", tag: "overlay", executable: appBin,
                                   arguments: [], cwd: "\(root)/overlay", critical: false,
                                   restartOnCleanExit: false))
        } else if let flutter = which("flutter") {
            specs.append(ChildSpec(name: "overlay", tag: "overlay", executable: flutter,
                                   arguments: ["run", "-d", "macos"], cwd: "\(root)/overlay", critical: false,
                                   restartOnCleanExit: false))
        } else {
            slog("no built overlay app and flutter not found — overlay skipped")
        }
    }

    return specs
}

// MARK: - Supervision

let supQ = DispatchQueue(label: "sinaind.supervisor")
let backoffSteps: [TimeInterval] = [1, 2, 5, 15, 60]
let healthyResetUptime: TimeInterval = 300
// A child that keeps dying instantly is broken, not unlucky (missing venv,
// bad binary): stop retrying after this many consecutive sub-5s lives so the
// failure is one loud state, not an eternal 60s crash-loop in the log.
// Critical children (core) are exempt — the stack is useless without them.
let giveUpAfterFastFails = 8
let fastFailUptime: TimeInterval = 5

final class Child {
    let spec: ChildSpec
    var process: Process?
    var startedAt: Date?
    var restarts = 0
    var fastFails = 0
    var lastExit: Int32?
    var state = "stopped"   // running | backoff | failed | stopped
    var lineBuffers: [ObjectIdentifier: Data] = [:]

    init(spec: ChildSpec) { self.spec = spec }
}

var children: [Child] = []
var shuttingDown = false
var coreProbeFails = 0

func writeState() {
    var childMap: [String: Any] = [:]
    for c in children {
        childMap[c.spec.name] = [
            "state": c.state,
            "pid": c.process?.processIdentifier ?? 0,
            "restarts": c.restarts,
            "lastExit": c.lastExit.map(Int.init) as Any,
        ]
    }
    let doc: [String: Any] = [
        "pid": ProcessInfo.processInfo.processIdentifier,
        "updated": iso.string(from: Date()),
        "root": root,
        "mode": flagDev ? "dev" : "prod",
        "children": childMap,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys]) {
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}

/// Attach a line-splitting reader that forwards child output to the log.
func attachReader(_ child: Child, _ handle: FileHandle) {
    let key = ObjectIdentifier(handle)
    child.lineBuffers[key] = Data()
    handle.readabilityHandler = { h in
        let data = h.availableData
        if data.isEmpty {
            h.readabilityHandler = nil
            supQ.async {
                if var rest = child.lineBuffers.removeValue(forKey: key), !rest.isEmpty {
                    if rest.last == 0x0D { rest.removeLast() }
                    if let line = String(data: rest, encoding: .utf8), !line.isEmpty {
                        logLine(child.spec.tag, line)
                    }
                }
            }
            return
        }
        supQ.async {
            var buf = child.lineBuffers[key] ?? Data()
            buf.append(data)
            while let nl = buf.firstIndex(of: 0x0A) {
                var lineData = buf.subdata(in: buf.startIndex..<nl)
                if lineData.last == 0x0D { lineData.removeLast() }
                buf.removeSubrange(buf.startIndex...nl)
                if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                    logLine(child.spec.tag, line)
                }
            }
            child.lineBuffers[key] = buf
        }
    }
}

/// Must run on supQ.
func spawn(_ child: Child) {
    guard !shuttingDown else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: child.spec.executable)
    p.arguments = child.spec.arguments
    p.currentDirectoryURL = URL(fileURLWithPath: child.spec.cwd)
    p.environment = childEnv
    p.standardInput = FileHandle.nullDevice
    let outPipe = Pipe(), errPipe = Pipe()
    p.standardOutput = outPipe
    p.standardError = errPipe
    attachReader(child, outPipe.fileHandleForReading)
    attachReader(child, errPipe.fileHandleForReading)
    p.terminationHandler = { proc in
        supQ.async { onExit(child, status: proc.terminationStatus) }
    }
    do {
        try p.run()
    } catch {
        slog("\(child.spec.name): failed to launch (\(error.localizedDescription))")
        child.fastFails += 1
        if !child.spec.critical && child.fastFails >= giveUpAfterFastFails {
            child.state = "failed"
            slog("\(child.spec.name): FAILED — cannot launch, giving up (fix the cause, then restart sinaind)")
        } else {
            child.state = "stopped"
            scheduleRestart(child)
        }
        writeState()
        return
    }
    child.process = p
    child.startedAt = Date()
    child.state = "running"
    slog("\(child.spec.name): started pid \(p.processIdentifier) (\(child.spec.executable) \(child.spec.arguments.joined(separator: " ")))")
    writeState()
}

/// Must run on supQ.
func onExit(_ child: Child, status: Int32) {
    child.process = nil
    child.lastExit = status
    if shuttingDown {
        child.state = "stopped"
        writeState()
        return
    }
    let uptime = child.startedAt.map { Date().timeIntervalSince($0) } ?? 0
    if uptime > healthyResetUptime { child.restarts = 0 }
    child.fastFails = uptime < fastFailUptime ? child.fastFails + 1 : 0
    slog("\(child.spec.name): exited status \(status) after \(Int(uptime))s")
    if child.spec.critical { coreProbeFails = 0 }
    if status == 0 && !child.spec.restartOnCleanExit {
        child.state = "stopped"
        slog("\(child.spec.name): clean exit — not restarting (deliberate quit or self-relaunch; the app owns its successor)")
        writeState()
        return
    }
    if !child.spec.critical && child.fastFails >= giveUpAfterFastFails {
        child.state = "failed"
        slog("\(child.spec.name): FAILED — died instantly \(child.fastFails) times in a row, giving up (fix the cause, then restart sinaind)")
    } else {
        scheduleRestart(child)
    }
    writeState()
}

/// Must run on supQ.
func scheduleRestart(_ child: Child) {
    guard !shuttingDown else { return }
    let delay = backoffSteps[min(child.restarts, backoffSteps.count - 1)]
    child.restarts += 1
    child.state = "backoff"
    slog("\(child.spec.name): restarting in \(Int(delay))s (restart #\(child.restarts))")
    supQ.asyncAfter(deadline: .now() + delay) {
        guard !shuttingDown, child.process == nil else { return }
        spawn(child)
    }
}

/// TERM → bounded wait → KILL. Must run on supQ (blocks it briefly by design:
/// restarts should not race a shutdown-in-progress).
func stopProcess(_ child: Child, graceSeconds: Int) {
    guard let p = child.process, p.isRunning else { return }
    let pid = p.processIdentifier
    kill(pid, SIGTERM)
    for _ in 0..<(graceSeconds * 10) {
        if !p.isRunning { return }
        Thread.sleep(forTimeInterval: 0.1)
    }
    if p.isRunning {
        slog("\(child.spec.name): did not exit within \(graceSeconds)s — SIGKILL")
        kill(pid, SIGKILL)
    }
}

/// Health-probe-driven restart of a live-but-deaf core. Must run on supQ.
func restartCore(_ child: Child, reason: String) {
    slog("core: restarting (\(reason))")
    // Suppress the terminationHandler's own restart path: mark, stop, respawn.
    guard let p = child.process else { spawn(child); return }
    p.terminationHandler = nil
    stopProcess(child, graceSeconds: 25)
    child.process = nil
    child.restarts += 1
    coreProbeFails = 0
    spawn(child)
}

// MARK: - Shutdown

func shutdown(_ why: String) {
    supQ.async {
        guard !shuttingDown else { return }
        shuttingDown = true
        slog("shutting down (\(why))")
        // Overlay + non-critical first, core last: core may be waiting out an
        // in-flight distillation child that must not die mid-RocksDB-write.
        for c in children where !c.spec.critical { stopProcess(c, graceSeconds: 10) }
        for c in children where c.spec.critical { stopProcess(c, graceSeconds: 25) }
        // Orphan sweep: core-spawned helpers survive their parent.
        for pat in ["sinain-memory/kg_daemon.py", "sinain-memory/memoryd.py",
                    "whisper-server.*\\.sinain/models", "tools/sck-capture/sck-capture",
                    "sinain-sense", "sinain-kg", "sinain-memoryd"] {
            pkill(pat)
        }
        for c in children { c.state = "stopped" }
        writeState()
        try? fm.removeItem(atPath: pidPath)
        slog("all services stopped")
        logQ.sync { }   // flush
        exit(0)
    }
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigint.setEventHandler { shutdown("SIGINT") }
sigint.resume()
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { shutdown("SIGTERM") }
sigterm.resume()

// MARK: - Main

slog("sinaind starting — root=\(root) mode=\(flagDev ? "dev" : "prod") sense=\(!flagNoSense) overlay=\(!flagNoOverlay) paranoid=\(flagParanoid)")
slog("privacy: mode=\(privacyMode) ocr_openrouter=\(childEnv["PRIVACY_OCR_OPENROUTER"] ?? "?") images_openrouter=\(childEnv["PRIVACY_IMAGES_OPENROUTER"] ?? "?")")

killStale()

if !portListeners(9500).isEmpty {
    slog("FATAL: port 9500 still in use after cleanup")
    exit(1)
}

try? fm.createDirectory(atPath: "\(home)/.sinain/capture", withIntermediateDirectories: true)

children = buildSpecs().map(Child.init)
guard let core = children.first(where: { $0.spec.critical }) else {
    slog("FATAL: no core child configured")
    exit(1)
}

supQ.async {
    spawn(core)
    // Gate sibling startup on core health, like start.sh (paranoid startup is
    // slower: local-model distillation at boot).
    let timeout = Int(childEnv["SINAIN_HEALTH_TIMEOUT"] ?? "") ?? (flagParanoid ? 45 : 15)
    var healthy = false
    for _ in 0..<timeout {
        if probeHealth() { healthy = true; break }
        Thread.sleep(forTimeInterval: 1)
    }
    if healthy {
        slog("core: healthy on :9500")
    } else {
        slog("core: not healthy after \(timeout)s — starting siblings anyway (probe loop will restart core if it stays deaf)")
    }
    for c in children where !c.spec.critical { spawn(c) }
    writeState()
}

// Health monitor: a running core that stops answering /health is restarted
// after 3 consecutive failures (90s) — previously this state ("port bound,
// nobody home") persisted silently until a human noticed idle saves.
let probeTimer = DispatchSource.makeTimerSource(queue: supQ)
probeTimer.schedule(deadline: .now() + 60, repeating: 30)
probeTimer.setEventHandler {
    guard !shuttingDown else { return }
    guard let p = core.process, p.isRunning else { return }  // exit path handles dead core
    if probeHealth() {
        coreProbeFails = 0
    } else {
        coreProbeFails += 1
        slog("core: health probe failed (\(coreProbeFails)/3)")
        if coreProbeFails >= 3 { restartCore(core, reason: "health probe failed 3× while process alive") }
    }
    writeState()
}
probeTimer.resume()

dispatchMain()
