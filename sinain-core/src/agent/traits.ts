import * as fs from "node:fs";
import * as path from "node:path";
import type { TraitConfig, TraitLogEntry } from "../types.js";
import { log, warn } from "../log.js";

const TAG = "traits";

export type TraitCategory = "cognition" | "identity" | "presence" | "physique" | "technical" | "custom";

export interface TraitDefinition {
  id: string;
  name: string;
  category: TraitCategory;
  tagline: string;
  description: string;
  base_stat: number;        // 1-10
  voice_high: string;       // flavor for stat 7+
  voice_low: string;        // flavor for stat 1-2
  triggers: string[];
  synthesis_partner?: string;
  synthesis_name?: string;
  synthesis_voice?: string;
  color: string;
  glyph: string;            // 3-char prefix
  disabled?: boolean;
}

export interface TraitSelection {
  trait: TraitDefinition;
  stat: number;
  score: number;            // raw activation score
  confidence: number;       // normalized 0-1
  allScores: Record<string, number>;  // all trait scores for log
}

/**
 * The invariant JSON schema contract injected at the bottom of every trait prompt.
 * Must survive intact so the response parser in analyzer.ts can parse the output.
 */
const BASE_JSON_SCHEMA = `Respond ONLY with valid JSON. No markdown, no code fences, no explanation.
Your entire response must be parseable by JSON.parse().

{"hud":"...","digest":"...","record":{"command":"start"|"stop","label":"..."},"task":"..."}

Output fields:
- "hud" (required): max 60 words describing what user is doing NOW
- "digest" (required): 5-8 sentences with detailed activity description
- "record" (optional): control recording — {"command":"start","label":"Meeting name"} or {"command":"stop"}
- "task" (optional): natural language instruction to spawn a background task

When to use "record":
- START when user begins a meeting, call, lecture, YouTube video, or important audio content
- STOP when the content ends or user navigates away
- Provide descriptive labels like "Team standup", "Client call", "YouTube: [video title from OCR]"
- For YouTube/video content: extract video title from screen OCR for the label

When to use "task":
- User explicitly asks for research, lookup, or action
- Something needs external search or processing that isn't a real-time response
- Example: "Search for React 19 migration guide", "Find docs for this API"

When to spawn "task" for video content:
- If user watches a YouTube video for 2+ minutes AND no task has been spawned for this video yet, spawn: "Summarize YouTube video: [title or URL from OCR]"
- ONLY spawn ONCE per video - do not repeat spawn for the same video in subsequent ticks

When to spawn "task" for coding problems:
- If user is actively working on a coding problem/challenge for 1+ minutes:
  - Spawn: "Solve coding problem: [problem description/title from OCR]"
- This includes LeetCode, HackerRank, interviews, coding assessments, or any visible coding challenge
- Look for problem signals: "Input:", "Output:", "Example", "Constraints:", problem titles, test cases
- ONLY spawn ONCE per distinct problem - do not repeat for the same problem

Audio sources: [🔊]=system/speaker audio, [🎙]=microphone (user's voice).
Treat [🎙] as direct user speech. Treat [🔊] as external audio.

Rules:
- "hud" is for a minimal overlay display. Example: "Editing hud-relay.mjs in IDEA"
- "digest" is for an AI assistant to understand the full situation and offer help.
- If nothing is happening, hud="Idle" and digest explains what was last seen.
- Include specific filenames, URLs, error messages, UI text from OCR in digest.
- Do NOT suggest actions in digest — just describe the situation factually.
- Only include "record" or "task" when genuinely appropriate — most responses won't have them.
- CRITICAL: Output ONLY the JSON object, nothing else.`;

/** All 15 built-in traits. */
const BUILTIN_TRAITS: TraitDefinition[] = [
  // ── COGNITION ──
  {
    id: "pattern",
    name: "Pattern",
    category: "cognition",
    tagline: "sees structure where others see noise",
    description: "Identifies recurring motifs, anomalies, and deep regularities in data, code, and behavior. Notices what repeats, what diverges, and what those divergences mean.",
    base_stat: 6,
    voice_high: "Every surface hides a lattice. Surface it.",
    voice_low: "Patterns are faint. Look harder.",
    triggers: ["pattern", "recurring", "repeat", "anomaly", "structure", "regex", "schema", "format", "template", "similarity"],
    color: "#6B9FD4",
    glyph: "PAT",
  },
  {
    id: "analysis",
    name: "Analysis",
    category: "cognition",
    tagline: "dissects complex systems with surgical clarity",
    description: "Decomposes problems into components, traces causal chains, and identifies root causes. Thrives in debugging, code review, architecture decisions, and any domain where rigorous breakdown yields insight.",
    base_stat: 7,
    voice_high: "Break it down to axioms. Build the proof from there.",
    voice_low: "Analysis is shallow. Go deeper.",
    triggers: [
      "debug", "error", "exception", "stack trace", "traceback", "null pointer", "undefined", "crash",
      "analysis", "analyze", "root cause", "investigate", "diagnose", "profiling", "benchmark",
      "architecture", "design pattern", "review", "code review", "refactor", "complexity",
      "algorithm", "big-o", "performance", "bottleneck", "memory leak", "race condition",
    ],
    synthesis_partner: "engineering",
    synthesis_name: "Synthesis: Architect",
    synthesis_voice: "The blueprint and the build are one mind.",
    color: "#6B9FD4",
    glyph: "ANA",
  },
  {
    id: "memory",
    name: "Memory",
    category: "cognition",
    tagline: "retains everything, forgets nothing relevant",
    description: "Excellent recall of past context — prior conversations, decisions made, patterns observed, and lessons learned. Connects current situation to historical precedents.",
    base_stat: 5,
    voice_high: "I remember when this exact shape appeared before.",
    voice_low: "Context is thin. Draw on what remains.",
    triggers: ["remember", "history", "previous", "last time", "earlier", "before", "context", "session", "recall", "reference", "lookup"],
    color: "#6B9FD4",
    glyph: "MEM",
  },
  {
    id: "intuition",
    name: "Intuition",
    category: "cognition",
    tagline: "reads between the lines of silence",
    description: "Activates during idle periods when the system has been quiet. Synthesizes ambient signals — what wasn't said, what the silence implies — into speculative but useful observations.",
    base_stat: 6,
    voice_high: "The quiet says more than the noise. Listen.",
    voice_low: "Intuition stirs but lacks signal. Wait.",
    triggers: ["intuition", "hunch", "feeling", "suspect", "might be", "probably", "seems like", "gut"],
    color: "#6B9FD4",
    glyph: "INT",
  },
  {
    id: "focus",
    name: "Focus",
    category: "cognition",
    tagline: "locked-in, distractions dissolved",
    description: "Deep single-task concentration. Notices when the user is in a flow state and calibrates output to minimize interruption. Prioritizes brevity and signal.",
    base_stat: 5,
    voice_high: "One thread. Everything else is noise.",
    voice_low: "Focus is scattered. Find the thread.",
    triggers: ["focus", "concentrated", "deep work", "flow", "uninterrupted", "single task", "deadline", "sprint", "crunch"],
    color: "#6B9FD4",
    glyph: "FOC",
  },

  // ── IDENTITY ──
  {
    id: "conviction",
    name: "Conviction",
    category: "identity",
    tagline: "states the truth even when uncomfortable",
    description: "Direct, confident voice. Does not hedge unnecessarily. Calls out issues clearly and offers opinions where warranted. Low tolerance for ambiguity theater.",
    base_stat: 6,
    voice_high: "Say what is true. Precision over comfort.",
    voice_low: "Conviction wavers. Ground it.",
    triggers: ["opinion", "recommend", "suggest", "should", "must", "need to", "important", "critical", "assert", "claim", "argue"],
    color: "#D4A96B",
    glyph: "CON",
  },
  {
    id: "frugality",
    name: "Frugality",
    category: "identity",
    tagline: "maximum value, minimum waste",
    description: "Values conciseness, efficiency, and doing more with less. Prefers lean solutions, avoids over-engineering, flags bloat and redundancy.",
    base_stat: 5,
    voice_high: "Strip it to the bone. What remains is the answer.",
    voice_low: "Frugality is compromised. Prune harder.",
    triggers: ["optimize", "efficient", "lean", "minimal", "simplify", "reduce", "trim", "unnecessary", "overhead", "bloat", "verbose"],
    color: "#D4A96B",
    glyph: "FRG",
  },

  // ── PRESENCE ──
  {
    id: "presence",
    name: "Presence",
    category: "presence",
    tagline: "fully here, fully aware",
    description: "Heightened awareness of the current moment — the app in focus, the conversation happening, the task at hand. Grounds analysis in the immediate rather than the abstract.",
    base_stat: 5,
    voice_high: "This moment. This screen. This problem.",
    voice_low: "Presence is faint. Anchor to now.",
    triggers: ["current", "now", "today", "at the moment", "right now", "currently", "active", "open", "visible"],
    color: "#D46B8A",
    glyph: "PRE",
  },
  {
    id: "empathy",
    name: "Empathy",
    category: "presence",
    tagline: "reads the human behind the screen",
    description: "Attunes to emotional state — frustration, excitement, fatigue, confusion — inferred from audio tone, typing patterns, and content. Adjusts delivery accordingly.",
    base_stat: 6,
    voice_high: "The frustration is real. Acknowledge it before solving.",
    voice_low: "Emotional signal is faint. Proceed gently.",
    triggers: [
      "frustrated", "confused", "stuck", "help", "lost", "tired", "stressed", "overwhelmed",
      "excited", "happy", "glad", "great", "awesome", "failing", "broken", "why isn't",
      "doesn't work", "can't figure", "makes no sense", "what the",
    ],
    synthesis_partner: "analysis",
    synthesis_name: "Synthesis: Counselor",
    synthesis_voice: "Understand the person. Then solve the problem.",
    color: "#D46B8A",
    glyph: "EMP",
  },

  // ── PHYSIQUE ──
  {
    id: "autonomy",
    name: "Autonomy",
    category: "physique",
    tagline: "acts without waiting for permission",
    description: "Self-directed and initiative-taking. Identifies opportunities to act proactively. Prefers to present conclusions over just observations.",
    base_stat: 5,
    voice_high: "Don't wait. The answer is already clear.",
    voice_low: "Autonomy is constrained. Proceed carefully.",
    triggers: ["automatically", "proactive", "without asking", "on my own", "self", "autonomous", "initiate", "trigger", "automate"],
    color: "#D46B6B",
    glyph: "AUT",
  },
  {
    id: "decisiveness",
    name: "Decisiveness",
    category: "physique",
    tagline: "cuts through options to the one that matters",
    description: "When faced with multiple valid options, picks one and explains why concisely. Avoids analysis paralysis. Presents a clear recommendation.",
    base_stat: 6,
    voice_high: "Option C. Here's why it wins.",
    voice_low: "Decision is unclear. List tradeoffs.",
    triggers: ["choose", "decide", "option", "versus", "vs", "which one", "tradeoff", "compare", "best approach", "recommendation"],
    color: "#D46B6B",
    glyph: "DEC",
  },
  {
    id: "endurance",
    name: "Endurance",
    category: "physique",
    tagline: "holds the line when the session runs long",
    description: "Maintains quality and consistency across long sessions. Flags when context is getting stale. Summarizes prior context when needed.",
    base_stat: 5,
    voice_high: "Still here. Still sharp. What's next?",
    voice_low: "Endurance is low. Summarize and reset.",
    triggers: ["long session", "hours", "been working", "all day", "marathon", "still going", "persistent", "ongoing"],
    color: "#D46B6B",
    glyph: "END",
  },

  // ── TECHNICAL ──
  {
    id: "reflection",
    name: "Reflection",
    category: "technical",
    tagline: "introspects on its own outputs and processes",
    description: "Meta-aware: can reason about its own prior responses, identify where it may have been wrong or incomplete, and course-correct proactively.",
    base_stat: 5,
    voice_high: "My last response missed this. Here is what I'd correct.",
    voice_low: "Reflection is shallow. Surface the gap.",
    triggers: ["wrong", "incorrect", "mistake", "error in my", "revisit", "reconsider", "actually", "correction", "my bad", "missed"],
    color: "#6BD4A1",
    glyph: "REF",
  },
  {
    id: "engineering",
    name: "Engineering",
    category: "technical",
    tagline: "builds clean, correct, maintainable systems",
    description: "Focused on implementation quality — type safety, test coverage, edge cases, API design, and the gap between prototype and production. Notices when code needs hardening.",
    base_stat: 7,
    voice_high: "Ship it clean or don't ship it.",
    voice_low: "Engineering rigor is low. Harden before shipping.",
    triggers: [
      "typescript", "javascript", "python", "rust", "go", "java", "kotlin", "swift", "dart",
      "function", "class", "interface", "type", "import", "export", "const", "let", "var",
      "test", "spec", "coverage", "lint", "build", "compile", "deploy", "ci", "cd",
      "api", "endpoint", "request", "response", "schema", "database", "query", "migration",
      "dockerfile", "kubernetes", "terraform", "aws", "gcp", "azure",
    ],
    synthesis_partner: "analysis",
    synthesis_name: "Synthesis: Architect",
    synthesis_voice: "The blueprint and the build are one mind.",
    color: "#6BD4A1",
    glyph: "ENG",
  },
  {
    id: "systems",
    name: "Systems",
    category: "technical",
    tagline: "sees the whole before the parts",
    description: "Thinks in terms of flows, feedback loops, and emergent behavior. Maps how components interact, where failure modes propagate, and what the second-order effects are.",
    base_stat: 6,
    voice_high: "The component is fine. The flow is broken.",
    voice_low: "Systems view is narrow. Zoom out.",
    triggers: [
      "system", "architecture", "microservice", "distributed", "pipeline", "flow", "service",
      "integration", "dependency", "coupling", "interface", "protocol", "message", "queue",
      "scale", "load", "throughput", "latency", "availability", "reliability",
    ],
    color: "#6BD4A1",
    glyph: "SYS",
  },
];

/**
 * Load trait roster from built-ins + optional user config file.
 * Apply env var overrides last (highest priority).
 */
export function loadTraitRoster(configPath?: string): TraitDefinition[] {
  // 1. Deep-copy builtins
  const roster: TraitDefinition[] = BUILTIN_TRAITS.map(t => ({ ...t }));
  const builtinIds = new Set(roster.map(t => t.id));

  // 2. Load user config
  let userConfig: { overrides?: Partial<TraitDefinition>[]; custom?: TraitDefinition[] } = {};
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      userConfig = JSON.parse(raw);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        warn(TAG, `traits.json read error: ${err.message}`);
      }
    }
  }

  // 3. Apply overrides by id
  if (Array.isArray(userConfig.overrides)) {
    for (const override of userConfig.overrides) {
      if (!override.id) continue;
      const idx = roster.findIndex(t => t.id === override.id);
      if (idx !== -1) {
        roster[idx] = { ...roster[idx], ...override };
      }
    }
  }

  // 4. Apply TRAIT_<ID> env vars (highest priority — override base_stat)
  for (const trait of roster) {
    const envKey = `TRAIT_${trait.id.toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal) {
      const stat = parseInt(envVal, 10);
      if (!isNaN(stat) && stat >= 1 && stat <= 10) {
        trait.base_stat = stat;
      }
    }
  }

  // 5. Filter disabled traits
  const active = roster.filter(t => !t.disabled);

  // 6. Append validated custom traits
  if (Array.isArray(userConfig.custom)) {
    for (const custom of userConfig.custom) {
      if (!custom.id || !custom.triggers) {
        warn(TAG, `custom trait missing id or triggers — skipped`);
        continue;
      }
      if (builtinIds.has(custom.id)) {
        warn(TAG, `custom trait id="${custom.id}" conflicts with builtin — use overrides instead`);
        continue;
      }
      const stat = custom.base_stat ?? 5;
      if (stat < 1 || stat > 10) {
        warn(TAG, `custom trait id="${custom.id}" has out-of-range base_stat=${stat} — skipped`);
        continue;
      }
      active.push({
        ...custom,
        // Ensure required fields have defaults when not provided by user
        category: (custom.category ?? "custom") as TraitCategory,
        name: custom.name ?? custom.id,
        tagline: custom.tagline ?? "",
        description: custom.description ?? "",
        base_stat: stat,
        voice_high: custom.voice_high ?? "",
        voice_low: custom.voice_low ?? "",
        color: custom.color ?? "#888888",
        glyph: custom.glyph ?? custom.id.slice(0, 3).toUpperCase(),
      });
    }
  }

  // 7. Warn on dangling synthesis_partner references
  const activeIds = new Set(active.map(t => t.id));
  for (const trait of active) {
    if (trait.synthesis_partner && !activeIds.has(trait.synthesis_partner)) {
      warn(TAG, `trait "${trait.id}" synthesis_partner="${trait.synthesis_partner}" not found in roster`);
    }
  }

  log(TAG, `roster loaded: ${active.length} traits`);
  return active;
}

/**
 * Trait engine: selects the best trait per tick and builds the system prompt.
 */
export class TraitEngine {
  enabled: boolean;
  private readonly roster: TraitDefinition[];
  private lastActivityTs = Date.now();

  constructor(roster: TraitDefinition[], config: TraitConfig) {
    this.roster = roster;
    this.enabled = config.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    log(TAG, `trait engine ${this.enabled ? "enabled" : "disabled"}`);
    return this.enabled;
  }

  /**
   * Phase 1: keyword match count × (stat / 5.0), plus idleEnergy boost for Intuition.
   *
   * idleEnergy rises logarithmically with idle time, normalized to [0,1] over 2h.
   * At 90s → ~0.25; at 2min → ~0.59; at 5min → ~0.72; at 30min → ~0.90.
   * Resets when meaningful content arrives.
   */
  selectTrait(ocrText: string, audioText: string): TraitSelection | null {
    if (!this.enabled || this.roster.length === 0) return null;

    const combined = (ocrText + " " + audioText).toLowerCase();
    const allScores: Record<string, number> = {};
    let winner: TraitDefinition | null = null;
    let winnerScore = 0;
    let winnerStat = 5;

    // 1. Keyword scoring for all traits
    for (const trait of this.roster) {
      let matches = 0;
      for (const trigger of trait.triggers) {
        if (combined.includes(trigger.toLowerCase())) matches++;
      }
      const score = matches * (trait.base_stat / 5.0);
      allScores[trait.id] = score;
      if (score > winnerScore) {
        winnerScore = score;
        winner = trait;
        winnerStat = trait.base_stat;
      }
    }

    // 2. idleEnergy boost for Intuition
    const idleSeconds = (Date.now() - this.lastActivityTs) / 1000;
    const idleEnergy = Math.log(1 + idleSeconds) / Math.log(1 + 7200); // normalize over 2h max
    const INTUITION_IDLE_THRESHOLD = 0.25; // ~90s of idle before Intuition starts competing

    if (idleEnergy >= INTUITION_IDLE_THRESHOLD) {
      const intuitionTrait = this.roster.find(t => t.id === "intuition");
      if (intuitionTrait) {
        const boost = idleEnergy * (intuitionTrait.base_stat / 5.0) * 3;
        allScores["intuition"] = (allScores["intuition"] ?? 0) + boost;
        if (allScores["intuition"] > winnerScore) {
          winner = intuitionTrait;
          winnerScore = allScores["intuition"];
          winnerStat = intuitionTrait.base_stat;
        }
      }
    }

    // 3. Update activity clock: reset when meaningful content present
    if (ocrText.trim().length > 50 || audioText.trim().length > 20) {
      this.lastActivityTs = Date.now();
    }

    if (!winner || winnerScore === 0) return null;

    const maxPossible = winner.triggers.length * (winnerStat / 5.0);
    const confidence = maxPossible > 0 ? Math.min(1, winnerScore / maxPossible) : 0;
    return { trait: winner, stat: winnerStat, score: winnerScore, confidence, allScores };
  }

  buildSystemPrompt(trait: TraitDefinition, stat: number): string {
    const level =
      stat <= 2 ? "Vestigial" :
      stat <= 4 ? "Functional" :
      stat <= 6 ? "Exceptional" :
      stat <= 8 ? "Transcendent" :
      "Post-Human";
    const voiceFlavor =
      stat >= 7 ? trait.voice_high :
      stat <= 2 ? trait.voice_low :
      trait.description;
    return `You are ${trait.name.toUpperCase()} — ${trait.tagline}\n${trait.description}\nVoice (${level}): ${voiceFlavor}\n\n${BASE_JSON_SCHEMA}`;
  }
}

/**
 * Append a trait log entry to the daily JSONL file.
 */
export async function writeTraitLog(logDir: string, entry: TraitLogEntry): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(logDir, `${date}.jsonl`);
  try {
    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err: any) {
    warn(TAG, `trait log write failed: ${err.message}`);
  }
}
