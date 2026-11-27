#!/usr/bin/env python3
"""Build the RTA-facing Qodana value-proposition / SonarQube-comparison .docx.

Customer-safe: public sources only. On-premises framing throughout.
"""
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.opc.constants import RELATIONSHIP_TYPE as RT
import sys

# Canonical source URLs — referenced inline throughout the document.
URL_COMPARISON = "https://blog.jetbrains.com/qodana/2026/03/sonarqube-vs-qodana/"
URL_PRODUCT = "https://www.jetbrains.com/qodana/"
URL_PRICING = "https://www.jetbrains.com/qodana/buy/"
URL_SELFHOSTED = "https://www.jetbrains.com/help/qodana/shl-introduction.html"
URL_DOCS = "https://www.jetbrains.com/help/qodana/about-qodana.html"

OUT = sys.argv[1] if len(sys.argv) > 1 else "RTA-Qodana-Value-Proposition.docx"

DARK = RGBColor(0x1A, 0x1A, 0x1A)
ACCENT = RGBColor(0x00, 0x62, 0xB1)   # JetBrains-ish blue
GREY = RGBColor(0x5A, 0x5A, 0x5A)
HDR_FILL = "1F3B57"
ALT_FILL = "F2F5F8"

doc = Document()

# ── Page setup (A4) ──
for s in doc.sections:
    s.page_width, s.page_height = Cm(21.0), Cm(29.7)
    s.top_margin = s.bottom_margin = Cm(2.0)
    s.left_margin = s.right_margin = Cm(2.2)

# ── Base style ──
st = doc.styles["Normal"]
st.font.name = "Calibri"
st.font.size = Pt(10.5)
st.font.color.rgb = DARK
st.paragraph_format.space_after = Pt(6)
st.paragraph_format.line_spacing = 1.15


def shade(cell, hexfill):
    el = OxmlElement("w:shd")
    el.set(qn("w:val"), "clear")
    el.set(qn("w:fill"), hexfill)
    cell._tc.get_or_add_tcPr().append(el)


def h(text, size=15, color=ACCENT, before=14, after=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.keep_with_next = True
    r = p.add_run(text)
    r.bold = True
    r.font.size = Pt(size)
    r.font.color.rgb = color
    return p


def para(text, size=10.5, italic=False, color=DARK, after=6, bold=False):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(after)
    r = p.add_run(text)
    r.italic = italic
    r.bold = bold
    r.font.size = Pt(size)
    r.font.color.rgb = color
    return p


def bullet(text, bold_lead=None):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(4)
    if bold_lead:
        r = p.add_run(bold_lead)
        r.bold = True
        r.font.size = Pt(10.5)
    r = p.add_run(text)
    r.font.size = Pt(10.5)
    return p


def table(headers, rows, widths):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.style = "Table Grid"
    hdr = t.rows[0].cells
    for i, txt in enumerate(headers):
        hdr[i].text = ""
        p = hdr[i].paragraphs[0]
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.space_before = Pt(2)
        r = p.add_run(txt)
        r.bold = True
        r.font.size = Pt(9.5)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        shade(hdr[i], HDR_FILL)
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for i, txt in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(2)
            r = p.add_run(txt)
            r.font.size = Pt(9.5)
            if i == 0:
                r.bold = True
            if ri % 2 == 1:
                shade(cells[i], ALT_FILL)
    for row in t.rows:
        for i, w in enumerate(widths):
            row.cells[i].width = Cm(w)
    return t


def add_hyperlink(paragraph, text, url, size=10.5):
    """Insert a real, clickable external hyperlink into a paragraph."""
    r_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    col = OxmlElement("w:color")
    col.set(qn("w:val"), "0062B1")
    rPr.append(col)
    und = OxmlElement("w:u")
    und.set(qn("w:val"), "single")
    rPr.append(und)
    sz = OxmlElement("w:sz")
    sz.set(qn("w:val"), str(int(size * 2)))
    rPr.append(sz)
    rf = OxmlElement("w:rFonts")
    rf.set(qn("w:ascii"), "Calibri")
    rf.set(qn("w:hAnsi"), "Calibri")
    rPr.append(rf)
    run.append(rPr)
    t = OxmlElement("w:t")
    t.text = text
    t.set(qn("xml:space"), "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)
    return link


def rich(segments, size=10.5, after=6, italic=False, color=DARK, bullet_style=False):
    """Paragraph built from mixed segments.

    Each segment is either a plain string, ("text", "b") for bold,
    or ("text", "https://...") for a clickable link.
    """
    p = doc.add_paragraph(style="List Bullet") if bullet_style else doc.add_paragraph()
    p.paragraph_format.space_after = Pt(after)
    for seg in segments:
        if isinstance(seg, tuple):
            txt, kind = seg
            if kind and str(kind).startswith("http"):
                add_hyperlink(p, txt, kind, size=size)
                continue
            r = p.add_run(txt)
            r.bold = (kind == "b")
            r.italic = italic if kind != "b" else False
            r.font.size = Pt(size)
            r.font.color.rgb = color
        else:
            r = p.add_run(seg)
            r.italic = italic
            r.font.size = Pt(size)
            r.font.color.rgb = color
    return p


# ══════════════ TITLE ══════════════
tp = doc.add_paragraph()
tp.paragraph_format.space_after = Pt(2)
r = tp.add_run("Qodana for RTA")
r.bold = True
r.font.size = Pt(26)
r.font.color.rgb = ACCENT

sp = doc.add_paragraph()
sp.paragraph_format.space_after = Pt(10)
r = sp.add_run("Code quality and security governance, deployed on-premises")
r.font.size = Pt(13)
r.font.color.rgb = GREY

meta = doc.add_paragraph()
meta.paragraph_format.space_after = Pt(2)
r = meta.add_run("Prepared for:  ")
r.bold = True
r.font.size = Pt(10)
r = meta.add_run("Roads and Transport Authority (RTA)")
r.font.size = Pt(10)

meta2 = doc.add_paragraph()
meta2.paragraph_format.space_after = Pt(2)
r = meta2.add_run("Prepared by:  ")
r.bold = True
r.font.size = Pt(10)
r = meta2.add_run("JetBrains Professional Services")
r.font.size = Pt(10)

meta3 = doc.add_paragraph()
meta3.paragraph_format.space_after = Pt(12)
r = meta3.add_run("Date:  ")
r.bold = True
r.font.size = Pt(10)
r = meta3.add_run("August 2026")
r.font.size = Pt(10)

# horizontal rule
hr = doc.add_paragraph()
hr.paragraph_format.space_after = Pt(12)
pbdr = OxmlElement("w:pBdr")
bot = OxmlElement("w:bottom")
bot.set(qn("w:val"), "single")
bot.set(qn("w:sz"), "12")
bot.set(qn("w:color"), "0062B1")
pbdr.append(bot)
hr._p.get_or_add_pPr().append(pbdr)

# ══════════════ 1. EXECUTIVE SUMMARY ══════════════
h("1.  Executive summary", size=15, before=0)
para(
    "RTA has described an estate delivered largely by external vendors across a wide range of technologies, "
    "with limited visibility into the quality of the code being received, no white-box testing of vendor "
    "deliverables, and no automated way to flag non-compliance against RTA's own standards."
)
para(
    "Qodana is JetBrains' static code analysis and SAST (Static Application Security Testing) platform. It applies "
    "the same inspection engine that RTA's developers already rely on inside JetBrains IDEs, but runs it inside "
    "CI/CD pipelines as an automated, enforceable gate. Three properties make it directly relevant to RTA's "
    "governance objective:"
)
bullet("the rules RTA wants enforced are stored as files in the repository, version-controlled and reviewable — not locked inside a server UI, and not editable by the vendor being measured.", "Standards become code — ")
bullet("Qodana analysis runs entirely within RTA's own infrastructure. Source code does not leave RTA at any point.", "It runs on RTA's premises — ")
bullet("a failing quality or security gate stops a non-compliant deliverable before it is accepted, giving RTA an objective, automated basis for the vendor conversation.", "It creates vendor accountability — ")
rich(
    [
        "This document sets out where Qodana adds value for RTA and, where a meaningful comparison exists, how it "
        "differs from SonarQube. All statements are drawn from published JetBrains sources, listed in section 10; "
        "the primary reference is JetBrains' published comparison, ",
        ("SonarQube vs. Qodana", URL_COMPARISON),
        ".",
    ],
    italic=True, color=GREY,
)

# ══════════════ 2. THE PROBLEM ══════════════
h("2.  The problem this addresses")
para(
    "RTA's own assessment identifies four issues. The table below maps each to the specific capability that "
    "responds to it."
)
table(
    ["RTA's stated issue", "How Qodana responds"],
    [
        ("Fragmentation — multiple vendors on disparate technology stacks, working in isolation",
         "A single analysis engine and a single set of quality gates applied uniformly across Java/Spring, .NET, Node.js/TypeScript, Python and more — one standard, many vendors."),
        ("Lack of visibility — RTA cannot confirm whether delivered code is of good quality",
         "Every build produces an objective, quantified report: issues by severity, security findings, dependency and licence position. Evidence rather than assurances."),
        ("Compliance and quality risk — no white-box testing, no centralised guidelines, no automated non-compliance flagging",
         "White-box static analysis and SAST executed automatically on every change, with RTA's rules defined centrally and enforced as a build gate."),
        ("Disconnect between delivered code and intended architecture",
         "Inspection profiles encode RTA's standards explicitly; deviations surface as findings tied to a specific file and line, with the responsible change identified."),
    ],
    [7.6, 8.9],
)

# ══════════════ 3. WHAT QODANA IS ══════════════
h("3.  What Qodana is")
para(
    "Qodana brings JetBrains IDE inspections directly into CI/CD pipelines. It is designed around configuration "
    "as code, CI-native workflows, version-controlled inspection profiles, and integration with widely used IDEs."
)
bullet("static code analysis, SAST, quality gates, code coverage, third-party licence audit and SBOM export.", "What it does: ")
bullet("inside RTA's CI/CD system, as a Linux Docker image. Any CI platform that can run Docker can run Qodana — including TeamCity, GitLab, Jenkins, GitHub Actions and Azure Pipelines.", "Where it runs: ")
bullet("JVM (including Spring and Jakarta EE), Android, .NET, Python (including Django and Flask), C and C++, PHP, Web (JavaScript, TypeScript), Go, with MISRA analysis available and Ruby announced.", "Languages: ")
rich([
    ("Note for RTA: the three modern stacks identified in RTA's estate — Spring Boot, .NET Core and Node.js — are "
     "all covered directly by Qodana.", "b"),
    " The full, current language and framework matrix per plan is published at ",
    ("jetbrains.com/qodana/buy", URL_PRICING),
    ".",
])

# ══════════════ 4. VALUE ══════════════
h("4.  Where Qodana adds value for RTA")

h("4.1  Standards enforced as code, not as configuration in a console", size=12, color=DARK, before=10, after=4)
para(
    "With Qodana, inspection profiles live in the repository. Rules are version-controlled in Git, changes to the "
    "quality configuration are reviewed through pull requests, and the configuration evolves alongside the codebase. "
    "For shared standards across many projects, Qodana's Global Project Configuration keeps configuration file-based: "
    "a central repository of shared inspection files distributed across projects, still under version control."
)
para(
    "SonarQube does not natively support storing quality profiles or quality gates in source control. Rules are "
    "configured in the SonarQube user interface, quality profiles are held in the internal database, and core rule "
    "overrides are not version-controlled with the code. A feature request for configuration as code was declined, "
    "with SonarSource emphasising the benefits of centralised configuration."
)
para(
    "Why this matters to RTA: when standards are files under change control, RTA can demonstrate which rules were "
    "in force at the moment a vendor deliverable was accepted, and can require that any change to those rules goes "
    "through RTA's own review. This is the practical mechanism behind \"governance as code\".",
    bold=True,
)

h("4.2  Consistency between the developer's IDE and the pipeline", size=12, color=DARK, before=10, after=4)
para(
    "Qodana uses the same inspection engine that powers JetBrains IDEs such as IntelliJ IDEA, PyCharm and Rider, as "
    "well as integrations for VS Code and Visual Studio. A finding raised in CI is reproducible on the developer's "
    "machine, which reduces disputes about whether a finding is real."
)
rich([
    "SonarQube integrates with IDEs through the SonarQube for IDE extension, which operates as a plugin layer "
    "performing its own on-the-fly analysis while the CI engine remains separate. JetBrains' published comparison "
    "notes that this can lead to inconsistencies with the IDE's built-in inspections (",
    ("SonarQube vs. Qodana", URL_COMPARISON),
    "). For RTA, engine consistency means a vendor cannot dispute a gate failure on the grounds that the finding "
    "does not reproduce locally.",
])

h("4.3  Analysis stays inside RTA's infrastructure", size=12, color=DARK, before=10, after=4)
para(
    "Qodana's linters execute on RTA's own CI servers. This is true of every deployment mode — the code being "
    "analysed is never uploaded to JetBrains. For RTA's on-premises requirement, Qodana Self-Hosted additionally "
    "keeps the reporting and dashboard layer inside RTA's environment, so findings, history and reports also remain "
    "on RTA infrastructure. Section 6 covers deployment in detail."
)

h("4.4  Security and compliance coverage", size=12, color=DARK, before=10, after=4)
bullet("static application security testing on the codebase.", "SAST: ")
bullet("tracks untrusted input through the code to identify injection-class vulnerabilities.", "Taint analysis: ")
bullet("identifies dependencies with known vulnerabilities and unsafe API usage.", "Vulnerable dependencies and API checks: ")
bullet("identifies the licences of third-party components, with SBOM output — directly useful for procurement and open-source governance obligations.", "Third-party licence audit and SBOM: ")
bullet("builds fail when thresholds are exceeded; custom gates are supported.", "Quality gates: ")
para(
    "These capabilities are included in the Qodana Self-Hosted plan rather than distributed across separate editions "
    "or add-on tiers, so RTA's security and compliance coverage does not depend on which licence level was purchased."
)

h("4.5  Managing existing technical debt without blocking delivery", size=12, color=DARK, before=10, after=4)
para(
    "A concern when introducing analysis to an established codebase is being overwhelmed by historical findings. "
    "Qodana's baseline workflow accepts the existing set of issues and gates only newly introduced ones, so RTA can "
    "enforce a standard from a given date forward — holding vendors to it on all new work — without halting "
    "delivery or requiring a remediation programme first."
)

# ══════════════ 5. COMPARISON ══════════════
h("5.  Qodana compared with SonarQube")
rich([
    "Both platforms perform static analysis and both support quality gates, auditing and compliance capabilities. "
    "The differences are in configuration model, deployment, engine consistency and licensing. The table below is "
    "drawn from JetBrains' published comparison, ",
    ("SonarQube vs. Qodana (March 2026)", URL_COMPARISON),
    ".",
])
table(
    ["Dimension", "Qodana", "SonarQube"],
    [
        ("Rule and gate configuration",
         "Inspection profiles stored in the repository; version-controlled in Git; changes reviewed via pull request",
         "Rules configured in the UI; quality profiles stored in the internal database; core rule overrides not version-controlled with code"),
        ("Licensing model",
         "Per active contributor; unlimited lines of code and unlimited projects",
         "Per lines of code"),
        ("IDE and CI consistency",
         "Same JetBrains inspection engine in the IDE and in CI",
         "SonarQube for IDE is a plugin layer performing separate on-the-fly analysis; CI engine is separate"),
        ("CI/CD integration",
         "CI-agnostic via Docker and CLI; branch and pull request analysis with quick-fix pull requests",
         "Broad CI support; pull request and branch decoration"),
        ("Security",
         "SAST, taint analysis, vulnerable dependency and API checks, third-party licence audit, SBOM",
         "SAST, secret detection, security standard mappings including OWASP, PCI and CWE"),
        ("Language coverage",
         "16+ languages and 46+ frameworks, covering RTA's Spring Boot, .NET and Node.js stacks",
         "34+ languages"),
        ("Custom rules",
         "FlexInspect (currently selected languages)",
         "Custom Java inspections, described in the comparison as complex to implement"),
        ("Handling existing debt",
         "Baseline workflow",
         "New code period workflow"),
        ("Support",
         "Round-the-clock JetBrains support on all licences; professional services available for self-hosted deployments",
         "Commercial support not included; premium 24/7 support available for a fee"),
        ("On-premises deployment",
         "Qodana Self-Hosted, via CLI installer or Kubernetes Helm chart",
         "Available"),
    ],
    [3.7, 6.4, 6.4],
)

para("")
para("Where Qodana is the strongest fit", bold=True, after=4)
rich([
    "JetBrains' published comparison (",
    ("SonarQube vs. Qodana", URL_COMPARISON),
    ") identifies Qodana as the better choice where an organisation prefers configuration as code and Git-native "
    "rule management, practises CI-first development, has a large codebase and does not wish to be charged by "
    "lines of code, uses JetBrains IDEs alongside VS Code or Visual Studio, or requires comprehensive support "
    "regardless of licence tier.",
])
para(
    "Each of these applies directly to RTA: a large, vendor-delivered estate where standards must be enforceable "
    "and auditable, where cost should track the number of people working rather than the volume of legacy code "
    "held, and where support must be available irrespective of the tier purchased.",
    bold=True,
)

# ══════════════ 6. ON-PREM ══════════════
h("6.  On-premises deployment")
para(
    "RTA's requirement is for an on-premises solution. Qodana addresses this on two levels."
)
para("6.1  Analysis always runs on RTA infrastructure", bold=True, after=4)
rich([
    "Qodana's linters are Linux Docker images that execute on RTA's own CI servers. The code being analysed is "
    "processed in place and is never transmitted to JetBrains. Because any CI platform capable of running Docker "
    "can run Qodana, this holds in restricted and disconnected network environments. See ",
    ("Qodana documentation", URL_DOCS),
    ".",
])
para("6.2  Qodana Self-Hosted — the reporting layer on RTA infrastructure", bold=True, after=4)
rich([
    "Qodana Self-Hosted is the on-premises edition. It includes all features from the Qodana Ultimate Plus plan and "
    "keeps sensitive code and data within RTA's own infrastructure, which JetBrains positions specifically for "
    "organisations that must operate within strict security or compliance standards. Full deployment documentation: ",
    ("Overview of self-hosting", URL_SELFHOSTED),
    ".",
])
table(
    ["Aspect", "Detail"],
    [
        ("Deployment options", "Kubernetes — a Helm-based chart deploying all Qodana services and dependencies as Kubernetes resources, customisable through a values.yaml file; or Docker — a one-line installer via the qodana-installer-cli utility, requiring a Linux server with Docker Engine and Docker Swarm, and compatible with Infrastructure-as-Code frameworks."),
        ("Feature scope", "All features from the Qodana Ultimate Plus plan."),
        ("Data handling", "Code and analysis data remain within RTA's infrastructure."),
        ("Minimum size", "5 active contributors."),
        ("Commercial model", "Custom pricing, with volume discount available."),
    ],
    [3.7, 12.8],
)
para(
    "JetBrains recommends confirming the current release status, sizing and hardware requirements for Self-Hosted "
    "with the JetBrains team as part of PoC planning, so that the deployment is matched to RTA's scale and security "
    "posture.",
    italic=True, color=GREY,
)

# ══════════════ 7. LICENSING ══════════════
h("7.  Licensing model and published pricing")
rich([
    "Qodana is licensed per active contributor rather than per line of code. An active contributor is defined by "
    "JetBrains as anyone who has made a commit to a registered project within the last 90 days, regardless of when "
    "those commits were originally authored. Within the same organisation, one contributor may work on unlimited "
    "projects and requires only one licence. Full terms and current prices: ",
    ("Qodana subscription options and pricing", URL_PRICING),
    ".",
])
para(
    "For an estate the size of RTA's — with substantial legacy code that is maintained rather than actively "
    "developed — this distinction is material: cost is driven by the number of people working, not by the total "
    "volume of code held.",
    bold=True,
)
table(
    ["Plan", "Published price", "Notes"],
    [
        ("Self-Hosted\n(relevant to RTA)", "Custom pricing\nVolume discount available",
         "On-premises. Includes all Ultimate Plus features. Minimum 5 active contributors."),
        ("Ultimate Plus", "EUR 15.00 per active contributor / month\n(billed annually at EUR 180.00)",
         "Reference point for the licensing model. Minimum 3 active contributors."),
        ("Ultimate", "EUR 5.00 per active contributor / month\n(billed annually at EUR 60.00)",
         "Reference point for the licensing model. Minimum 3 active contributors."),
        ("Community", "Free",
         "Limited language coverage (JVM, Java for Android, Python, .NET, C, C++); no framework support."),
    ],
    [3.5, 6.0, 7.0],
)
para(
    "Prices shown are the published list prices at the time of writing, exclusive of VAT, and are provided to "
    "illustrate the licensing model. A formal quotation for RTA's on-premises deployment will be issued separately.",
    italic=True, color=GREY,
)

# ══════════════ 8. SAST & DAST ══════════════
h("8.  Scope note: SAST and DAST")
para(
    "RTA has asked specifically about both static and dynamic application security testing. JetBrains is direct "
    "about where its own coverage begins and ends."
)
bullet("provided by Qodana as a first-party product, as described in this document.", "SAST — ", )
bullet("JetBrains does not produce a DAST scanner. Dynamic testing is performed by a dedicated third-party tool, which is orchestrated as a stage in the CI/CD pipeline alongside Qodana. Established open-source options such as OWASP ZAP are available at no licence cost, and any commercial DAST product RTA already owns can be integrated in the same way.", "DAST — ")
para(
    "In practice this is a normal and well-proven architecture: the CI/CD platform — TeamCity, in the JetBrains "
    "stack — acts as the single spine, with static and dynamic gates running as parallel stages and each returning "
    "its verdict against the same change. RTA gets one pipeline, one set of gates and one governance model, with "
    "honest coverage on both axes rather than a single tool claimed to do everything."
)

# ══════════════ 9. NEXT STEP ══════════════
h("9.  Suggested next step")
para(
    "The most effective way to evaluate the above is a contained proof of concept on one RTA application, run "
    "end-to-end on RTA infrastructure. This first step focuses on Qodana — establishing static analysis, SAST and "
    "an enforceable quality gate on real vendor code. A typical shape is approximately four weeks:"
)
bullet("confirm the pilot application, provision the on-premises environment, and establish access.", "Week 1 — ")
bullet("deploy the pipeline and run the first full Qodana analysis against the vendor codebase.", "Week 2 — ")
bullet("configure RTA's standards as inspection profiles and enable the quality gate.", "Week 3 — ")
bullet("review the findings against agreed success criteria and present a recommendation to RTA.", "Week 4 — ")
para(
    "The output is a concrete, evidence-based report on one real application — the discrepancy and gap-scan "
    "findings — plus a working pipeline that RTA retains and can extend to further applications."
)
para(
    "Subsequent stages — including dynamic testing, additional applications and wider rollout across the estate — "
    "are best scoped once this first step has produced real findings on RTA code, and can be discussed at that point."
)

# ══════════════ 10. SOURCES ══════════════
h("10.  Sources")
para("All statements in this document are drawn from the following published JetBrains sources:", after=4)
for label, url in [
    ("SonarQube vs. Qodana — JetBrains comparison, March 2026", URL_COMPARISON),
    ("Qodana product overview", URL_PRODUCT),
    ("Qodana subscription options and pricing", URL_PRICING),
    ("Qodana Self-Hosted — overview of self-hosting", URL_SELFHOSTED),
    ("Qodana documentation", URL_DOCS),
]:
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(3)
    r = p.add_run(label + " — ")
    r.font.size = Pt(9.5)
    add_hyperlink(p, url, url, size=9.5)

doc.save(OUT)
print(f"wrote {OUT}")
