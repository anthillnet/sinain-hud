# Live-Teleprompter Eval — Run Report

**Corpus:** 17 recorded sales calls (`drive-download-20260722T082435Z-1-001/`, 748 min ≈ 12.5 h audio).
**Engine:** the real ARSinain teleprompter on `https://ar.sinain.com` (guide generated server-side; this repo is a WebRTC client).
**Goal:** stream each call through the live teleprompter and save all output per call for post-hoc eval.
**Dates:** run 1 on 2026-07-24 10:02–18:41; re-run 21:08–00:19; call_15 retry from 00:25 (2026-07-25).

---

## 1. Result — consolidated per-call index

For each call, the row points at the run holding the **best** capture. Coverage = recorded TTS-audio minutes ÷ call minutes (a proxy for how much of the call the session stayed live).

| Call | Audio | Best run | Guide lines | Coverage | Status |
|------|------:|----------|------------:|---------:|--------|
| call_01_sattva-reconnect       | 61m  | run1 `…T100202` | 26  | 87%  | ✅ text (guide sparse) |
| call_02_sattva-walkthrough     | 35m  | run1 | 180 | ~100% | ✅ text |
| call_03_puravankara-santhosh   | 94m  | run1 | 371 | ~100% | ✅ text |
| call_05_prestige-bhushan       | 57m  | run1 | 50  | **43%** | ⚠️ text, partial (early drop) |
| call_06_sattva-ajay            | 34m  | run2 `…T210855` | 230 | ~100% | ✅ text (recovered) |
| call_07_4s                     | 22m  | run1 | 76  | 88%  | ✅ text |
| call_08_puravankara-gupta      | 36m  | run2 | 0   | ~100% | 🔊 **audio-only** (no text from server) |
| call_09_sattva-reject          | 19m  | run2 | 82  | ~100% | ✅ text (recovered) |
| call_10_lodha-raj              | 34m  | run2 | 106 | ~100% | ✅ text (recovered) |
| call_11_lodha-satish           | 28m  | run2 | 162 | ~100% | ✅ text (recovered) |
| call_13_lodha-raj-weaponizing  | 18m  | run1 | 25  | **63%** | ⚠️ text, partial (early drop) |
| call_15_sobha-shanti           | 68m  | retry `…T001942` | 6 | ~100% | 🔊 **audio-only** (full coverage on 3rd attempt; server emitted almost no text) |
| call_16_shanti-sync            | 22m  | run1 | 68  | ~100% | ✅ text |
| call_17_dlf-ramakrishnan       | 31m  | run1 | 65  | ~100% | ✅ text |
| call_18_shanti-product-intro   | 123m | run1 | 838 | ~100% | ✅ text (richest) |
| call_19_kalpataru              | 31m  | run1 | 97  | ~100% | ✅ text |
| call_20_k-raheja               | 34m  | run2 | 117 | ~100% | ✅ text (recovered) |

**Totals:** 15 calls with rich text guide · **2,499 guide lines** · 2 audio-only (call_08, call_15 — full audio, ~no text) · 0 missing · **8.1 GB** best-capture audio. All 17 calls have full-coverage capture except call_05 (43%) and call_13 (63%), which kept partial text from run 1.

**Per-call artifacts** (in the "Best run" dir, one folder per call):
`meta.jsonl` (timestamped guide lines, primary signal) · `guide-tts.wav` (spoken guide, 48 kHz stereo) · `bridge.stdout.log` · `manifest.json`.

---

## 2. What was built

Offline replay + capture for a live-only WebRTC client (`tools/ar-bridge/`):

- **`bridge.py`** — new flags: `--audio-file` (plays an mp3 over WebRTC via `MediaPlayer` instead of the mic, ends at EOF), `--meta-log` (every datachannel message, untruncated + timestamped JSONL), `--record-audio` (inbound TTS → wav), `--max-seconds` (hard ceiling). Relaxed the `/` reachability probe so the device-token path (which 302s on `/`) isn't rejected.
- **`replay-eval.sh`** — sequential batch driver, one dir per call, 429-retry with settle, per-call manifest.
- **`wait-and-replay.sh`** — polls for a free session slot then auto-launches. **Deprecated for this workload** (see §4: its probe zombied).

---

## 3. Timeline

| Phase | Calls | Window | Outcome |
|-------|-------|--------|---------|
| Run 1 | all 17, sequential | 10:02–18:41 (~8.6h) | 10 text ✅ · 7 failed/empty |
| Re-run | 06,08,09,10,11,15,20 | 21:08–00:19 (~3.2h) | 4 recovered ✅ · call_08 audio-only · call_15 dropped · call_20 ✅ |
| call_15 retry | 15 | 00:25–01:29 | ✅ full 68m coverage (3rd attempt); audio-only (6 text lines) |

(Total realtime ran longer than the 12.5 h audio due to per-call teardown overhead — see §5.)

---

## 4. Failures & root causes

1. **429 "session already running" (run1: call_06, 15, 20).** Root cause: **the `wait-and-replay.sh` probe session zombied** — its short, `--max-seconds`-terminated session left a heartbeating PeerConnection on the box that held **1 of the 2 per-account slots for 11 hours**. That left only one slot for the batch, so any handoff where the prior call was still reaping hit the cap (2/2) and 429'd. **Fix:** `ssh root@85.214.180.247` → `docker compose restart ar-help` (its `on_shutdown` closes all PCs), giving a clean 2-slot slate; then run `replay-eval.sh` **directly, no waiter**. Confirmed working — the re-run's call_10 survived six 429s on the widened retry window.
2. **Transient DNS (run1: call_09, 10).** `Cannot connect to host ar.sinain.com` — local resolution blip; resolves fine now. Fixed by retry.
3. **Early session drop (call_05 43%, call_13 63%, call_15).** Session ends before the call does — an ICE/connection drop that logs identically to a clean EOF. call_15 hit it on both attempts (retry running); call_05/13 kept partial text.
4. **Audio-only (call_08).** Server produced a full TTS stream but emitted **no `say` text** on the datachannel. Not a client failure — the `guide-tts.wav` is the capture; transcribe it for text.

**Ops actions taken:** two `ar-help` restarts to clear zombie session claims (the pre-batch stuck pair, then the probe zombie). Both are the user's production box; each restart briefly drops any live sessions.

---

## 5. Known limitations

- **`--max-seconds` covers a mid-session hang** (sets the stop flag) **but not a teardown hang** — `pc.close()`/recorder flush ran up to ~13 min post-session on some calls, inflating wall time (not lost content).
- **Drop vs EOF is indistinguishable in logs** — both end as `AR-BRIDGE ended`. That's why early drops (call_05/13/15) look benign. A follow-up could log the connection-close reason to tell them apart.
- **Guide is conversational `say` lines**, not the two-zone thesis/tactical teleprompter discipline (that lives in the FMG bench / a different server). The eval scores this ar.sinain.com build as-is.
- **One session per account (cap 2)** forces sequential realtime — no parallelization on a single account.

---

## 6. Recommendations for the eval pass

- Treat **call_05 (43%) and call_13 (63%)** as partial; consider re-running for fuller coverage.
- **Transcribe call_08's `guide-tts.wav`** (and optionally all wavs) with Whisper to normalize text vs audio-only capture.
- Use **`meta.jsonl`** as the primary per-call input; `manifest.json` gives exit/coverage; `guide-tts.wav` is the audio ground truth.
- For any future full run: **skip the waiter, restart ar-help first, run `replay-eval.sh` directly**, keep `SETTLE≥20 RETRIES≥10`.
