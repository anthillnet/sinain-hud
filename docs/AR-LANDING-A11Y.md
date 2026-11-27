# sinain.com/ar — accessibility and product-accuracy pass

Date: 2026-09-15. Status: binding spec for the implementation job. Scope:
`docs/ar/index.html` (the ARSinain landing page), plus two small fixes in
`docs/register/index.html` and `docs/privacy.html`. The main Mac landing page
(`docs/index.html`) is out of scope here; it has the same landmark gaps and should
get the same treatment later.

## Why now
The AR app (ar.sinain.com, repo `ARSinain`) shipped an accessible assistance mode
on 2026-09-15 (`ARSinain/docs/DESIGN-A11Y-PILOT.md`): Describe scene, Read text,
Find object, spoken answers with a readable answer panel, screen-reader operable
controls, honest "I can't see that" behaviour. Recruitment for the blind-user pilot
goes through this landing page, and the outreach notes are explicit: "an inaccessible
offering cannot be meaningfully tested". The page must be operable with VoiceOver and
TalkBack and must not describe a product that no longer exists.

## Audit of `docs/ar/index.html` (as of commit f33a52d)

Accessibility:
| # | finding | fix |
|---|---|---|
| A1 | No `<main>`; sections sit directly in `<body>`; no skip link | `<a class="skip" href="#main">Skip to content</a>` as first body child (visible on focus); wrap hero → demo in `<main id="main">` |
| A2 | No `:focus-visible` style anywhere; links rely on the browser default over custom backgrounds | global `a:focus-visible, button:focus-visible, .btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px }`; on `.cta-card` (dark) use `outline-color: #fff` |
| A3 | `--fg-faint` (#94a3b8) on white is 2.56:1; used for `.logo .sub`, `.meta .k`, `.ft-meta`, footer h5 | change `--fg-faint` to `#64748b` (4.76:1). Keep the variable name |
| A4 | Animated voice dot and equaliser bars (`@keyframes pulse`, `eq`), pillar hover translate; no `prefers-reduced-motion` | add `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important } }` |
| A5 | `nav.primary` is `display:none` below 1000px with no replacement | below 1000px render the same four links as a horizontal, wrapping row under the top bar (`.top-inner` becomes two rows); never hide the nav |
| A6 | Header SVG has `aria-label` but no `role="img"`; footer SVG has neither | header: `role="img" aria-label="Sinain"`; footer SVG `aria-hidden="true"` (the text "SINAIN" beside it is enough) |
| A7 | `<span class="pill">● live · ar.sinain.com</span>`: the bullet is read aloud | `<span class="pill pill-good"><span aria-hidden="true">●</span> Live at ar.sinain.com</span>` |
| A8 | `.arr` arrows "→" inside buttons are read as "right arrow" | `<span class="arr" aria-hidden="true">→</span>` everywhere |
| A9 | `.meta` is a `<div aria-label>` (no role → label ignored), items are spans | make it `<ul class="meta" aria-label="At a glance">` with `<li>` items; visually unchanged |
| A10 | Phone mockup `<div class="phone" aria-label>` is a div with a label but no role; its inner text ("SINAIN", tip text, "listening…") is read as content | `<div class="phone" role="img" aria-label="Illustration: a phone showing the camera view with a red mug highlighted and Sinain's spoken tip below it">` and `aria-hidden="true"` on `.screen` so the fake UI text is not read twice |
| A11 | Meetings section starts at `<h3>` with no `<h2>`; footer uses `<h5>` | meetings: `h2` (styled like the other `sec-title`s); footer column headings: `<h2 class="ft-h">` with the current small style |
| A12 | Links that open a new tab (`target="_blank"`) give no warning | append `<span class="sr-only"> (opens in a new tab)</span>`; add the `.sr-only` utility class |
| A13 | Decorative SVG icons in tour cards, pillars, privacy modes have no `aria-hidden` | `aria-hidden="true"` on every inline decorative `<svg>` |
| A14 | `<em>` in the h1 is styling only | fine; leave. `<strong>` in body copy is fine |
| A15 | Analytics/pixel: no change requested | leave as is |

Product accuracy (text that is wrong or missing today):
| # | current text | replacement |
|---|---|---|
| P1 | Hero fineprint: "Nothing to download — it opens right in your phone's browser. Free while we're in preview." | "Nothing to download — it opens in your phone's browser. You sign in with Google, and access is by invitation while we're in preview." |
| P2 | Step 1: "Tap once to start. It opens right in your phone's browser — no app, no sign-up hoops." | "Open the link on your phone and sign in. It runs in the browser — no app to install." |
| P3 | Step 2 "Point or tap … Sinain highlights it" | keep, add one sentence: "If you can't see the screen, the buttons and voice do the same job." |
| P4 | Step 3 "Just ask" | keep; add "Say stop to interrupt, or ask it to repeat." |
| P5 | Capabilities lede and cards | keep the six cards; rename "What does this say?" body to: "A menu, a sign, a label, a letter. Sinain reads it out word for word and tells you if part of it is cut off or too blurry to read." |
| P6 | NEW section between Capabilities and Meetings: `id="access"`, `§ 03 — Works without seeing the screen` | see "New section" below. Renumber Meetings → § 04, Privacy → § 05; add "Accessibility" to the nav and footer product list |
| P7 | Privacy lede: "It only looks when there's something worth looking at, your video is encrypted end-to-end, and sensitive details are scrubbed before anything is saved. Only you can get into your Sinain." | "It only looks when the scene changes, your video is encrypted on its way to Sinain and analysed live rather than stored, and sensitive details are scrubbed before anything is remembered. Only you can get into your Sinain." |
| P8 | Privacy mode "Encrypted — Your video and voice are scrambled end-to-end — no one in between can see them." | "Encrypted in transit — Your video and voice are encrypted between your phone and Sinain. Frames are analysed by our AI provider to answer you and are not stored." |
| P9 | Privacy mode "Nothing private saved — Emails, card numbers and passwords are wiped before anything is remembered." | "Memory you can delete — Sinain keeps the conversation and durable facts so it remembers you next time. Emails, card numbers and passwords are wiped first, and you can ask us to delete everything." |
| P10 | Demo CTA copy "…open it on your phone and you're live in seconds." | "…we'll invite your Google account — open the link on your phone, sign in, and you're live." Keep the mailto. Add a second line under the buttons: "Blind or losing your sight? We're preparing a small pilot and would like to hear from you — same email." |
| P11 | Buttons "Try it now" / "Have a link? Open it" → ar.sinain.com | labels: "Open Sinain AR" with sr-only "(needs an invitation; opens in a new tab)" |
| P12 | Footer blurb | "An AI helper that sees through your phone camera and talks with you — built to be used with or without seeing the screen." |
| P13 | `<meta name="description">` | "Point your phone, ask out loud, and get spoken help from an AI that sees what you see. Works with screen readers: describe the scene, read text, find an object." |

### New section (P6), exact structure
```html
<section class="s" id="access">
  <div class="container">
    <div class="sec-head">
      <div class="sec-num">§ 03 — Works without seeing the screen</div>
      <div>
        <h2 class="sec-title">Built for ears first.</h2>
        <p class="sec-lede">Every answer is spoken and also written down, every control is an ordinary
          button that works with VoiceOver and TalkBack, and Sinain says when it can't see well
          enough instead of guessing.</p>
      </div>
    </div>
    <div class="pillars">   <!-- four cards -->
      Describe the scene — "What's in front of me?" A few sentences: the setting, the main things and
        where they are in the camera view — left, right, centre.
      Read text — Labels, letters, menus, screens, read out word for word. If part is cut off or
        blurry, it tells you which part.
      Find an object — Name it and Sinain says where it is in the camera view. If it isn't there,
        it says so and suggests where to turn.
      Stay in control — Stop, repeat, mute the microphone, pause, or end the session with one
        button each. Nothing happens silently.
    </div>
    <p class="fineprint">Not for safety-critical decisions: it is a helper for everyday things, not a
      guide for crossing streets or reading medication.</p>
  </div>
</section>
```
Language rules (from the outreach notes): "people who are blind", "losing their sight"; never
"the blind", no restoration language; do not claim "tested with blind users" — the pilot has
not run yet.

## `docs/register/index.html`
- Analytics script points at `https://analytics.sinain.duckdns.org/script.js` without
  `data-domains`; every other page uses `https://analytics.sinain.com/script.js`
  `data-domains="sinain.com"`. Align it.
- Add the same skip link + `:focus-visible` rule as the AR page (`<main>` already exists).
- The disabled signup link is an `<a aria-disabled>`; keep, but add
  `aria-describedby="consent-hint"` and give the consent row `id="consent-hint"` so the reason is
  announced.

## `docs/privacy.html` — REVIEW BEFORE PUBLISHING
The policy describes the Mac product only ("Sinain stores … never your screen, audio, or
memory") and contradicts the AR service, which keeps a per-user conversation memory on
Sinain's server. Add a section `<h2>Sinain AR (ar.sinain.com)</h2>` before "Third parties":

> Sinain AR is a separate, browser-based service. When you use it, your phone's camera and
> microphone stream to Sinain's server, which analyses frames live with our AI inference
> provider to answer you; frames are not stored. Sinain AR keeps, per account, the text of
> your conversations and durable facts you tell it (your name, preferences), after automatic
> redaction of emails, card numbers, passwords and similar, so it can remember you between
> sessions. It also keeps usage counts for quota. Email sinain-hud@protonmail.com to have
> this memory and your access record deleted.

Bump "Last updated" to 15 September 2026. This paragraph is a draft for the owner to check
against the actual provider terms before it is pushed to `main`.

## Verification
1. `node` script: every `<svg>` inside `.tour-vis`, `.pillar`, `.mode`, `.glyph` has
   `aria-hidden="true"`; exactly one `<main>`; first focusable element is the skip link;
   no `target="_blank"` link without the sr-only note; no `→` outside an `aria-hidden` span;
   heading sequence is h1 → h2 → h3 with no skips.
2. Serve `docs/` statically and check at 375px and 1024px: nav visible at both, skip link
   visible when focused, no horizontal scroll, contrast of body text ≥ 4.5:1.
3. `prefers-reduced-motion` emulated: no animation on the phone mockup.
4. Read through with VoiceOver on iOS once before the pilot invitation goes out.

Deploy: Firebase Hosting deploys automatically on push to `main` touching `docs/**`
(`.github/workflows/firebase-hosting-merge.yml`). Pull-request previews exist for same-repo PRs.
