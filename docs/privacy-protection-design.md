# Privacy Protection Design for Sinain HUD

> **Status**: Design document — no code changes yet.
> **Scope**: Multi-layered, per-data-type × per-destination privacy control system.

---

## 1. Problem Statement & Threat Model

Sinain HUD continuously captures **audio**, **screen content**, and **behavioral metadata** from the local machine and forwards subsets of that data to external services (OpenRouter, OpenClaw). The current system has an asymmetric protection posture:

- Screen OCR is partially redacted (5 regex patterns in `sense_client/privacy.py`)
- Audio transcripts, window titles, and JPEG images are forwarded **with zero filtering**

### Threat Scenarios

| # | Scenario | Data at risk |
|---|---|---|
| T1 | LLM provider data breach / retention policy | Audio transcripts, screen text, images |
| T2 | Network interception (HTTPS downgrade, MITM) | Any data in transit to cloud endpoints |
| T3 | Agent gateway server compromise or misconfiguration | Full escalation payloads (richest data) |
| T4 | Ambient capture during private conversation | Verbatim audio of third parties |
| T5 | Screen capture of credentials entered live | Passwords, tokens, card numbers in OCR |
| T6 | Screen capture of sensitive documents | Medical, legal, financial text in OCR or JPEG |
| T7 | Behavioral profiling from metadata | App switches, timing, error rates |
| T8 | Inadvertent logging by cloud provider | Prompts containing raw context |

### Trust Boundary Map

```
[Machine] ─────────────────────────────────────────────────
  │
  ├── sinain-core (in-memory) ← TRUST ZONE: full local
  │     ├── FeedBuffer (ring, 100 items) ← audio stored raw
  │     └── SenseBuffer (ring, 30 items) ← images stored raw
  │
  ├── sinain-memory (triple store) ← local SQLite; embedding text leaves machine
  │
  ├── sense_client ← PARTIAL FILTER (5 patterns)
  │
  │─── TRUST BOUNDARY (TLS) ────────────────────────────────
  │
  ├── OpenRouter API ← cloud; LLM provider retention unknown
  └── Agent gateway ← operator-controlled; richest payload
```

---

## 2. Sensitive Data Taxonomy

Ten categories of sensitive content that may appear in captured data:

| Category | Examples | Typical source |
|---|---|---|
| **AUTH_CREDENTIALS** | Passwords, PINs, passphrase, MFA codes | Screen OCR, audio |
| **API_TOKENS** | Bearer tokens, API keys, JWTs, OAuth codes | Screen OCR |
| **FINANCIAL** | Credit card numbers, bank account numbers, CVV, IBAN | Screen OCR |
| **PII_IDENTITY** | Full name + DOB combo, SSN, passport/national ID | Screen OCR, audio |
| **PII_CONTACT** | Phone numbers, home address, email | Screen OCR, audio |
| **HEALTH** | Medical diagnoses, medication names, lab values | Screen OCR |
| **LEGAL_CONFIDENTIAL** | Contract terms, NDA content, litigation details | Screen OCR, images |
| **PRIVATE_COMMS** | Verbatim messages, emails, chat threads | Screen OCR, images, audio |
| **BIOMETRIC_CONTEXT** | Voice patterns (audio), face in screen | Audio, JPEG images |
| **BEHAVIORAL_META** | App focus patterns, error rates, typing rhythm | Inferred from metadata |

---

## 3. Current Data Flow & Gap Analysis

```
AUDIO PIPELINE (current — no privacy layer)
─────────────────────────────────────────────────────────────
sck-capture (stdout PCM)
  └─ sinain-core AudioPipeline (pipeline.ts)
       └─ VAD + transcription (OpenRouter Whisper) ← [GAP-A] raw audio sent to cloud
            └─ FeedBuffer (feed-buffer.ts:addTranscript)  ← [GAP-B] raw text stored
                 └─ analyzer.ts → OpenRouter LLM prompt  ← [GAP-C] raw text in prompt
                      └─ escalator.ts → OpenClaw payload ← [GAP-D] richest, no filter

SCREEN PIPELINE (current — partial privacy layer)
─────────────────────────────────────────────────────────────
sck-capture (JPEG IPC)
  └─ sense_client
       ├─ ocr.py → OpenRouter vision ← [GAP-E] raw JPEG sent to cloud
       └─ privacy.py (5 patterns) ← partial redaction
            └─ POST /sense → sinain-core
                 └─ SenseBuffer (sense-buffer.ts)
                      ├─ stores filtered OCR ✅
                      ├─ stores raw JPEG ← [GAP-F] image in memory
                      └─ escalator.ts → OpenClaw
                           ├─ rich mode: sends JPEG ← [GAP-G] image to cloud
                           └─ window titles: unfiltered ← [GAP-H]

TRIPLE STORE PIPELINE (current — no privacy layer)
─────────────────────────────────────────────────────────────
sinain-memory/triple_ingest.py
  └─ Ingests entities from agent output + session summaries ← [GAP-I] verbatim text stored
       └─ sinain-memory/embedder.py → OpenRouter text-embedding ← [GAP-I] text leaves machine
            └─ graph_rag.py / graph_rag_query.py
                 └─ Injects retrieved knowledge into prompts ← [GAP-J] no privacy gate on extraction
                      ├─ agent prompts → OpenRouter         ← extracted content bypasses PRIVACY_* checks
                      └─ escalation payloads → OpenClaw     ← extracted content bypasses PRIVACY_* checks
```

**Gaps summary**:
- GAP-A: Transcription API receives raw PCM/audio segments
- GAP-B: Verbatim transcripts live in FeedBuffer indefinitely (up to ring size)
- GAP-C: Raw transcripts included in LLM analysis prompts sent to OpenRouter
- GAP-D: Full context (transcripts + images + titles) sent to OpenClaw in escalation
- GAP-E: Raw JPEG screenshots sent to OpenRouter for OCR (multimodal)
- GAP-F: Raw JPEG images stored in SenseBuffer in-process
- GAP-G: JPEG images forwarded to OpenClaw in rich/focus escalation modes
- GAP-H: Window titles / app names sent to OpenClaw without filtering
- GAP-I: Triple store ingests verbatim text with no privacy filter at `triple_ingest.py` entry point; `embedder.py` sends entity text to OpenRouter for embedding regardless of `openrouter` privacy level
- GAP-J: Graph RAG retrieval injects knowledge from the triple store into agent prompts and escalation payloads with no privacy gate — the triple store acts as both a destination and a source; outbound knowledge must respect the privacy level of the destination it flows into

---

## 4. Protection Layer Architecture

Privacy protection is implemented at five discrete layers. Each layer can act independently; combining them gives defense-in-depth.

```
Layer 1: CAPTURE LAYER (sck-capture / sense_client)
  ─ Goal: Reduce what enters the system
  ─ Techniques: Image ROI cropping, audio VAD gating, title masking at source

Layer 2: BUFFER LAYER (FeedBuffer, SenseBuffer)
  ─ Goal: Control what persists in-process
  ─ Techniques: Store redacted copy, configurable TTL, never store images if level=none

Layer 3: AGENT LAYER (analyzer.ts)
  ─ Goal: Control what is sent to OpenRouter for analysis
  ─ Techniques: Apply sharing level before prompt assembly, swap images for placeholders

Layer 4: ESCALATION LAYER (escalator.ts, message-builder.ts)
  ─ Goal: Control what is sent to the agent gateway
  ─ Techniques: Separate sharing matrix for agent_gateway destination, strip images in standard mode

Layer 5: TRANSMISSION LAYER (pipeline.ts, ocr.py)
  ─ Goal: Control what leaves the machine to external APIs
  ─ Techniques: Transcription audio chunking with level check, OCR image level check
```

---

## 5. Privacy Sharing Matrix

The core of this design. Each cell defines the **sharing level** for a given data type sent to a given destination.

### Sharing Levels

| Level | Meaning | Representation sent |
|---|---|---|
| `full` | Send as-is, no modification | Original content |
| `redacted` | Apply pattern library redaction, send cleaned text | `"…account ending [REDACTED] was…"` |
| `summary` | Send length/count/category, no content | `"[AUDIO: 42 words, ~8s]"` |
| `none` | Do not send; replace with omission marker | `"[OMITTED]"` or field absent |

### Destinations

| Destination ID | Description |
|---|---|
| `local_buffer` | In-memory ring buffers in sinain-core (never leaves machine) |
| `local_llm` | Local model endpoint (e.g. Ollama) — stays on device |
| `triple_store` | Local SQLite EAV store (`sinain-memory/memory/triplestore.db`). Stores entities derived from captured context: signal descriptions, session summaries, pattern text, observations. Entity text is embedded via OpenRouter (`embedder.py`) — so `triple_store` level ALSO bounds what reaches OpenRouter for embedding. Stays on machine; only embedding text leaves. |
| `openrouter` | OpenRouter cloud API (transcription + agent analysis) |
| `agent_gateway` | Agent gateway (e.g. OpenClaw) — operator-controlled escalation target; receives richest payloads |

### Matrix Definition

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
──────────────────────────────────────────────────────────────────────────────────────────
audio_transcript    <level>        <level>      <level>        <level>      <level>
screen_ocr          <level>        <level>      <level>        <level>      <level>
screen_images       <level>        <level>      <level>        <level>      <level>
window_titles       <level>        <level>      <level>        <level>      <level>
credentials         <level>        <level>      <level>        <level>      <level>
metadata            <level>        <level>      <level>        <level>      <level>
```

`credentials` is a derived data type — it refers to content that matched an AUTH_CREDENTIALS or API_TOKEN pattern. It is always filtered out of the source field at that level, but its presence can be flagged as a summary (e.g. `[CREDENTIAL DETECTED: 1]`).

### Triple Store Privacy Note

When `triple_store` level is `full` or `redacted`, entity text is sent to OpenRouter for embedding via `embedder.py`. The `openrouter` level takes precedence — if `PRIVACY_*_OPENROUTER=none`, the embedding step must either be skipped entirely or must fall back to the local MiniLM model only (no external call).

For **outbound** privacy filtering (Graph RAG extraction), each entity in the triple store carries a `source_type` attribute indicating which data type it was derived from:

```
[signal:2026-03-05T14:30, source_type, "audio_transcript"]   ← derived from audio analysis
[observation:2026-03-05-1, source_type, "screen_ocr"]        ← derived from OCR
[pattern:ocr-stall-check,  source_type, "screen_ocr"]        ← derived from curation of OCR
[session:2026-03-05T14:00, source_type, "metadata"]          ← derived from session metadata
```

`graph_rag.py`'s `retrieve()` method accepts an optional `allowed_source_types` filter. When injecting Graph RAG context into a destination, the caller passes the set of source types whose privacy level for that destination is ≥ `summary`.

Example: retrieving for an OpenRouter prompt with `PRIVACY_AUDIO_OPENROUTER=none`, `PRIVACY_OCR_OPENROUTER=redacted`:
- Exclude entities where `source_type=audio_transcript` (level=none — omit entirely)
- Include entities where `source_type=screen_ocr`, but redact their `text`/`description` attributes before injecting

### Environment Variable Naming

Each cell maps to a `PRIVACY_<TYPE>_<DEST>` env var:

```
PRIVACY_AUDIO_LOCAL_BUFFER=full
PRIVACY_AUDIO_LOCAL_LLM=redacted
PRIVACY_AUDIO_TRIPLE_STORE=redacted
PRIVACY_AUDIO_OPENROUTER=none
PRIVACY_AUDIO_AGENT_GATEWAY=none

PRIVACY_OCR_LOCAL_BUFFER=redacted
PRIVACY_OCR_LOCAL_LLM=redacted
PRIVACY_OCR_TRIPLE_STORE=redacted
PRIVACY_OCR_OPENROUTER=redacted
PRIVACY_OCR_AGENT_GATEWAY=redacted

PRIVACY_IMAGES_LOCAL_BUFFER=full
PRIVACY_IMAGES_LOCAL_LLM=none
PRIVACY_IMAGES_TRIPLE_STORE=none
PRIVACY_IMAGES_OPENROUTER=none
PRIVACY_IMAGES_AGENT_GATEWAY=none

PRIVACY_TITLES_LOCAL_BUFFER=full
PRIVACY_TITLES_LOCAL_LLM=summary
PRIVACY_TITLES_TRIPLE_STORE=summary
PRIVACY_TITLES_OPENROUTER=none
PRIVACY_TITLES_AGENT_GATEWAY=none

PRIVACY_CREDENTIALS_LOCAL_BUFFER=none
PRIVACY_CREDENTIALS_LOCAL_LLM=none
PRIVACY_CREDENTIALS_TRIPLE_STORE=none
PRIVACY_CREDENTIALS_OPENROUTER=none
PRIVACY_CREDENTIALS_AGENT_GATEWAY=none

PRIVACY_METADATA_LOCAL_BUFFER=full
PRIVACY_METADATA_LOCAL_LLM=full
PRIVACY_METADATA_TRIPLE_STORE=full
PRIVACY_METADATA_OPENROUTER=summary
PRIVACY_METADATA_AGENT_GATEWAY=summary
```

A `PRIVACY_MODE` preset variable overrides individual settings (see §6).

---

## 6. Preset Modes

Named bundles that set the entire matrix to a known configuration. Individual cell overrides can be applied on top of a preset.

### `off` — Current behavior (no protection)

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
audio_transcript    full           full         full           full         full
screen_ocr          full           full         full           full         full
screen_images       full           full         full           full         full
window_titles       full           full         full           full         full
credentials         full           full         full           full         full
metadata            full           full         full           full         full
```

Use case: Development, debugging, local-only deployments.

### `standard` — Recommended default

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
audio_transcript    full           redacted     redacted       redacted     redacted
screen_ocr          redacted       redacted     redacted       redacted     redacted
screen_images       full           none         none           none         none
window_titles       full           summary      summary        summary      none
credentials         none           none         none           none         none
metadata            full           full         full           summary      summary
```

Key protections added vs `off`:
- Audio is redacted before leaving `local_buffer` for any cloud destination
- Images are never sent to cloud or stored in the triple store (OCR still happens but JPEG is blocked)
- Window titles reduced to summaries at cloud level
- Credentials are stripped everywhere
- Triple store stores only redacted text; `metadata` entities embed freely

### `strict` — No raw content to cloud

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
audio_transcript    redacted       redacted     summary        summary      none
screen_ocr          redacted       redacted     summary        summary      none
screen_images       full           none         none           none         none
window_titles       summary        summary      none           none         none
credentials         none           none         none           none         none
metadata            full           full         full           summary      none
```

Key protections added vs `standard`:
- Audio sent to OpenRouter as length/topic summary only (no verbatim words)
- OCR sent to OpenRouter as word-count/category summary only
- Agent gateway receives no content fields — only metadata summaries
- Triple store stores only summaries (no verbatim text, no embedding of sensitive content)

Trade-off: Agent analysis quality degrades significantly; escalation loses context.

### `paranoid` — Local only, no external transmission

```
                    local_buffer   local_llm    triple_store   openrouter   agent_gateway
audio_transcript    redacted       redacted     none           none         none
screen_ocr          redacted       redacted     none           none         none
screen_images       none           none         none           none         none
window_titles       summary        summary      none           none         none
credentials         none           none         none           none         none
metadata            full           full         full           none         none
```

Key: No data of any kind is sent to any cloud endpoint. The system can still use a local LLM (Ollama) for analysis. OpenRouter-based transcription is disabled — requires a local Whisper alternative. Triple store stores only metadata entities (no text content to embed; embedding is a no-op or local-only).

---

## 7. Pattern Library

Expanded from the 5 patterns currently in `sense_client/privacy.py`. Grouped by category.

### AUTH_CREDENTIALS
```python
r'password[s]?\s*[:=]\s*\S+'             # password: hunter2
r'passwd\s*[:=]\s*\S+'                   # passwd=secret
r'secret[s]?\s*[:=]\s*\S+'              # secret=abc123
r'\bpwd\s*[:=]\s*\S+'                   # pwd=abc123
r'pin\s*[:=]\s*\d{4,8}'                 # pin: 1234
r'\b[A-Za-z0-9]{8,}\b(?=.*password)'    # context-aware
```

### API_TOKENS
```python
r'Bearer\s+[A-Za-z0-9\-._~+/]+=*'       # Bearer <token>
r'sk-[A-Za-z0-9]{20,}'                  # OpenAI / Anthropic keys
r'ghp_[A-Za-z0-9]{36}'                  # GitHub Personal Access Token
r'ghs_[A-Za-z0-9]{36}'                  # GitHub Actions token
r'AKIA[0-9A-Z]{16}'                     # AWS Access Key ID
r'[0-9a-zA-Z/+]{40}'                    # AWS Secret Access Key (heuristic)
r'xox[bpoa]-[0-9A-Za-z\-]+'            # Slack tokens
r'ya29\.[0-9A-Za-z\-_]+'               # Google OAuth access token
r'eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+'  # JWT
r'api[_-]?key\s*[:=]\s*[^\s]+'         # generic api_key = ...
```

### FINANCIAL
```python
r'\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|'
r'3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})'
r'\b'                                   # Luhn-format card numbers
r'\b\d{3}[-\s]?\d{4,6}[-\s]?\d{4,7}\b' # bank account (partial)
r'\bCVV\s*[:=]?\s*\d{3,4}\b'           # CVV code
r'\bIBAN\s*[:=]?\s*[A-Z]{2}\d{2}[\dA-Z]{4,30}\b'  # IBAN
r'\b\d{3}-\d{2}-\d{4}\b'               # SSN (US)
```

### PII_CONTACT
```python
r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'  # email
r'\+?1?\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b'          # US phone
r'\+\d{1,3}\s\d{4,14}'                 # international phone
```

### HEALTH
```python
r'\b(?:diagnosis|diagnosed with|prescribed|dosage|mg|prescription)\b'  # flag context
r'\bMRN\s*[:=]?\s*\d{6,10}\b'          # Medical Record Number
```

### Private Communications (heuristic)
```python
r'(?:said|wrote|replied|texted):\s*["\'](.{10,200})["\']'  # quoted speech
```

### Replacement Strategy

Each pattern has a configurable replacement token:
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

When sharing level is `summary`, the replacement is a count: `[3 REDACTIONS: API_TOKENS×2, FINANCIAL×1]`.

---

## 8. Implementation Targets

For each gap identified in §3, here is the file to modify and the approach.

### GAP-A: Raw audio sent to OpenRouter for transcription

**File**: `sinain-core/src/audio/pipeline.ts`
**Change**: Before calling the transcription API, check `PRIVACY_AUDIO_OPENROUTER`. If `none`, skip transcription entirely (feed placeholder). If `summary`, replace with duration metadata only.
**Note**: At `redacted` level, transcription still happens (we need the text to redact it), but the audio bytes themselves never persist; redaction applies to the returned transcript text.

### GAP-B: Verbatim transcripts stored in FeedBuffer

**File**: `sinain-core/src/index.ts:254` (where transcript enters FeedBuffer)
**File**: `sinain-core/src/buffers/feed-buffer.ts`
**Change**: Apply the redaction filter at buffer insertion time for `audio_transcript` at `local_buffer` level. If level is `none`, store `[AUDIO OMITTED]` with duration metadata. If `summary`, store `[AUDIO: N words, Xs]`.

### GAP-C: Raw transcripts in OpenRouter LLM prompt

**File**: `sinain-core/src/agent/analyzer.ts`
**Change**: Before assembling the context window, apply `PRIVACY_AUDIO_OPENROUTER` and `PRIVACY_OCR_OPENROUTER` levels to each FeedMessage and SenseEvent. Pull from `context-window.ts` after filtering.

### GAP-D: Rich context sent to OpenClaw

**File**: `sinain-core/src/escalation/message-builder.ts`
**Change**: Apply full matrix (`agent_gateway` column) when assembling escalation payload. Images: check `PRIVACY_IMAGES_AGENT_GATEWAY`. Transcripts: check `PRIVACY_AUDIO_AGENT_GATEWAY`. Titles: check `PRIVACY_TITLES_AGENT_GATEWAY`.

### GAP-E: Raw JPEG sent to OpenRouter for OCR

**File**: `sense_client/ocr.py`
**Change**: Check `PRIVACY_IMAGES_OPENROUTER` before calling OCR API. If `none`, skip OCR entirely and return empty string. If `summary`, return `[IMAGE: WxH, estimated N text regions]` without API call.

### GAP-F: Raw JPEG stored in SenseBuffer

**File**: `sinain-core/src/buffers/sense-buffer.ts`
**Change**: If `PRIVACY_IMAGES_LOCAL_BUFFER=none`, strip the `imageData` field on insertion and store `null`. If `summary`, store image dimensions only.

### GAP-G: JPEG images forwarded to OpenClaw

**File**: `sinain-core/src/escalation/escalator.ts` (image attachment section)
**Change**: Gated by `PRIVACY_IMAGES_AGENT_GATEWAY`. If not `full`, do not attach images to escalation payload regardless of `ESCALATION_MODE` setting.

### GAP-H: Window titles sent to OpenClaw

**File**: `sinain-core/src/escalation/message-builder.ts` (title assembly)
**Change**: Apply `PRIVACY_TITLES_AGENT_GATEWAY`. At `summary`, replace title with app category (e.g. "browser", "terminal", "editor"). At `none`, omit.

### GAP-I: Triple store text ingestion and embedding

**File**: `sinain-memory/triple_ingest.py`
**Change**: Check `PRIVACY_<TYPE>_TRIPLE_STORE` before ingesting text-bearing attributes for each entity's source type. If level is `none`, skip the entity. If `summary`, store only the entity ID and type — omit all `text`, `description`, and content attributes.

**File**: `sinain-memory/embedder.py`
**Change**: If the `openrouter` level for the source data type is `none` (i.e., `PRIVACY_<TYPE>_OPENROUTER=none`), skip `_embed_openrouter()` entirely; fall back to local MiniLM only. This ensures that `triple_store=full` does not implicitly cause sensitive text to reach OpenRouter via the embedding path.

### GAP-J: Graph RAG extraction respects destination privacy levels

**File**: `sinain-memory/graph_rag.py` + `sinain-memory/graph_rag_query.py`
**Change**:
- Accept a `destination` parameter (`openrouter` | `agent_gateway` | `local_llm`).
- Build `allowed_source_types` from the privacy config for that destination: include source types whose level is ≥ `summary`.
- Exclude entities entirely if their `source_type` resolves to `none` for the destination.
- Redact `text`/`description` attributes of entities whose `source_type` resolves to `redacted` before returning results.

**File**: `sinain-hud-plugin/index.ts` (Graph RAG injection points)
**Change**:
- Pass `destination="openrouter"` when injecting Graph RAG context into heartbeat/agent prompts.
- Pass `destination="agent_gateway"` when injecting Graph RAG context into escalation payloads.

### Config loading

**File**: `sinain-core/src/config.ts`
**Change**: Add parsing for `PRIVACY_MODE` preset + all 30 individual `PRIVACY_<TYPE>_<DEST>` vars (6 data types × 5 destinations). Preset values populate defaults; individual vars override.

**File**: `sense_client/config.py` (or `__main__.py`)
**Change**: Read `PRIVACY_IMAGES_OPENROUTER` and `PRIVACY_OCR_OPENROUTER` to gate OCR calls.

**File**: `sinain-memory/config.py`
**Change**: Read all `PRIVACY_*_TRIPLE_STORE` and `PRIVACY_*_OPENROUTER` vars (for the embedder gate).

---

## 9. Verification Strategy

### Layer 1 — Unit tests for pattern library

For each pattern type, write a test with:
- A string that **should** match (credential/token/card)
- A string that **should not** match (benign similar text)
- Verify replacement text appears in output

Test file: `sense_client/tests/test_privacy.py`

### Layer 2 — Buffer insertion verification

Inject a FeedMessage with a known credential string into FeedBuffer with each sharing level. Assert:
- `full`: credential present in stored item
- `redacted`: `[CREDENTIAL REDACTED]` present, original absent
- `summary`: `[AUDIO: N words]` format only
- `none`: `[AUDIO OMITTED]` present

### Layer 3 — Prompt inspection

Mock the OpenRouter API. Trigger an agent analysis cycle. Capture the prompt payload sent. Assert that with `PRIVACY_AUDIO_OPENROUTER=none`, no transcript text appears in the prompt.

### Layer 4 — Escalation payload inspection

Mock the agent gateway. Trigger escalation. Capture the outgoing HTTP + WebSocket payload. Assert image fields are absent when `PRIVACY_IMAGES_AGENT_GATEWAY=none`.

### Layer 5 — End-to-end smoke test

Run the full system with `PRIVACY_MODE=strict`. Intercept outbound HTTPS calls (mitmproxy or custom proxy). Verify:
- No JPEG data in any outbound request body
- No verbatim transcript text in any prompt (only summaries)
- No window titles in escalation payload

### Triple store extraction verification

With `PRIVACY_AUDIO_OPENROUTER=none`, trigger a Graph RAG retrieval for an `openrouter` destination. Assert:
- Entities with `source_type=audio_transcript` are not present in retrieval results
- Entities with `source_type=metadata` (level=`summary`) are present but content attributes are summarized

### Regression test

After enabling `standard` mode, verify that:
- Agent analysis still produces non-empty HUD output (quality check)
- Escalation still fires on expected patterns (functionality check)
- OCR pipeline still returns redacted-but-useful text

---

## 10. Open Questions

1. **Local Whisper**: `paranoid` mode requires local transcription. What local Whisper option should be supported? (Whisper.cpp via subprocess, faster-whisper Python, Ollama with audio model?)

2. **Image summarization without OCR API**: For `PRIVACY_IMAGES_OPENROUTER=summary`, what replaces the vision call? Heuristic bounding-box count from OpenCV? Or just dimensions + entropy estimate?

3. **Audio credential detection**: Detecting credentials in audio transcripts requires the transcript to already exist. Should audio transcription always happen locally first, then apply redaction before any cloud send? This changes the pipeline order.

4. **Redaction vs omission for agent quality**: For `openrouter` destination at `redacted` level, how much does token-replacing credentials degrade analysis quality? Should we preserve surrounding context with just the value replaced?

5. **Window title categorization**: Implementing `summary` level for window titles requires a category map (browser → "browser", iTerm2 → "terminal", etc.). Should this be a hardcoded list or configurable?

6. **Per-session override**: Should there be a runtime API endpoint (`POST /privacy`) to temporarily change the sharing level for a session (e.g., during a meeting), without restarting sinain-core?

7. **Triple store source_type backfill**: Existing entities in `triplestore.db` lack `source_type`. Should migration assign a default (e.g., `unknown`) or derive it heuristically from entity key prefixes (`signal:` → `audio_transcript`, `observation:` → `screen_ocr`)?

8. **Local MiniLM availability**: `paranoid` and embedding-gated paths require a local embedding model. Should `embedder.py` always bundle a local fallback, or should embedding be entirely skipped when `openrouter=none`?

---

*Document version: 1.1 — 2026-03-15*
