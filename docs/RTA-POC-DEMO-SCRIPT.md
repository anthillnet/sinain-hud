# RTA SAST + DAST PoC — Demo Run Sheet & Customer Conversation

Companion to `RTA-SAST-DAST-POC-GUIDE.md`. Two things: a tight run sheet for the live demo, and the agenda for the conversation that turns the demo into a signed PoC.

---

## 0. Pre-demo readiness ("rerun all")

Run the preflight once on the demo machine (needs Docker + Node) and confirm all-green:

```bash
cd sinain-hud-2
scripts/poc-preflight.sh
```

It builds `sinain-core`, runs Qodana (SAST), starts the service, runs ZAP (DAST), and checks every report was produced. Expect `PASS: … FAIL: 0`. Logs land in `/tmp/poc-*.log` if anything fails.

Then, so nothing is generated live in front of the customer:

- Run the **TeamCity** build once beforehand so it's already green (a live first-run pulls multi-GB images).
- Pre-open three browser tabs: the **TeamCity build page**, the **Qodana report** (`qodana-out/python/report/index.html` or the build's Qodana tab), and the **ZAP report** (`zap-out/zap-report.html`).
- Have `qodana.yaml` open in an editor — it's the "governance as code" visual.

**Already verified for you** (static checks): `sinain-core` type-checks clean, `qodana.yaml` and `teamcity/docker-compose.yml` are valid, the `/feed?after=0` readiness probe and `:9500`/`8111` ports are correct. The Docker-based scans must be run on the demo machine via the preflight above — they can't run in a sandbox.

---

## 1. The live demo (≈10 minutes)

| Time | Do | Say |
|---|---|---|
| 0:00 | Show the empty TeamCity build config, steps listed | "One machine, fully on-prem. We take an unknown app — here, SinainHUD — inspect its source and probe its running service, and produce two security reports through one pipeline." |
| 0:30 | Open `qodana.yaml` | "This is governance *as code*. The rules and the quality gate live in the repo, versioned — not in someone's head." |
| 1:00 | Trigger / show the build: build → SAST → run → DAST → publish | "TeamCity is the spine. Every vendor drop runs this same pipeline automatically." |
| 2:00 | Open the **Qodana** report; drill into one security finding | "First-party static analysis. Exact file, line, rule, and the recommended fix. This is the white-box view RTA doesn't have today." |
| 5:00 | Open the **ZAP** report; show a couple of alerts | "Dynamic testing against the *running* service. JetBrains ships no DAST scanner — we orchestrate best-of-breed OWASP ZAP through the same spine. Honest scoping." |
| 7:00 | Show the build failing when the Qodana threshold trips | "This is how a non-compliant deliverable gets blocked before it's ever accepted." |
| 8:30 | Close | "Everything you saw is a repo you own. Point it at a real Super-App application and the same pipeline produces the same reports." |

Keep it to the reports. Don't tour the tools' full UIs — the story is *pipeline → prioritised findings → gate*.

---

## 2. What each artefact proves

- **Qodana (SAST)** → first-party white-box coverage of the modern stack (Python here; JS/TS, JVM, .NET in a real engagement). Directly answers RTA's "we don't know if the code we receive is high-quality."
- **OWASP ZAP (DAST)** → dynamic coverage of the running service, integrated as a CI step. Demonstrates the honest "third-party scanner on the JetBrains spine" pattern.
- **TeamCity + `qodana.yaml` + the ZAP step** → the reusable, version-controlled *governance fabric*. This is the thing RTA extends to every vendor app — the actual PoC value, beyond any single finding.

---

## 3. Customer conversation — setting up the real PoC

The demo shows *what good looks like* on a stand-in app. The real PoC runs the same pattern on **one RTA Super-App application**. To scope and start it, we need decisions and access in these areas. (Fuller list in `poc-discovery-questions.md`; these are the blocking ones.)

### 3.1 The blocking decisions (can't start without these)

1. **Target application.** Which Super-App application? (Traffic Control and Parking were floated.) Ideally on a modern stack Qodana covers directly — Spring Boot, .NET Core, or Node.js — and a single deployable unit, not a sprawl.
2. **Source-code access.** Where does the code live, and can JetBrains PS get read-only access for the PoC window? If the repo is vendor-owned, what's the contractual path to a code drop or Git mirror?
3. **The "as-designed" architecture + standards to check against.** Discrepancy mapping needs a reference. Is there an architecture doc (even a whiteboard), and can the architect join a 60–90 min articulation session in week 1? Any published coding/security standards, banned licences, "do-not-do" rules?
4. **Environment to host the tooling.** Who provisions the VMs/containers/network for TeamCity, Qodana, and (optionally) the DAST target inside RTA infrastructure? On-prem, Azure, or hybrid?
5. **A running instance for DAST.** SAST needs only source; DAST needs a deployed, non-production instance of the target app that ZAP can point at. Does a test/staging environment exist we can scan?

### 3.2 Logistics to line up in parallel

- **Access & clearance.** VPN / jump host / SSO for JetBrains PS; any background-check requirements; remote acceptable or on-site needed.
- **Named counterparts.** RTA technical lead (day-to-day), the target app's architect, and the current vendor contact.
- **People to involve.** 2–4 RTA developers/architects to work alongside PS (this is the "internalising development" seed).
- **Timeline windows.** Realistic date for source access; anything to work around (Ramadan/Eid, fiscal year, leadership reviews). The PoC is a single 4–6 week phase.
- **Vendor posture.** Will the vendor be told the PoC is happening, and are they contractually obliged to act on findings? (Findings are still useful without them — but remediation needs them.)

### 3.3 Licensing to confirm

- **TeamCity** — Professional edition is free (3 agents, 100 build configs); enough for a PoC. Enterprise only if scale demands it.
- **Qodana** — the **Community Python/JVM/.NET** linters are free; **JS/TS, PHP, and full JVM** need Qodana Ultimate/Ultimate Plus. Confirm which linters the target app's stack requires and line up the licence/trial.
- **OWASP ZAP** — free and open-source; no licence.
- **IDE Services / AI Enterprise (Mellum)** — out of scope for this SAST+DAST slice, but flag if RTA wants them evaluated in the same window.

### 3.4 The concrete "asks" to leave the room with

1. A named **target application** (or a shortlist of two to confirm within a week).
2. A commitment on **source access** and the path to obtain it.
3. A **week-1 architecture session** booked with the architect of record.
4. An **infra owner** named for provisioning the tooling environment.
5. Confirmation of the **DAST test instance** and access to it.
6. Sign-off owner for the **PoC SOW / commercial proposal**.

---

*End of run sheet.*
