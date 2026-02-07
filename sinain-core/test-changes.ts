/**
 * Standalone verification script for the 4 optimization changes.
 * Run: cd sinain-core && npx tsx test-changes.ts
 *
 * Tests pure functions only — no network calls, no external deps.
 */

import { bigramSimilarity, isDuplicateTranscript } from "./src/util/dedup.js";
import { SenseBuffer } from "./src/buffers/sense-buffer.js";
import { RICHNESS_PRESETS, buildContextWindow } from "./src/agent/context-window.js";
import { FeedBuffer } from "./src/buffers/feed-buffer.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

// ═══════════════════════════════════════════════════════════
// 1. AUDIO TRANSCRIPT DEDUP
// ═══════════════════════════════════════════════════════════
section("Audio Transcript Dedup");

// Identical strings → similarity 1.0
assert(bigramSimilarity("hello world", "hello world") === 1.0,
  "identical strings → 1.0");

// Completely different → low similarity
assert(bigramSimilarity("hello world", "xyz abc") < 0.2,
  "completely different strings → <0.2");

// Similar transcripts (minor word change) → high similarity
const sim = bigramSimilarity(
  "the weather is nice today and sunny",
  "the weather is nice today and cloudy"
);
assert(sim > 0.7, `similar transcripts → ${sim.toFixed(2)} > 0.7`);

// Empty strings
assert(bigramSimilarity("", "") === 1.0, "empty strings → 1.0");
assert(bigramSimilarity("hello", "") === 0.0, "one empty → 0.0");

// isDuplicateTranscript: should detect near-dupes
assert(isDuplicateTranscript(
  "the music is playing loudly",
  ["the music is playing loudly in background", "something else"]
), "near-duplicate detected");

// isDuplicateTranscript: should NOT flag distinct text
assert(!isDuplicateTranscript(
  "user is discussing React hooks",
  ["the music is playing", "weather report today"]
), "distinct text not flagged as duplicate");

// Short text should never be deduped
assert(!isDuplicateTranscript("hi", ["hi"]),
  "very short text (<5 chars) never deduped");

// ═══════════════════════════════════════════════════════════
// 2. RICHNESS PRESETS — maxImages field
// ═══════════════════════════════════════════════════════════
section("Richness Presets — maxImages");

assert(RICHNESS_PRESETS.lean.maxImages === 0, "lean → 0 images");
assert(RICHNESS_PRESETS.standard.maxImages === 1, "standard → 1 image");
assert(RICHNESS_PRESETS.rich.maxImages === 2, "rich → 2 images");

// ═══════════════════════════════════════════════════════════
// 3. SENSE BUFFER — image memory management
// ═══════════════════════════════════════════════════════════
section("SenseBuffer — Image Memory Management");

const buf = new SenseBuffer(20, 3); // max 3 images kept

// Push 5 events with imageData
for (let i = 0; i < 5; i++) {
  buf.push({
    type: "visual",
    ts: Date.now() - (5 - i) * 1000,
    ocr: `screen ${i}`,
    imageData: `base64data${i}`,
    imageBbox: [0, 0, 100, 100],
    meta: { ssim: 0.8, app: "Chrome", screen: 0 },
  });
}

// Only the 3 most recent should retain imageData
const withImages = buf.recentImages(10);
assert(withImages.length === 3,
  `recentImages returns 3 (got ${withImages.length})`);

// The oldest 2 should have been stripped
const allEvents = buf.query(0);
const strippedCount = allEvents.filter(e => !e.imageData).length;
assert(strippedCount === 2,
  `2 oldest events have imageData stripped (got ${strippedCount} stripped)`);

// Push an event WITHOUT imageData — shouldn't affect image count
buf.push({
  type: "text",
  ts: Date.now(),
  ocr: "text only event",
  meta: { ssim: 0.9, app: "IDEA", screen: 0 },
});
assert(buf.recentImages(10).length === 3,
  "text-only push doesn't affect image count");

// ═══════════════════════════════════════════════════════════
// 4. CONTEXT WINDOW — images extraction
// ═══════════════════════════════════════════════════════════
section("ContextWindow — Image Extraction");

const feedBuf = new FeedBuffer(50);
const senseBuf = new SenseBuffer(30, 5);

// Push some sense events with images
for (let i = 0; i < 3; i++) {
  senseBuf.push({
    type: "visual",
    ts: Date.now() - (3 - i) * 1000,
    ocr: `ocr text ${i}`,
    imageData: `imgdata${i}`,
    imageBbox: [0, 0, 200, 200],
    meta: { ssim: 0.85, app: "Chrome", screen: 0 },
  });
}

// Standard preset (maxImages=1) → should get 1 image
const ctxStd = buildContextWindow(feedBuf, senseBuf, "standard", 120_000);
assert(ctxStd.images !== undefined && ctxStd.images.length === 1,
  `standard richness → 1 image (got ${ctxStd.images?.length})`);
assert(ctxStd.images![0].app === "Chrome",
  "image has correct app metadata");

// Lean preset (maxImages=0) → no images
const ctxLean = buildContextWindow(feedBuf, senseBuf, "lean", 120_000);
assert(ctxLean.images === undefined,
  "lean richness → no images (undefined)");

// Rich preset (maxImages=2) → should get 2 images
const ctxRich = buildContextWindow(feedBuf, senseBuf, "rich", 120_000);
assert(ctxRich.images !== undefined && ctxRich.images.length === 2,
  `rich richness → 2 images (got ${ctxRich.images?.length})`);

// ═══════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
}
