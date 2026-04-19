/**
 * EmbeddingService — in-process sentence embeddings for knowledge dedup + retrieval.
 *
 * Loads all-MiniLM-L6-v2 via @huggingface/transformers (ONNX runtime, no Python).
 * Model loads async at startup (~9s), embeddings are 2-4ms per text after that.
 *
 * Used by:
 * - knowledge_integrator.py (via POST /embed) for dedup before asserting facts
 * - graph_query.py (via POST /embed) for semantic retrieval
 */

import { log, warn } from "../log.js";

const TAG = "embedding";
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type Pipeline = (texts: string | string[], options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

export class EmbeddingService {
  private pipeline: Pipeline | null = null;
  private loading = false;
  private _ready = false;

  get ready(): boolean {
    return this._ready;
  }

  /** Load the model in the background. Non-blocking — returns immediately. */
  loadAsync(): void {
    if (this.loading || this._ready) return;
    this.loading = true;

    const start = Date.now();
    log(TAG, `loading ${MODEL_ID} (background)...`);

    import("@huggingface/transformers").then(async ({ pipeline }) => {
      this.pipeline = await pipeline("feature-extraction", MODEL_ID) as unknown as Pipeline;
      this._ready = true;
      log(TAG, `model ready in ${Date.now() - start}ms (384 dims)`);
    }).catch((err) => {
      warn(TAG, `failed to load model: ${err.message?.slice(0, 100)}`);
      this.loading = false;
    });
  }

  /** Embed one or more texts. Returns array of float32 arrays (384 dims each). */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.pipeline) {
      throw new Error("Embedding model not loaded yet");
    }

    const results: Float32Array[] = [];
    for (const text of texts) {
      const output = await this.pipeline(text, { pooling: "mean", normalize: true });
      results.push(new Float32Array(output.data));
    }
    return results;
  }

  /** Compute cosine similarity between two embeddings. */
  static cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }
}
