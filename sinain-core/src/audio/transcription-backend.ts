import type { AudioChunk, TranscriptResult } from "../types.js";

/** Backend-agnostic transcription interface. */
export interface TranscriptionBackend {
  transcribe(chunk: AudioChunk): Promise<TranscriptResult | null>;
  destroy(): void;
}
