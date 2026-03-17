# Privacy Protection System

Sinain HUD captures audio, screen content, and behavioral metadata to provide real-time assistance. The privacy protection system gives you fine-grained control over what data is shared with each destination — from in-memory buffers to cloud APIs.

---

## 1. Data Types

Six categories of captured data flow through the privacy system:

| Type | Description | Sources |
|---|---|---|
| `audio_transcript` | Text transcribed from system audio | Audio pipeline |
| `screen_ocr` | Text extracted from screen frames | Screen capture pipeline |
| `screen_images` | JPEG frames from screen capture | Screen capture pipeline |
| `window_titles` | Active window and application names | Screen capture pipeline |
| `credentials` | Auth tokens, passwords, API keys detected by pattern matching | Derived from OCR/audio |
| `metadata` | Timing, app categories, error rates, session markers | Inferred from all sources |

`credentials` is a derived type — it refers to content that matched a sensitive pattern. It is stripped from its source field and can be reported as a summary count (e.g. `[CREDENTIAL DETECTED: 1]`).

---

## 2. Destinations

| Destination | Description |
|---|---|
| `local_buffer` | In-memory ring buffers in sinain-core — never leaves the machine |
| `local_llm` | Local model endpoint (e.g. Ollama) — stays on device |
| `triple_store` | Local SQLite knowledge store. Entity text is embedded via OpenRouter, so this level also bounds what reaches OpenRouter for embedding |
| `openrouter` | OpenRouter cloud API — transcription and agent analysis |
| `agent_gateway` | Agent gateway (e.g. OpenClaw) — receives escalation payloads |

---

## 3. Sharing Levels

Each data type × destination cell takes one of four levels:

| Level | Meaning | What is sent |
|---|---|---|
| `full` | Send as-is | Original content |
| `redacted` | Apply pattern library, send cleaned text | `"…account ending [REDACTED]…"` |
| `summary` | Send length/count/category, no content | `"[AUDIO: 42 words, ~8s]"` |
| `none` | Do not send | `"[OMITTED]"` or field absent |

---

## 4. Privacy Matrix

The full matrix of sharing levels per data type per destination. Configured via `PRIVACY_<TYPE>_<DEST>` environment variables (see §6).

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
──────────────────────────────────────────────────────────────────────────────────────────
audio_transcript    full           redacted     redacted       redacted     redacted
screen_ocr          redacted       redacted     redacted       redacted     redacted
screen_images       full           none         none           none         none
window_titles       full           summary      summary        summary      none
credentials         none           none         none           none         none
metadata            full           full         full           summary      summary
```

The values above reflect the `standard` preset. See §5 for all presets.

### Triple Store and Embedding

When `triple_store` level is `full` or `redacted`, entity text is sent to OpenRouter for embedding. The `openrouter` level takes precedence — if `PRIVACY_<TYPE>_OPENROUTER=none`, the embedding step is skipped for that data type (or falls back to a local model only).

Each entity in the triple store carries a `source_type` attribute. When Graph RAG retrieval injects context into a prompt or escalation payload, only entities whose `source_type` resolves to ≥ `summary` for the target destination are included. Entities resolving to `redacted` have their content attributes redacted before injection; entities resolving to `none` are excluded entirely.

---

## 5. Preset Modes

Set `PRIVACY_MODE` to apply a named preset. Individual `PRIVACY_<TYPE>_<DEST>` variables override the preset.

### `standard` — Recommended default

Credentials and images are never sent to cloud endpoints. Audio and OCR are redacted before leaving the machine for any cloud destination.

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
audio_transcript    full           redacted     redacted       redacted     redacted
screen_ocr          redacted       redacted     redacted       redacted     redacted
screen_images       full           none         none           none         none
window_titles       full           summary      summary        summary      none
credentials         none           none         none           none         none
metadata            full           full         full           summary      summary
```

### `strict` — No verbatim content to cloud

Audio and OCR are summarized (length/category only) before reaching any cloud API. The agent gateway receives no content — only metadata summaries.

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
audio_transcript    redacted       redacted     summary        summary      none
screen_ocr          redacted       redacted     summary        summary      none
screen_images       full           none         none           none         none
window_titles       summary        summary      none           none         none
credentials         none           none         none           none         none
metadata            full           full         full           summary      none
```

Note: analysis quality degrades in `strict` mode — the agent receives summaries rather than content.

### `paranoid` — Local only, no external transmission

No data of any kind is sent to any cloud endpoint. Requires a local model for transcription (e.g. Whisper.cpp or faster-whisper) and a local LLM (Ollama) for analysis. The triple store stores only metadata entities; embedding is local-only.

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
audio_transcript    redacted       redacted     none           none         none
screen_ocr          redacted       redacted     none           none         none
screen_images       none           none         none           none         none
window_titles       summary        summary      none           none         none
credentials         none           none         none           none         none
metadata            full           full         full           none         none
```

### `off` — Development / debugging

All data flows without filtering. Use only in local-only, non-production environments.

---

## 6. Configuration

### Preset

```env
PRIVACY_MODE=standard   # standard | strict | paranoid | off
```

### Individual overrides

Individual variables follow the pattern `PRIVACY_<TYPE>_<DEST>` and override the preset for that cell.

```env
# Audio
PRIVACY_AUDIO_LOCAL_BUFFER=full
PRIVACY_AUDIO_LOCAL_LLM=redacted
PRIVACY_AUDIO_TRIPLE_STORE=redacted
PRIVACY_AUDIO_OPENROUTER=redacted
PRIVACY_AUDIO_AGENT_GATEWAY=redacted

# Screen OCR
PRIVACY_OCR_LOCAL_BUFFER=redacted
PRIVACY_OCR_LOCAL_LLM=redacted
PRIVACY_OCR_TRIPLE_STORE=redacted
PRIVACY_OCR_OPENROUTER=redacted
PRIVACY_OCR_AGENT_GATEWAY=redacted

# Screen images
PRIVACY_IMAGES_LOCAL_BUFFER=full
PRIVACY_IMAGES_LOCAL_LLM=none
PRIVACY_IMAGES_TRIPLE_STORE=none
PRIVACY_IMAGES_OPENROUTER=none
PRIVACY_IMAGES_AGENT_GATEWAY=none

# Window titles
PRIVACY_TITLES_LOCAL_BUFFER=full
PRIVACY_TITLES_LOCAL_LLM=summary
PRIVACY_TITLES_TRIPLE_STORE=summary
PRIVACY_TITLES_OPENROUTER=summary
PRIVACY_TITLES_AGENT_GATEWAY=none

# Credentials (derived type — detected by pattern matching)
PRIVACY_CREDENTIALS_LOCAL_BUFFER=none
PRIVACY_CREDENTIALS_LOCAL_LLM=none
PRIVACY_CREDENTIALS_TRIPLE_STORE=none
PRIVACY_CREDENTIALS_OPENROUTER=none
PRIVACY_CREDENTIALS_AGENT_GATEWAY=none

# Metadata
PRIVACY_METADATA_LOCAL_BUFFER=full
PRIVACY_METADATA_LOCAL_LLM=full
PRIVACY_METADATA_TRIPLE_STORE=full
PRIVACY_METADATA_OPENROUTER=summary
PRIVACY_METADATA_AGENT_GATEWAY=summary
```

---

## 7. Pattern Library

The redaction engine matches the following patterns across OCR text and audio transcripts.

### AUTH_CREDENTIALS
```python
r'password[s]?\s*[:=]\s*\S+'
r'passwd\s*[:=]\s*\S+'
r'secret[s]?\s*[:=]\s*\S+'
r'\bpwd\s*[:=]\s*\S+'
r'pin\s*[:=]\s*\d{4,8}'
```

### API_TOKENS
```python
r'Bearer\s+[A-Za-z0-9\-._~+/]+=*'
r'sk-[A-Za-z0-9]{20,}'
r'ghp_[A-Za-z0-9]{36}'
r'ghs_[A-Za-z0-9]{36}'
r'AKIA[0-9A-Z]{16}'
r'xox[bpoa]-[0-9A-Za-z\-]+'
r'ya29\.[0-9A-Za-z\-_]+'
r'eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+'
r'api[_-]?key\s*[:=]\s*[^\s]+'
```

### FINANCIAL
```python
r'\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|'
r'3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b'
r'\bCVV\s*[:=]?\s*\d{3,4}\b'
r'\bIBAN\s*[:=]?\s*[A-Z]{2}\d{2}[\dA-Z]{4,30}\b'
r'\b\d{3}-\d{2}-\d{4}\b'
```

### PII_CONTACT
```python
r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
r'\+?1?\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b'
r'\+\d{1,3}\s\d{4,14}'
```

### Replacement tokens

```python
REPLACEMENTS = {
    'AUTH_CREDENTIALS': '[CREDENTIAL REDACTED]',
    'API_TOKENS':       '[TOKEN REDACTED]',
    'FINANCIAL':        '[FINANCIAL DATA REDACTED]',
    'PII_CONTACT':      '[CONTACT INFO REDACTED]',
    'HEALTH':           '[HEALTH INFO REDACTED]',
    'PRIVATE_COMMS':    '[PRIVATE CONTENT REDACTED]',
}
```

When the sharing level is `summary`, the replacement is a count: `[3 REDACTIONS: API_TOKENS×2, FINANCIAL×1]`.

---

## 8. Privacy Layers

Protection is applied at five discrete points in the data pipeline:

| Layer | Where | What it controls |
|---|---|---|
| **Capture** | `sck-capture`, `sense_client` | What enters the system (image ROI, VAD gating, title masking) |
| **Buffer** | `FeedBuffer`, `SenseBuffer` | What is stored in-process (redacted copy, TTL, image stripping) |
| **Agent** | `analyzer.ts` | What is sent to OpenRouter for analysis (context assembly with level filter) |
| **Escalation** | `escalator.ts`, `message-builder.ts` | What is sent to the agent gateway (per-field level checks) |
| **Transmission** | `pipeline.ts`, `ocr.py` | What leaves the machine to external APIs (transcription and OCR gating) |

---

*Document version: 2.0 — 2026-03-26*
