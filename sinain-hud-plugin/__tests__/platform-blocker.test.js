// ENG-05 — Friendly Windows/Linux blocker test (no actual Windows/Linux host required).
// Per CONTEXT.md D-03, the guard reads SINAIN_FAKE_PLATFORM || os.platform().
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.resolve(__dirname, "..", "launcher.js");

function runLauncher(envOverride, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, "start"], {
      env: { ...process.env, ...envOverride },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("SINAIN_FAKE_PLATFORM=win32 prints friendly Windows blocker and exits 0", async () => {
  const { code, stdout } = await runLauncher({ SINAIN_FAKE_PLATFORM: "win32" }, 1500);
  assert.equal(code, 0, "expected exit code 0; got " + code);
  assert.match(stdout, /macOS-only for this launch/i);
  assert.match(stdout, /Windows support is in progress/i);
});

test("SINAIN_FAKE_PLATFORM=linux prints friendly Linux blocker and exits 0", async () => {
  const { code, stdout } = await runLauncher({ SINAIN_FAKE_PLATFORM: "linux" }, 1500);
  assert.equal(code, 0, "expected exit code 0; got " + code);
  assert.match(stdout, /macOS-only for this launch/i);
  assert.match(stdout, /Linux support is planned/i);
});

test("SINAIN_FAKE_PLATFORM=darwin (or unset on darwin) does NOT trigger the blocker", async () => {
  // Run with an explicit darwin spoof so this works on any host.
  // The process may be killed by our timer (SIGKILL) OR exit naturally due to
  // preflight errors on the test host — either way the blocker must NOT fire.
  const { stdout } = await runLauncher({ SINAIN_FAKE_PLATFORM: "darwin" }, 800);
  // The key invariant: no friendly blocker message in stdout.
  assert.doesNotMatch(stdout, /macOS-only for this launch/i,
    "guard should be a no-op on darwin — blocker text must not appear");
});
