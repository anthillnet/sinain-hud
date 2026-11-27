# Qodana vs SonarQube — Value Proposition for RTA

**Context:** RTA (Roads & Transport Authority, Dubai) already runs Sonar and is "looking for an edge over Sonar" (Alexander Costa, 6 Aug 2026). SDLC consultancy engagement; they explicitly asked for a **SAST & DAST** PoC; UAE government → data residency and on-prem will come up.

**Status of this document:** §1–§5 are customer-safe framing. **§6–§9 are INTERNAL ONLY** — they contain our own weaknesses, discount mechanics, and source caveats. Do not send this file to RTA as-is.

---

## 1. The three arguments that actually win against Sonar

Everything else is noise. Lead with these, in this order:

1. **Governance-as-code.** Sonar stores quality profiles and gates in its server UI/database. Qodana stores inspection profiles in the repo, version-controlled, reviewable via merge request. For an organisation whose entire stated problem is *"no centralised design guidelines and no automated way to flag non-compliance"* across **vendor-delivered code**, the ability to put the rulebook under change control — and prove which rules were in force when a vendor drop was accepted — is the single most relevant differentiator.
2. **Per-contributor, not per-line-of-code.** RTA has a sprawling multi-vendor estate full of legacy code they rarely touch. Sonar charges for all of it. Qodana charges for active contributors, unlimited LOC and unlimited projects — which is exactly the shape of an estate-wide governance rollout.
3. **IDE↔CI parity.** Qodana runs the same IntelliJ inspection engine developers already use in the IDE, so a CI finding is reproducible on the developer's machine. Sonar's IDE plugin runs its own on-the-fly analysis separate from the CI engine, which can disagree with itself.

**One-line pitch for RTA:**

> Qodana brings the same inspections your developers already trust in their JetBrains IDEs into your CI/CD pipelines — with the rulebook version-controlled in Git rather than locked in a server UI, priced per active developer rather than per line of code, and deployable fully on-premises so no source code leaves RTA.

---

## 2. Why Evri is the reference story to tell

Evri (UK's largest parcel delivery company, 8,000+ employees) **migrated from SonarQube to Qodana**. Their stated reason maps almost word-for-word onto RTA's vendor-governance problem:

> "Evri previously used SonarQube for quality analysis but started looking for alternatives. They questioned its cost efficiency and were concerned about too many legacy issues in its setup. As Luke Morton, Senior Technical Architect at Evri, mentioned, '**… people could create their own analysis rules to make their code pass through quality gates. We had limited quality control over our coding standards.**'"

That is precisely RTA's nightmare scenario with vendors — the party being measured can weaken the measurement. What Evri moved to:

> "**Enhanced control.** Centralized management of quality rules via a globally configured YAML file at runtime through Jenkins. This way, if developers wanted to make changes, they would need to raise merge requests for the YAML file to the DevEx team."

Result headline: **"6x faster code analysis leads to more frequent, faster releases."**

Their gate architecture is also a good model for RTA's multi-tool reality:

> "Following this, various quality gates, including **Qodana and Snyk, run in parallel**. Each tool provides feedback on the merge request. If any quality gate fails, the build is halted, preventing the merge request from being integrated into the main branch."

Use that last quote when you get to DAST (see §5) — it establishes "Qodana is one gate among several" as a *normal, customer-proven* architecture rather than a gap.

---

## 3. Comparison table (customer-safe)

Sourced from the public JetBrains comparison, March 2026.

| Dimension | Qodana | SonarQube |
|---|---|---|
| **Rule/gate configuration** | Inspection profiles stored **in your repository**, version-controlled in Git, changes reviewed via PR | Rules configured in the **UI**; quality profiles stored in the internal database; not version-controlled with code. A feature request for config-as-code (`sonar-config.yml`) **was declined** |
| **Pricing model** | Per **active contributor**, unlimited LOC, unlimited projects | Per **lines of code** |
| **List price** | Ultimate USD 5/dev/mo (USD 60/yr); Ultimate Plus USD 15/dev/mo (USD 180/yr); min. 3 contributors | Not publicly available at Enterprise tier |
| **IDE ↔ CI consistency** | Same JetBrains inspection engine in IDE and CI | SonarQube for IDE is a plugin layer doing its own on-the-fly analysis; CI engine remains separate |
| **Language coverage** | 16+ languages, 46+ frameworks | 34+ languages (broader) |
| **Deployment** | Cloud, Self-Hosted, On-Prem. **Analysis always runs in your CI** — even with Cloud, only results are transmitted | Cloud, Server, Data Center |
| **Security** | SAST, taint analysis, vulnerable dependency + API checks, third-party licence audit, SBOM (Ultimate Plus) | Full SAST, secret detection, OWASP/PCI/CWE standards |
| **Custom rules** | FlexInspect (selected languages) | Custom Java inspections ("complex to implement") |
| **Support** | Around-the-clock JetBrains support on all licences; professional services for self-hosted | "No commercial support included; premium support 24/7 for a fee" |
| **Baseline / legacy debt** | Baseline workflow — accept existing issues, gate only new code | "New code period" workflow (equivalent) |

**Where Sonar is genuinely stronger — say this out loud:** broader language coverage (34+ vs 16+), a larger install base and community, and PR/branch *decoration* in its own UI. If RTA's estate leans heavily on languages Qodana doesn't cover, that is a real constraint, not a talking point to dodge.

---

## 4. On-prem & data residency (UAE)

This is where the conversation will go, and Qodana has a clean answer:

- **Analysis never runs on JetBrains infrastructure.** The linters execute on your CI server. Even with Qodana Cloud, only *results* are transmitted — never the codebase. Kai Schmithuesen's phrasing is the one to reuse: *"The linters sit on your CI server. Even with the cloud version we only transfer the results to our server, never the whole code base."*
- **Qodana Self-Hosted / On-Prem** removes the question entirely — reports, history, and dashboards all stay inside RTA infrastructure. Deployment via CLI installer or Kubernetes Helm chart. Docs: <https://www.jetbrains.com/help/qodana/shl-introduction.html>
- **Air-gap friendly:** *"Any Qodana linter is a Linux Docker image, so any CI/CD platform that supports Docker should be able to run it."*
- **Self-Hosted Lite** is the lighter on-prem variant — a good "first step" when the driver is compliance rather than the full enterprise feature set.
- JetBrains is **SOC 2 certified**.

⚠️ **Do not reuse the EU argument.** The SOC2 + "AWS in Ireland / subject to EU data privacy regulation" framing is an *EU residency* pitch and does nothing for a UAE requirement. For RTA, the answer is **Self-Hosted**, full stop.

**Sonar comparison point:** SonarQube self-hosted exists too — this is not a Qodana-only capability. The differentiator is that Qodana Self-Hosted keeps **contributor-based pricing** on-prem, whereas Sonar's self-hosted model remains LOC-based.

---

## 5. The DAST problem — handle this honestly

**RTA asked for "SAST & DAST." Qodana is SAST only.** There is no DAST capability in Qodana and no JetBrains DAST product. This is confirmed across every internal document reviewed — the term "DAST" does not appear in the Qodana sales brief, the GFSA PoC scope, or the public comparison.

**Do not blur this.** In a government procurement, a claim that doesn't survive technical evaluation costs the deal and the relationship.

The framing that works (and is already validated by the Evri architecture):

> "JetBrains provides first-party SAST through Qodana — static analysis, taint analysis, vulnerable dependencies, and third-party licence audit with SBOM export. For DAST, JetBrains does not ship a scanner, and we won't pretend otherwise. What we provide is the **spine**: TeamCity orchestrates a best-of-breed DAST scanner — OWASP ZAP is free and open-source, or your existing commercial tool — as a pipeline gate alongside Qodana, exactly as Evri runs Qodana and Snyk in parallel. You get one pipeline, one set of gates, and honest coverage on both axes."

This honesty is itself differentiating against vendors claiming "one platform covers everything" — and it's already the posture in the PoC brief (`poc-description.md` §5.2, "honest scoping note"). The local SAST+DAST demo stack in `RTA-SAST-DAST-POC-GUIDE.md` demonstrates exactly this architecture.

---

## 6. Objection handling — INTERNAL

| Objection | Response |
|---|---|
| **"We already have Sonar / we're locked in."** | Don't attack the tool — attack the *governance model*. "Who can change a quality rule today, and where is that change recorded?" With Sonar the answer is a UI and a database; with Qodana it's a merge request. Then Evri: their vendor teams were writing their own rules to pass their own gates. |
| **"Sonar is cheaper / we've already paid."** | Reframe from licence cost to LOC exposure: they pay for every legacy line across a multi-vendor estate they rarely touch. Ask for their LOC tier and contributor count and build a like-for-like table. Mention competitive discount exists (see §7) **without quoting a number until confirmed**. |
| **"Sonar supports more languages."** | True — 34+ vs 16+. Concede it, then scope it: which languages are in the *target application*? Qodana covers Spring Boot/Java, .NET, Node.js/TS, Python — the "modern stack" tier of RTA's estate. For Mendix/Blue Prism/Informatica, *neither* tool helps, and that's a process-governance conversation. |
| **"Is Qodana mature enough?"** | Battle-card-stated weakness, verbatim: **"SonarQube has a bigger market share, more support from users, and more features."** Counter with: same inspection engine used by millions of JetBrains IDE users for 20+ years; the engine isn't new, the CI packaging is. Named customers: Netflix (⚠️ do not name publicly), Meta/Oculus, Evri, Credit Acceptance. |
| **"Can you do DAST?"** | See §5. Never claim yes. |
| **"Price is too high."** | Battle-card guidance: "Highlight ROI, cost savings over time, and competitive differentiation. Volume discount in some cases to be competitive." |

**Sonar's stated strengths (know your enemy, verbatim):** *"10x the resources · Dominant in market · Greater functionality · More community support"* — Sonar holds ~94% market share in code quality.

**Sonar's stated weaknesses (verbatim):** *"Weaker integration with JB IDEs · Charges by lines of code instead of contributor · Ignores many unhappy clients and basically no media monitoring and responding · SonarQube stores its configuration (like quality rules, overrides, and profiles) in its server UI/database, instead of allowing you to define and manage these settings as code inside your repository"*

---

## 7. Commercial — INTERNAL

**Qodana Self-Hosted: EUR 240 / year / contributor.** Qodana Cloud (Ultimate Plus equivalent): EUR 180 / year / contributor. Cloud list: Ultimate USD 60/yr, Ultimate Plus USD 180/yr, min. 3 contributors.

**Competitive displacement discount: 25% on the first year** for customers holding a competing commercial tool. Evidence required is *"an invoice or renewal offer from SonarQube. You can feel free to black out the numbers if you prefer."* SonarQube Developer Edition (self-hosted) was accepted as qualifying on a recent deal.

⚠️ **Confirm before quoting.** That 25% comes from a single rep email on a single Swiss SMB deal (Zendesk 8691599, Kai Schmithuesen), not a published policy. In a UAE government tender a discount promise is effectively irrevocable. Get it confirmed by the Qodana team — Kai Schmithuesen owns it — before it appears in anything RTA sees. **No Self-Hosted contributor minimum is documented**; do not assert one.

**Trials:** Cloud 60 days unlimited; Self-Hosted up to 90 days unlimited, licence issued manually by the Qodana solutions engineer. No self-service Self-Hosted trial exists.

**Two ICP mismatches to know internally:** the stated Qodana ICP geography is *"USA, UK, Western Europe"* — no GCC — so **there are no regional reference customers** in our material. And *"Minimum 100 developers to make it worth pursuing actively"* (RTA clears this easily). Our only Gulf-government precedent is **GFSA (General Food Security Authority, KSA)**, and that is a PoC *scope document*, not a completed reference — don't present it as a case study.

---

## 8. Reusing the GFSA PoC shape for RTA — INTERNAL

GFSA is our closest precedent: a Gulf government body, on-prem constraints, Qodana + TeamCity + IDE Services against their existing GitLab. Structure worth lifting:

- **~4 weeks, primarily remote, one pilot application** — a "vertical slice" taken end-to-end rather than an estate-wide assessment.
- Week 0 prep → W1 kickoff/discovery/install → W2 pipeline + Qodana analysis → W3 gates + governance artifacts → W4 review against success criteria.
- **Success criteria written as acceptance tests**, e.g. *"Qodana produces static-analysis and SAST findings and operates as a gate that flags/blocks failing code"* and *"…within GFSA's on-premises/data-residency constraints."* Note how data residency is framed as a **criterion to be verified**, not a marketing claim.
- **Explicitly out of scope:** *"Remediation of Qodana findings or achieving a specific security/safety index score (the PoC surfaces findings; it does not fix them)."* Steal this line verbatim for RTA — it prevents the PoC from becoming an unpaid remediation project.
- Deliverable that will land well with RTA: **SPDX licence export** for third-party dependency governance.

**Adaptation needed for RTA:** GFSA had no DAST requirement; RTA does. Add the third-party DAST scanner as an explicit pipeline step and success criterion, and scope it honestly per §5.

---

## 9. Sources

**Internal (do not share externally):**
- Sales Brief — Qodana (Kerry Beetge, Apr 2026) — <https://drive.google.com/file/d/17Eynh2T7cAFWgXWZKz0G05OwKiQwyErb> ⚠️ *Internal, partially unfinished — several unfilled template placeholders and an empty security/compliance FAQ. Do not quote as a public JetBrains claim, and do not share with RTA.*
- Qodana Battle Cards (Miro, Emma Ghrejyan) — <https://miro.com/app/board/uXjVH9T-7DE=>
- GFSA PoC Scope Document — <https://docs.google.com/document/d/1QaRXCTnksQ1KxEs660D1JWn3CgERVkgndIGjtDXNrAI>
- Zendesk 8691599, competitive discount — <https://jbs.zendesk.com/agent/tickets/8691599>
- Slack thread (Alexander Costa's battle-card request) — <https://jetbrains.slack.com/archives/C0BBFG7B17S/p1786001787689719>

**Public (safe to share / cite to RTA):**
- SonarQube vs. Qodana — <https://blog.jetbrains.com/qodana/2026/03/sonarqube-vs-qodana/>
- Qodana Self-Hosted introduction — <https://www.jetbrains.com/help/qodana/shl-introduction.html>
- Qodana pricing — <https://www.jetbrains.com/qodana/buy/>
- Evri case study — <https://blog.jetbrains.com/qodana/tag/case-studies/>

---

## 10. Open items before the next RTA call

1. **Confirm the 25% competitive discount** with the Qodana team (Kai Schmithuesen) before it is mentioned to RTA.
2. **Get RTA's Sonar numbers** — edition, LOC tier, contributor count, renewal date — to build the like-for-like cost table. Renewal date is the wedge.
3. **Confirm the target application's languages** against Qodana's 16+ coverage before promising SAST depth.
4. **Decide the DAST scanner** — OWASP ZAP for the PoC, or does RTA already own a commercial DAST tool we should orchestrate instead?
5. **Ask whether Sonar stays.** Coexistence (Qodana on the pilot app alongside Sonar elsewhere) is a much easier first sale than displacement, and the PoC proves the difference on real code.

*Prepared 6 Aug 2026.*
