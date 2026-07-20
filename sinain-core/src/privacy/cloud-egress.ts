import { redactText } from "./redact.js";

export function redactOutbound(text: string): string {
  return redactText(text);
}

/** Scrub textual chat content without touching images, audio, or other binary data. */
export function redactChatPayload<T extends Record<string, unknown>>(payload: T): T {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return payload;
  return {
    ...payload,
    messages: messages.map((message: unknown) => {
      if (!message || typeof message !== "object") return message;
      const item = message as Record<string, unknown>;
      return { ...item, content: redactContent(item.content) };
    }),
  } as T;
}

function redactContent(content: unknown): unknown {
  if (typeof content === "string") return redactOutbound(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    return typeof item.text === "string" ? { ...item, text: redactOutbound(item.text) } : part;
  });
}
