# Profiling & Metrics

Sinain HUD runs three cooperating processes. The profiling system collects runtime
metrics from all three and surfaces them through a single HTTP endpoint.

```
 ┌──────────────┐  POST /profiling/sense (60 s)   ┌──────────────┐
 │ sense_client │ ──────────────────────────────►  │              │
 │  (Python)    │                                  │  sinain-core │
 └──────────────┘                                  │  (Node.js)   │
                                                   │              │
 ┌──────────────┐  WS { type:"profiling" } (30 s)  │  GET /health │
 │   overlay    │ ──────────────────────────────►  │  ──► JSON    │
 │  (Flutter)   │                                  │              │
 └──────────────┘                                  └──────────────┘
                                                       ▲
                                                       │ self-sample
                                                       │ every 10 s
```

- **sinain-core** samples its own process stats every 10 seconds.
- **sense_client** POSTs a snapshot to `/profiling/sense` every 60 seconds.
- **overlay** sends a `{ type: "profiling" }` WebSocket message every 30 seconds.

All three snapshots are returned together under the `profiling` key of `GET /health`.

---

## Quick Start

```bash
curl -s localhost:9500/health | jq .profiling
```

---

## Full Response Shape

```jsonc
{
  "core": {
    "rssMb": 85.2,            // Resident Set Size (MB)
    "heapUsedMb": 42.1,       // V8 heap in use (MB)
    "heapTotalMb": 65.0,      // V8 heap allocated (MB)
    "cpuUserMs": 12340,        // Cumulative user-mode CPU (ms)
    "cpuSystemMs": 4560,       // Cumulative system-mode CPU (ms)
    "uptimeS": 3600,           // Seconds since profiler.start()
    "ts": 1706000000000,       // Unix ms when sampled

    "gauges": {                // Point-in-time values (latest write wins)
      "buffer.feed": 42,
      "buffer.sense": 12,
      "ws.clients": 1,
      "audio.accumulatorKb": 128,
      "audio.lastChunkKb": 64,
      "transcription.pending": 1,
      "agent.totalCalls": 17,
      "escalation.pendingSpawns": 0
    },

    "timers": {                // Cumulative timing stats
      "transcription.call": {
        "count": 50,
        "totalMs": 75000,
        "lastMs": 1420,
        "maxMs": 3200
      },
      "agent.contextBuild": { "count": 17, "totalMs": 85, "lastMs": 5, "maxMs": 12 },
      "agent.llmCall":       { "count": 17, "totalMs": 51000, "lastMs": 2800, "maxMs": 4500 },
      "escalation.rpc":      { "count": 3,  "totalMs": 9600,  "lastMs": 3100, "maxMs": 3500 }
    }
  },

  "sense": {                   // null until first POST received
    "rssMb": 120.5,
    "uptimeS": 3590,
    "ts": 1706000000000,
    "extra": {
      "capturesOk": 2150,
      "eventsSent": 87,
      "eventsGated": 1940,
      "detectAvgMs": 4.2,
      "ocrAvgMs": 18.7,
      "sendAvgMs": 12.3
    }
  },

  "overlay": {                 // null until first WS message received
    "rssMb": 48,
    "uptimeS": 3550,
    "ts": 1706000000000
  },

  "sampledAt": 1706000000000   // Unix ms when getSnapshot() was called
}
```

---

## Gauges Reference

Gauges are point-in-time values. Each `profiler.gauge(name, value)` call overwrites the previous value.

| Gauge | Subsystem | What it measures | Update frequency |
|---|---|---|---|
| `buffer.feed` | core (index.ts) | Number of items in the feed ring buffer | Every 10 s |
| `buffer.sense` | core (index.ts) | Number of events in the sense ring buffer | Every 10 s |
| `ws.clients` | core (index.ts) | Connected overlay WebSocket clients | Every 10 s |
| `audio.accumulatorKb` | audio/pipeline.ts | Raw PCM data buffered before next chunk emit (KB) | On every `stdout` data event |
| `audio.lastChunkKb` | audio/pipeline.ts | Size of the last emitted audio chunk (KB) | On each chunk emit |
| `transcription.pending` | audio/transcription.ts | In-flight transcription API requests (0–3) | On request start/end |
| `agent.totalCalls` | agent/loop.ts | Cumulative number of agent analysis ticks | After each successful tick |
| `escalation.pendingSpawns` | escalation/escalator.ts | Number of spawn tasks awaiting completion | On spawn start/finish |

---

## Timers Reference

Timers accumulate across the process lifetime. Each `profiler.timerRecord(name, durationMs)` call updates `count`, `totalMs`, `lastMs`, and `maxMs`.

| Timer | Subsystem | What it measures |
|---|---|---|
| `transcription.call` | audio/transcription.ts | Duration of one OpenRouter transcription API round-trip |
| `agent.contextBuild` | agent/loop.ts | Time to assemble the context window from buffers |
| `agent.llmCall` | agent/loop.ts | Duration of one agent LLM analysis call |
| `escalation.rpc` | escalation/escalator.ts | Duration of one escalation WS RPC round-trip |

To derive the average from any timer:

```
avg = totalMs / count
```

---

## Useful `jq` One-Liners

**Memory across all processes:**

```bash
curl -s localhost:9500/health | jq '{
  core: .profiling.core.rssMb,
  sense: .profiling.sense.rssMb,
  overlay: .profiling.overlay.rssMb
}'
```

**Find the slowest operation (highest maxMs):**

```bash
curl -s localhost:9500/health | jq '
  [.profiling.core.timers | to_entries[] | {name: .key, maxMs: .value.maxMs}]
  | sort_by(-.maxMs) | .[0]'
```

**Check if sense_client is reporting:**

```bash
curl -s localhost:9500/health | jq '.profiling.sense // "not reporting"'
```

**Average LLM latency:**

```bash
curl -s localhost:9500/health | jq '
  .profiling.core.timers["agent.llmCall"]
  | "\(.totalMs / .count | round)ms avg over \(.count) calls"'
```

**All timer averages at a glance:**

```bash
curl -s localhost:9500/health | jq '
  [.profiling.core.timers | to_entries[]
   | {name: .key, avgMs: (.value.totalMs / .value.count | round), count: .value.count}]'
```

**Watch metrics refreshing every 5 s:**

```bash
watch -n5 'curl -s localhost:9500/health | jq .profiling.core.gauges'
```

**sense_client pipeline breakdown:**

```bash
curl -s localhost:9500/health | jq '.profiling.sense.extra'
```

---

## Reporting Intervals

| Process | Interval | Transport | Handler |
|---|---|---|---|
| sinain-core | 10 s | Self-sample via `setInterval` | `profiler.sampleCore()` |
| sense_client | 60 s | HTTP POST `/profiling/sense` | `server.ts` → `profiler.reportSense()` |
| overlay | 30 s | WS `{ type: "profiling" }` | `ws-handler.ts` → `profiler.reportOverlay()` |

A `null` value for `sense` or `overlay` means the process has not yet sent its first snapshot — either it hasn't started, it crashed, or it can't reach sinain-core.

---

## Troubleshooting

### `sense` is `null`

1. Is sense_client running? Check `ps aux | grep sense_client`.
2. Can it reach sinain-core? Try `curl -s localhost:9500/health` from the same host.
3. Has it been running for at least 60 seconds? The first report is sent after the first stats interval.
4. Check sense_client logs for HTTP POST errors.

### `overlay` is `null`

1. Is the overlay app running and connected? Check `ws.clients` gauge — it should be ≥ 1.
2. Has it been running for at least 30 seconds?
3. Check overlay debug logs for WebSocket connection errors.

### Stale timestamps

Compare `ts` fields against `sampledAt`. If `ts` is significantly older than `sampledAt`, the reporting process may have stalled or lost connectivity.

### High `transcription.pending`

A value stuck at 3 (the max concurrent limit) means transcription requests are backed up. Check OpenRouter API status and network connectivity.

### High `audio.accumulatorKb`

Large accumulator values mean raw PCM data is piling up between chunk emissions. This is normal during chunk intervals but should reset to 0 after each emit.

---

## Adding New Metrics

### Adding a gauge

Call `profiler.gauge()` anywhere you have access to the profiler instance:

```typescript
// In your subsystem file
profiler.gauge("mySubsystem.myMetric", currentValue);
```

The gauge appears automatically under `core.gauges` in the next `/health` response.

### Adding a timer

For manual timing:

```typescript
const start = Date.now();
await doWork();
profiler.timerRecord("mySubsystem.myOperation", Date.now() - start);
```

Or wrap an async call with automatic timing:

```typescript
const result = await profiler.timeAsync("mySubsystem.myOperation", () => doWork());
```

Both produce a `TimerStats` entry under `core.timers` with `count`, `totalMs`, `lastMs`, and `maxMs`.

### Adding sense_client extras

In `sense_client/__main__.py`, add a key to the `extra` dict in the profiling snapshot:

```python
"extra": {
    ...existing fields...,
    "myNewMetric": my_value,
},
```

It will appear under `sense.extra` in the next reporting cycle.
