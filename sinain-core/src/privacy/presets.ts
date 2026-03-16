import type { PrivacyMatrix } from "../types.js";

const FULL_ROW = { local_buffer: "full" as const, local_llm: "full" as const, triple_store: "full" as const, openrouter: "full" as const, agent_gateway: "full" as const };

const ALL_FULL: PrivacyMatrix = {
  audio_transcript: { ...FULL_ROW },
  screen_ocr:       { ...FULL_ROW },
  screen_images:    { ...FULL_ROW },
  window_titles:    { ...FULL_ROW },
  credentials:      { ...FULL_ROW },
  metadata:         { ...FULL_ROW },
};

export const PRESETS: Record<string, PrivacyMatrix> = {
  off: ALL_FULL,
  standard: {
    audio_transcript: { local_buffer: "full",    local_llm: "redacted", triple_store: "redacted", openrouter: "redacted", agent_gateway: "redacted" },
    screen_ocr:       { local_buffer: "redacted", local_llm: "redacted", triple_store: "redacted", openrouter: "redacted", agent_gateway: "redacted" },
    screen_images:    { local_buffer: "full",     local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    window_titles:    { local_buffer: "full",     local_llm: "summary",  triple_store: "summary",  openrouter: "summary",  agent_gateway: "none"     },
    credentials:      { local_buffer: "none",     local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    metadata:         { local_buffer: "full",     local_llm: "full",     triple_store: "full",     openrouter: "summary",  agent_gateway: "summary"  },
  },
  strict: {
    audio_transcript: { local_buffer: "redacted", local_llm: "summary",  triple_store: "summary",  openrouter: "summary",  agent_gateway: "none"     },
    screen_ocr:       { local_buffer: "redacted", local_llm: "summary",  triple_store: "none",     openrouter: "summary",  agent_gateway: "none"     },
    screen_images:    { local_buffer: "none",     local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    window_titles:    { local_buffer: "summary",  local_llm: "summary",  triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    credentials:      { local_buffer: "none",     local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    metadata:         { local_buffer: "full",     local_llm: "summary",  triple_store: "summary",  openrouter: "none",     agent_gateway: "none"     },
  },
  paranoid: {
    audio_transcript: { local_buffer: "redacted", local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    screen_ocr:       { local_buffer: "redacted", local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    screen_images:    { local_buffer: "none",     local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    window_titles:    { local_buffer: "none",     local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    credentials:      { local_buffer: "none",     local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
    metadata:         { local_buffer: "summary",  local_llm: "none",     triple_store: "none",     openrouter: "none",     agent_gateway: "none"     },
  },
};
