# RTA SAST + DAST PoC — Local Installation & Demonstration Guide

**Prepared for:** RTA Governance & Discrepancy-Mapping PoC (JetBrains Professional Services)
**Purpose:** Stand up a *simple, fully local* SAST + DAST stack, orchestrated by TeamCity, using the **SinainHUD (sinain-hud-2)** application as the target under test — and gather the scanners' reports the normal way for a self-contained demonstration.
**Date:** July 2026

> **What this demo proves in one sentence.** JetBrains tooling can take an unknown codebase (SinainHUD, here), statically inspect it (SAST) and dynamically probe its running service (DAST), and produce prioritised, governance-relevant security reports — all on-premises with no code or telemetry leaving the machine.

---

## Table of Contents

1. [Concept & Architecture](#1-concept--architecture)
2. [How This Maps to the RTA PoC](#2-how-this-maps-to-the-rta-poc)
3. [Prerequisites](#3-prerequisites)
4. [Part A — Run SinainHUD as the target application](#4-part-a--run-sinainhud-as-the-target-application)
5. [Part B — SAST with Qodana](#5-part-b--sast-with-qodana)
6. [Part C — DAST with OWASP ZAP](#6-part-c--dast-with-owasp-zap)
7. [Part D — TeamCity CI Spine](#7-part-d--teamcity-ci-spine)
8. [Part E — Where the Reports Live](#8-part-e--where-the-reports-live)
9. [The Demonstration Script](#9-the-demonstration-script)
10. [Troubleshooting](#10-troubleshooting)
11. [Teardown](#11-teardown)
12. [Appendix A — Endpoint & Port Reference](#appendix-a--endpoint--port-reference)
13. [Appendix B — Honest Scoping Note](#appendix-b--honest-scoping-note)

---

## 1. Concept & Architecture

SinainHUD is simply the **application under test** — a realistic, multi-language codebase that also exposes a running HTTP service, so it gives us both a SAST target (source) and a DAST target (live service) on one machine, with nothing external to provision.

- **SAST (static)** — **Qodana** inspects the `sinain-hud-2` source tree (Python + TypeScript) and produces a browsable HTML report plus a SARIF file.
- **DAST (dynamic)** — **OWASP ZAP** probes the *running* `sinain-core` HTTP server on `http://localhost:9500` and produces an HTML + JSON report.
- **Orchestration** — **TeamCity Professional** (free) runs both as pipeline steps and publishes the reports as build artifacts / a report tab.
- **Read-out** — you review the reports the normal way: the Qodana report (HTML / the TeamCity Qodana tab / Qodana Cloud) and the ZAP report (HTML artifact). No custom integration required.

```
                    ┌──────────────────────── Your laptop (all local) ────────────────────────┐
                    │                                                                          │
   ┌────────────┐   │   ┌───────────────── TeamCity Professional (:8111) ─────────────────┐   │
   │  sinain-   │   │   │  Build config: "RTA SAST+DAST PoC"                              │   │
   │  hud-2     │───┼──▶│  step 1  Build sinain-core        (npm ci && npm run build)     │   │
   │  repo      │   │   │  step 2  SAST — Qodana runner     → Qodana report tab + SARIF   │   │
   │ (under     │   │   │  step 3  Start sinain-core        (server on :9500)             │   │
   │  test)     │   │   │  step 4  DAST — OWASP ZAP (docker) → zap-report.html + .json    │   │
   └────────────┘   │   │  step 5  Publish artifacts        (qodana-out/**, zap-out/**)   │   │
                    │   └────────────────────────────────────────┬───────────────────────┘   │
                    │                                             │                            │
                    │                                             ▼                            │
                    │                        ┌──────────── Reports ────────────┐               │
                    │                        │  Qodana HTML / TeamCity tab      │               │
                    │                        │  ZAP HTML + JSON (build artifact)│               │
                    │                        └──────────────────────────────────┘               │
                    │                                                                          │
                    │   During DAST, sinain-core (:9500) is just the live target ZAP attacks.  │
                    └──────────────────────────────────────────────────────────────────────────┘
```

You can run the scanners **without** TeamCity (Parts B and C as raw commands) for a 15-minute smoke test, then layer TeamCity on top (Part D) for the "governance spine" story. Do the manual run first — it makes the TeamCity steps obvious.

---

## 2. How This Maps to the RTA PoC

| RTA PoC element | This local demo |
|---|---|
| **TeamCity** as the CI/CD spine | TeamCity Professional in Docker orchestrates every step and holds the reports |
| **Qodana** = SAST + quality gate | Qodana Community (Python) + Qodana for JS run as a build step, produce the SAST report |
| **DAST via 3rd-party in CI** (JetBrains ships no DAST scanner) | OWASP ZAP runs as a Docker build step — exactly the "external scanner orchestrated by TeamCity" pattern |
| **Discrepancy / gap-scan findings report** | The Qodana report + ZAP report *are* the findings deliverable, gathered the normal way |
| **Governance as code** | `qodana.yaml` and the ZAP step are version-controlled in the repo |
| **On-premises, nothing leaves** | Every component is a local process/container; `sinain-core` binds to loopback by default |

This is the honest JetBrains framing from the PoC brief: **SAST is first-party (Qodana); DAST is a process-integrated third-party scanner (ZAP) orchestrated by TeamCity.** See [Appendix B](#appendix-b--honest-scoping-note).

---

## 3. Prerequisites

| Requirement | Notes |
|---|---|
| **Docker Desktop** (macOS/Windows) or Docker Engine (Linux) | Powers ZAP, Qodana linters, and the TeamCity server/agent. Give it ≥ 6 GB RAM. |
| **Node.js 22+** and npm | To build and run `sinain-core` (the DAST target). |
| **The `sinain-hud-2` repo** checked out locally | This is both the SAST target (source) and the DAST target (its running server). |
| **Qodana CLI** *(optional but recommended)* | For the fast manual SAST run in Part B. Install below. |
| **`curl`** | Used by the readiness checks. |
| **A Qodana Cloud token** *(only for the JS/TS linter)* | The **Python** linter is free and needs no token. The **JS** linter needs an Ultimate trial/token — free 30-day trial, or your JetBrains employee entitlement. Skip it and you still have a full SAST demo on the Python code. |
| **~15 GB free disk** | Docker images (TeamCity ≈ 2 GB, Qodana linters ≈ 2–4 GB each, ZAP ≈ 1.5 GB). |

Free ports needed: **9500** (sinain-core, the DAST target), **8111** (TeamCity). Make sure nothing else is bound to them.

Install the Qodana CLI (macOS/Linux):

```bash
# Homebrew
brew install jetbrains/utils/qodana
# …or the install script
curl -fsSL https://jb.gg/qodana-cli/install | bash
qodana --version
```

> **One-command readiness check.** Once Docker and Node are in place, `scripts/poc-preflight.sh` runs Parts A–C end-to-end and prints PASS/FAIL per stage — use it to confirm the demo machine is ready. The `qodana.yaml` and `teamcity/docker-compose.yml` referenced below are already committed at the repo root and under `teamcity/`.

---

## 4. Part A — Run SinainHUD as the target application

SinainHUD is the application we scan. For **DAST**, its `sinain-core` service must be running so ZAP has a live target. (For **SAST**, we only need the source on disk — no server required.)

### 4.1 Build and start sinain-core (the DAST target)

```bash
cd sinain-hud-2/sinain-core
npm install

# The analysis/LLM features are irrelevant here — we only need the HTTP surface
# up so ZAP has something to probe.
export PORT=9500
export AGENT_ENABLED=false
export ESCALATION_MODE=off

npm run dev      # tsx watch — serves HTTP + WebSocket on :9500
```

> **Important for DAST-from-Docker.** By default `sinain-core` binds to `127.0.0.1` (loopback only — see `SINAIN_BIND_HOST` in config). A ZAP container **cannot** reach a loopback-only port on the host. For the demo, bind to all interfaces so the container can hit it:
>
> ```bash
> export SINAIN_BIND_HOST=0.0.0.0
> ```
>
> Only do this on a trusted local network — it exposes the API to your LAN. Revert to `127.0.0.1` afterward.

### 4.2 Confirm the target is up

```bash
curl -sf "http://localhost:9500/feed?after=0" >/dev/null && echo "sinain-core is up (DAST target ready)"
```

That's all Part A needs — a running service on `:9500`. You do **not** need the overlay UI for this demo; the deliverable is the scan reports, not anything shown inside the HUD.

---

## 5. Part B — SAST with Qodana

Qodana is the first-party JetBrains SAST + code-quality engine. We run two linters:

- **Qodana Community for Python** — *free, no token* — scans `sense_client/` and `sinain-hud-plugin/sinain-memory/` (~129 Python files).
- **Qodana for JS** — *needs an Ultimate trial/token* — scans `sinain-core/` (TypeScript). Optional.

### 5.1 Add a `qodana.yaml`

Governance-as-code starts here: the ruleset lives in the repo. Create `sinain-hud-2/qodana.yaml`:

```yaml
version: "1.0"
# Default profile enables ~all inspections including the security (SAST) ones.
profile:
  name: qodana.recommended
# Fail the pipeline when the finding count crosses this threshold — this is the
# "quality gate" that blocks promotion in a real governance setup.
failThreshold: 10
# Keep the demo fast and focused on first-party code (skip vendored deps).
exclude:
  - name: All
    paths:
      - node_modules
      - dist
      - build
      - "**/.venv"
```

### 5.2 Run the Python SAST scan (free)

Using the Qodana CLI (it pulls the right linter image for you) and opening the report at the end:

```bash
cd sinain-hud-2

qodana scan \
  --linter jetbrains/qodana-python-community:2026.1 \
  --project-dir sense_client \
  --results-dir "$PWD/qodana-out/python" \
  --save-report \
  --show-report            # opens the HTML report in your browser when done
```

Prefer raw Docker (no CLI install)? This is exactly what the CLI runs:

```bash
docker run --rm \
  -v "$PWD/sense_client":/data/project/ \
  -v "$PWD/qodana-out/python":/data/results/ \
  jetbrains/qodana-python-community:2026.1 \
  --save-report
```

**Reports** (in `qodana-out/python/`):

- `report/index.html` — the browsable report; this is your "what good looks like" walkthrough surface.
- `qodana.sarif.json` — machine-readable findings (for archival / import into other tools).

> Check the current linter tag on Docker Hub (`jetbrains/qodana-python-community`). If `2026.1` has moved on, use `latest` or the newest year-versioned tag. Pin a real version in a customer deployment.

### 5.3 Run the TypeScript SAST scan (optional, needs a token)

The `sinain-core` service is TypeScript — the "modern Node.js stack" in the RTA brief. The JS linter is a paid linter, so authenticate with a Qodana Cloud token first (free trial or your JetBrains entitlement):

```bash
export QODANA_TOKEN="<your-qodana-cloud-project-token>"

qodana scan \
  --linter jetbrains/qodana-js:2026.1 \
  --project-dir sinain-core \
  --results-dir "$PWD/qodana-out/js" \
  --save-report --show-report
```

With a token, results also sync to **Qodana Cloud**, giving you a hosted dashboard and trend history — another normal way to review the report. If you don't have a token, skip this; the Python scan alone is a complete SAST demonstration. Note it honestly in the read-out (this mirrors the PoC's "honest scoping" principle).

---

## 6. Part C — DAST with OWASP ZAP

OWASP ZAP is the free, open-source DAST scanner. JetBrains ships no DAST product, so this is the canonical "third-party scanner orchestrated by CI" step. The official image is `ghcr.io/zaproxy/zaproxy:stable`.

`sinain-core` must be **running** (Part A) with `SINAIN_BIND_HOST=0.0.0.0`.

### 6.1 Baseline scan (passive — safe, fast)

The baseline scan spiders the target and runs passive checks only — it never sends attack payloads, so it's safe to run against anything and finishes in a few minutes. It's the right default for a demo.

```bash
mkdir -p zap-out

docker run --rm \
  -v "$PWD/zap-out":/zap/wrk/:rw \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
    -t http://host.docker.internal:9500 \
    -J zap-report.json \
    -r zap-report.html \
    -I
```

- `host.docker.internal` resolves to the host from inside the container on Docker Desktop (macOS/Windows). **On Linux**, add `--add-host=host.docker.internal:host-gateway` to the `docker run` line.
- `-r zap-report.html` → the human report you review.
- `-J zap-report.json` → machine-readable report for archival.
- `-I` → do not exit non-zero on warnings (so a CI run continues to the publish step; enforce a gate deliberately if you want).

**Reports** land in `zap-out/`: open `zap-out/zap-report.html`.

### 6.2 Optional — active scan (sends real payloads)

To show ZAP actively attacking the API (SQLi/XSS/injection probes), use the full scan. It **mutates state and sends malicious payloads** — only ever against a local, disposable target like this one, never production:

```bash
docker run --rm \
  -v "$PWD/zap-out":/zap/wrk/:rw \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-full-scan.py \
    -t http://host.docker.internal:9500 \
    -J zap-report.json \
    -r zap-report.html \
    -I
```

> `sinain-core` is a JSON/localhost API with a few HTML surfaces (the knowledge UI and wiki). The baseline spider will find those and passively flag transport/header/config issues — enough for a compelling DAST report. For deeper API coverage in a real engagement, feed ZAP an OpenAPI/Swagger definition via `zap-api-scan.py -f openapi`.

---

## 7. Part D — TeamCity CI Spine

Now wrap Parts B and C into a single TeamCity build so the story is "one pipeline, every gate, reports published automatically." TeamCity **Professional is free** (3 build agents, up to 100 build configurations).

### 7.1 Bring up TeamCity server + agent

The Qodana runner requires an agent on a non-Windows OS **with Docker available**, so we give the agent Docker-in-Docker. Create `teamcity/docker-compose.yml`:

```yaml
services:
  teamcity-server:
    image: jetbrains/teamcity-server:latest
    ports:
      - "8111:8111"
    volumes:
      - ./data:/data/teamcity_server/datadir
      - ./logs:/opt/teamcity/logs

  teamcity-agent:
    image: jetbrains/teamcity-agent:latest
    environment:
      - SERVER_URL=http://teamcity-server:8111
      - DOCKER_IN_DOCKER=start          # lets the agent run Qodana/ZAP containers
    privileged: true                     # required for docker-in-docker
    volumes:
      - ./agent-conf:/data/teamcity_agent/conf
```

```bash
cd sinain-hud-2/teamcity
docker compose up -d
```

Open `http://localhost:8111`, complete the first-run setup (accept the DB default — internal HSQLDB is fine for a PoC — and the license agreement). Then go to **Agents** and **Authorize** the agent that appears.

### 7.2 Install the Qodana plugin

In TeamCity: **Administration → Plugins → Browse plugin repository → search "Qodana" → install**, then restart the server when prompted. This adds the **Qodana** runner type (which also gives every build a **Qodana** report tab). The plugin issues the `docker run` for the linter for you.

### 7.3 Create the project and VCS root

**Administration → Create project → From repository URL**, point it at your local `sinain-hud-2` checkout (a local path or your Git remote). Name it **"RTA SAST+DAST PoC"**.

### 7.4 Build steps

Add these build steps in order:

**Step 1 — Build sinain-core** *(Command Line)*
```bash
cd sinain-core && npm ci && npm run build
```

**Step 2 — SAST (Qodana)** *(Qodana runner)*
- Linter: **Qodana Community for Python** (checkbox), image `jetbrains/qodana-python-community:2026.1`.
- Additional Docker args: `-v %teamcity.build.checkoutDir%/sense_client:/data/project/`
- The runner publishes results and exposes the **Qodana** report tab on the build automatically.

**Step 3 — Start sinain-core** *(Command Line)* — background the server so ZAP has a target:
```bash
cd sinain-core
SINAIN_BIND_HOST=0.0.0.0 PORT=9500 AGENT_ENABLED=false ESCALATION_MODE=off \
  nohup npm start > "%teamcity.build.checkoutDir%/core.log" 2>&1 &
# wait for readiness
for i in $(seq 1 30); do curl -sf http://localhost:9500/feed?after=0 && break; sleep 1; done
```

**Step 4 — DAST (OWASP ZAP)** *(Command Line)*
```bash
mkdir -p zap-out
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "%teamcity.build.checkoutDir%/zap-out":/zap/wrk/:rw \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://host.docker.internal:9500 \
    -J zap-report.json -r zap-report.html -I
```

### 7.5 Publish the reports as artifacts

In **Edit Configuration → General Settings → Artifact paths**, add:

```
qodana-out/** => qodana
zap-out/**    => zap
```

Run the build. When it goes green, the **Qodana** tab shows the SAST report and the **Artifacts** tab holds the Qodana HTML + SARIF and the ZAP HTML + JSON. Add a **Failure Condition** on the Qodana quality gate (or on a ZAP high-risk count) to make it a true gate.

---

## 8. Part E — Where the Reports Live

Everything is gathered the normal way — no custom tooling:

| Report | Where to open it |
|---|---|
| **Qodana SAST (HTML)** | `qodana-out/python/report/index.html` locally, or the **Qodana** tab on the TeamCity build, or **Qodana Cloud** (if a token was used) |
| **Qodana SAST (SARIF)** | `qodana-out/python/qodana.sarif.json` — for archival or import into other security tooling |
| **ZAP DAST (HTML)** | `zap-out/zap-report.html` locally, or the **Artifacts → zap/** tab on the TeamCity build |
| **ZAP DAST (JSON)** | `zap-out/zap-report.json` — machine-readable archival |

These four artefacts are the PoC's "discrepancy / gap-scan findings" deliverable for the demo.

---

## 9. The Demonstration Script

A tight 10-minute run of show for the RTA audience:

1. **Frame it (30s).** "This is one machine, fully on-prem. We take an unknown application — SinainHUD — inspect its source and probe its running service, and produce two security reports through one pipeline."
2. **Trigger the TeamCity build (1m).** Point out the pipeline: build → SAST → run → DAST → publish. This *is* governance-as-code — the gates and config are version-controlled.
3. **Open the Qodana report (3m).** From the build's **Qodana** tab. Drill into one security finding — "here's the exact file, line, rule, and the recommended fix."
4. **Open the ZAP report (2m).** From **Artifacts → zap/zap-report.html**. Transport/header/config issues on the live service. "No JetBrains DAST product exists; we orchestrate a best-of-breed open-source scanner through the same spine. Honest scoping."
5. **The gate (2m).** Show the build failing when the Qodana threshold is exceeded — "this is how a non-compliant vendor drop gets blocked automatically."
6. **The narrative close (1.5m).** "Everything you saw is a repo you own: `qodana.yaml`, the ZAP step, the pipeline. Point it at a real vendor application tomorrow and the same pipeline produces the same two reports."

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| ZAP reports the target is unreachable | `sinain-core` is loopback-only. Set `SINAIN_BIND_HOST=0.0.0.0` (4.1). On Linux add `--add-host=host.docker.internal:host-gateway`. |
| Qodana "license/token required" | You're running the **JS** linter without a token. Use the **Python Community** linter (free) or set `QODANA_TOKEN`. |
| Qodana image tag not found | The `2026.1` tag moved; check Docker Hub for the current tag or use `latest`. |
| No Qodana report tab in TeamCity | The Qodana **plugin** isn't installed, or the step used a plain Command Line runner. Use the **Qodana** runner type (7.2). |
| TeamCity Qodana runner fails with a Docker error | The agent has no Docker access. Ensure `DOCKER_IN_DOCKER=start` + `privileged: true` (7.1), or mount `/var/run/docker.sock`. |
| ZAP baseline "fails" the step | It exits non-zero on warnings by design. Keep `-I` so the pipeline reaches the publish step; enforce a gate deliberately instead. |
| Port already in use (9500 / 8111) | Stop the conflicting process or remap (`PORT=…`, or the compose `ports:` mapping). |

---

## 11. Teardown

```bash
# TeamCity
cd sinain-hud-2/teamcity && docker compose down          # add -v to wipe the datadir

# sinain-core: Ctrl-C the npm process, then restore loopback binding
unset SINAIN_BIND_HOST      # back to 127.0.0.1-only

# Scan artefacts
rm -rf sinain-hud-2/qodana-out sinain-hud-2/zap-out

# Reclaim image space (optional)
docker image rm ghcr.io/zaproxy/zaproxy:stable jetbrains/qodana-python-community:2026.1 \
  jetbrains/teamcity-server:latest jetbrains/teamcity-agent:latest 2>/dev/null || true
```

---

## Appendix A — Endpoint & Port Reference

| Service | Address | Role in demo |
|---|---|---|
| sinain-core HTTP/WS | `http://localhost:9500` | The live DAST target ZAP attacks |
| `GET /feed?after=0` | returns `{ messages, epoch }` | Cheap readiness probe for the target |
| `GET /knowledge` | HTML | One of the HTML surfaces ZAP's spider will discover |
| TeamCity | `http://localhost:8111` | CI spine UI + report host (Qodana tab, artifacts) |

`sinain-core` is only ever a **target** in this demo — we read the scanners' own reports, we do not push anything back into the app.

---

## Appendix B — Honest Scoping Note

This mirrors the PoC brief's central honesty principle:

- **SAST is first-party.** Qodana is a JetBrains product, runs in CI and in the IDE, and is the quality/security gate.
- **DAST is not a JetBrains product.** There is no JetBrains DAST scanner. DAST here is **OWASP ZAP**, a third-party open-source tool that TeamCity *orchestrates* as a pipeline step. That is exactly how JetBrains positions DAST: best-of-breed external scanners integrated into the CI spine, not a first-party feature.
- **The value is the fabric, not a single tool.** TeamCity is the spine; Qodana covers static analysis natively; ZAP covers the dynamic surface via process integration; and both reports converge in one place. That "governance fabric" is the reusable pattern RTA extends to a real vendor application.

*End of guide.*
