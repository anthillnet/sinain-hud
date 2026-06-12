/**
 * DirectChat — SPIKE: MAIN chat answered by a fast LLM directly from core.
 *
 * No agent CLI in the loop: user message → one OpenRouter chat-completions
 * call (with native tool-calling) → response broadcast to the HUD feed.
 * Tools execute in-process against core's own functions — the same
 * capabilities the MCP server exposes to CLI agents (memory query/store,
 * context window), without the CLI boot + MCP boot + poll latency.
 *
 * Enabled by DIRECT_CHAT_MODEL (e.g. "deepseek/deepseek-v4-flash"). When
 * set, MAIN user messages take this path; ambient escalations keep the
 * agent-lane pipeline unchanged.
 */

import { log, warn } from "../log.js";

const TAG = "direct";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface DirectChatDeps {
  apiKey: string;
  model: string;
  /** One-paragraph situation digest (may be undefined early in a session). */
  getDigest: () => string | undefined;
  /** Full context window as a printable string (screen OCR + transcripts). */
  getContextText: () => string;
  /** Knowledge-graph retrieval (entities/keywords → compact facts text). */
  queryKnowledge: (entities: string[], maxFacts: number) => Promise<string>;
  /** Knowledge-graph write ({facts:[...]} JSON in, result JSON out). */
  storeFacts: (factsJson: string) => Promise<string>;
  /** Push the final answer to the HUD feed (and feed buffer). */
  pushAnswer: (text: string) => void;
  /** Clear the overlay's thinking indicator. */
  setThinking: (active: boolean) => void;
  /** Optional cost accounting (OpenRouter usage.cost). */
  recordCost?: (cost: number, model: string) => void;
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "memory_query",
      description:
        "Query sinain's long-term memory (knowledge graph) for facts about entities/keywords",
      parameters: {
        type: "object",
        properties: {
          entities: { type: "array", items: { type: "string" } },
          max_facts: { type: "number", default: 8 },
        },
        required: ["entities"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_store",
      description:
        "Store durable facts the user states or confirms (entity/attribute/value triples)",
      parameters: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                entity: { type: "string" },
                attribute: { type: "string" },
                value: { type: "string" },
                domain: { type: "string" },
              },
              required: ["entity", "attribute", "value"],
            },
          },
        },
        required: ["facts"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_context",
      description:
        "Full recent context window (screen OCR, audio transcripts, app history) — use when the digest in your system prompt isn't enough",
      parameters: { type: "object", properties: {} },
    },
  },
];

const MAX_TOOL_ROUNDS = 4;
const HISTORY_MAX = 24;

export class DirectChat {
  private history: ChatMessage[] = [];
  private inFlight = false;

  constructor(private deps: DirectChatDeps) {}

  /** Handle one MAIN-chat user message. Never throws — errors surface in the feed. */
  async handle(text: string): Promise<void> {
    if (this.inFlight) {
      // Sequential by design: a second message while one is in flight just
      // queues behind it via the next call — simplest correct behavior for
      // a spike (the overlay shows thinking until the last answer lands).
      log(TAG, `message while in flight — processing sequentially`);
    }
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const answer = await this.run(text);
      const ms = Date.now() - t0;
      log(TAG, `answered in ${ms}ms (${answer.length} chars)`);
      this.deps.pushAnswer(answer);
    } catch (err) {
      warn(TAG, `direct chat failed: ${err}`);
      this.deps.pushAnswer(
        `⚠ Direct chat error (${String(err).slice(0, 120)}) — try again, or switch the CHAT lane to an agent.`,
      );
    } finally {
      this.inFlight = false;
      this.deps.setThinking(false);
    }
  }

  private async run(text: string): Promise<string> {
    const digest = this.deps.getDigest();
    const system: ChatMessage = {
      role: "system",
      content: [
        "You are sinain, a privacy-first AI overlay on the user's macOS. You",
        "see their screen and hear their audio context; your replies render",
        "in the HUD's main chat. Answer directly and concisely — no preamble,",
        "never narrate what the user can see themselves. Coding context →",
        "code-level help. Use tools only when they clearly add value. If a",
        "memory query comes back thin, answer from what you have — do NOT",
        "re-query with rephrased keywords.",
        digest ? `\n## Current situation\n${digest}` : "",
      ].join("\n"),
    };

    this.history.push({ role: "user", content: text });
    this.trimHistory();

    const messages: ChatMessage[] = [system, ...this.history];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.deps.model,
          messages,
          tools: TOOLS,
          // Last round: force a text answer — fast models otherwise spiral,
          // rephrasing the same memory query until the round budget dies.
          ...(round === MAX_TOOL_ROUNDS ? { tool_choice: "none" } : {}),
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        throw new Error(`OpenRouter ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      }
      const data = (await resp.json()) as any;
      const cost = data?.usage?.cost;
      if (typeof cost === "number" && this.deps.recordCost) {
        this.deps.recordCost(cost, this.deps.model);
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error("empty completion");

      if (msg.tool_calls?.length) {
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.tool_calls,
        };
        messages.push(assistantMsg);
        this.history.push(assistantMsg);
        for (const tc of msg.tool_calls) {
          const result = await this.execTool(tc.function.name, tc.function.arguments);
          const toolMsg: ChatMessage = {
            role: "tool",
            tool_call_id: tc.id,
            content: result.slice(0, 8000),
          };
          messages.push(toolMsg);
          this.history.push(toolMsg);
        }
        continue;
      }

      const answer = (msg.content || "").trim();
      if (!answer) throw new Error("empty answer");
      this.history.push({ role: "assistant", content: answer });
      this.trimHistory();
      return answer;
    }
    throw new Error(`no final answer after ${MAX_TOOL_ROUNDS} tool rounds`);
  }

  private async execTool(name: string, argsJson: string): Promise<string> {
    let args: any = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      return "error: invalid tool arguments";
    }
    log(TAG, `tool ${name}(${argsJson.slice(0, 120)})`);
    try {
      switch (name) {
        case "memory_query": {
          const entities = Array.isArray(args.entities) ? args.entities.map(String) : [];
          const facts = await this.deps.queryKnowledge(entities, args.max_facts || 8);
          return facts || "no matching knowledge";
        }
        case "memory_store":
          return await this.deps.storeFacts(JSON.stringify({ facts: args.facts || [] }));
        case "get_context":
          return this.deps.getContextText().slice(0, 12_000);
        default:
          return `error: unknown tool ${name}`;
      }
    } catch (err) {
      return `error: ${String(err).slice(0, 200)}`;
    }
  }

  private trimHistory(): void {
    // Keep the tail, but never let a dangling tool message lead (the API
    // rejects a tool result without its assistant tool_calls predecessor).
    if (this.history.length > HISTORY_MAX) {
      this.history = this.history.slice(-HISTORY_MAX);
      while (this.history.length && this.history[0].role === "tool") {
        this.history.shift();
      }
    }
  }
}
