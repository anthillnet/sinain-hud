import { WebSocket } from "ws";

/**
 * ChatService — bridges sinain-core's chat path to the resident sinain-chat-agent
 * sidecar (OpenHands, qwen reasoning-off) over WebSocket. This is the third dispatch
 * shape alongside run.sh subprocess (claude/openclaude/…) and the openclaw WS gateway:
 * a LOCAL resident sidecar selected via the `sinain` roster profile (type "sinain").
 *
 * Sidecar protocol (see sinain-chat-agent/sidecar.py):
 *   → {"message": "...", "context": {"kind":"main"|"roi","seed":"..."}}
 *   ← {"type":"token"|"tool_call"|"tool_result"|"progress"|"done"|"error", ...}
 *
 * v1 connects per turn (the sidecar accepts a turn per connection); a resident
 * connection is a later optimization. Tokens stream via onToken so the caller can
 * relay to the overlay; handle() resolves with the full reply on `done`.
 */
export interface ChatContext {
  kind?: "main" | "roi";
  seed?: string;
  /** "user" (default) turns preempt an in-flight escalation in the sidecar;
   *  "escalation" turns drop if a turn is already running. */
  source?: "user" | "escalation";
}

/** Per-turn LLM usage reported by the sidecar's `done` event (from OpenHands
 *  metrics). cost is 0 for local models; tokens are always present. */
export interface ChatUsage {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export interface ChatHandlers {
  onToken?: (text: string) => void;
  onTool?: (name: string) => void;
  onUsage?: (usage: ChatUsage) => void;
}

export class ChatService {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 60_000,
  ) {}

  /** Run one chat turn against the sidecar; resolve with the full assistant reply. */
  handle(text: string, context: ChatContext = {}, handlers: ChatHandlers = {}): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      let acc = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("chat sidecar timeout"))),
        this.timeoutMs,
      );

      ws.on("open", () => {
        ws.send(JSON.stringify({ message: text, context }));
      });
      ws.on("message", (data: unknown) => {
        let ev: { type?: string; text?: string; tool_name?: string; usage?: ChatUsage };
        try {
          ev = JSON.parse(String(data));
        } catch {
          return;
        }
        if (ev.usage && handlers.onUsage) {
          try { handlers.onUsage(ev.usage); } catch { /* metering must never break chat */ }
        }
        switch (ev.type) {
          case "token":
            acc += ev.text ?? "";
            if (ev.text) handlers.onToken?.(ev.text);
            break;
          case "tool_call":
            if (ev.tool_name) handlers.onTool?.(ev.tool_name);
            break;
          case "done":
            finish(() => resolve(ev.text || acc));
            break;
          case "error":
            finish(() => reject(new Error(ev.text || "chat sidecar error")));
            break;
          default:
            break;
        }
      });
      ws.on("error", (e: Error) => finish(() => reject(e)));
      ws.on("close", () => finish(() => resolve(acc)));
    });
  }
}
