/**
 * Local embedding model for offline semantic search.
 *
 * Uses @xenova/transformers to run all-MiniLM-L6-v2 (384 dims)
 * entirely in-process via ONNX/WASM. No server needed.
 *
 * Lazy-loaded on first use — model downloaded on first run (~23MB),
 * cached in ~/.cache/huggingface/ thereafter.
 *
 * Graceful degradation: if model fails to load, all functions
 * return null and search falls back to FTS5 only.
 */

import type { ObservationRow } from "../storage/sqlite.js";

// --- State ---

let _available: boolean | null = null; // null = not yet checked
let _pipeline: any = null;

export const EMBEDDING_DIMS = 384;
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

// --- Public API ---

/**
 * Check if local embedding is available.
 * First call triggers model loading.
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    await getPipeline();
    return _available!;
  } catch {
    _available = false;
    return false;
  }
}

/**
 * Embed a single text string. Returns Float32Array[384] or null if unavailable.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  const pipe = await getPipeline();
  if (!pipe) return null;

  try {
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  } catch {
    return null;
  }
}

/**
 * Batch embed multiple texts. More efficient than individual calls.
 */
export async function embedTexts(
  texts: string[]
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];

  const pipe = await getPipeline();
  if (!pipe) return texts.map(() => null);

  const results: (Float32Array | null)[] = [];
  // Process one at a time — @xenova/transformers handles batching internally
  // but individual calls are more resilient to failures
  for (const text of texts) {
    try {
      const output = await pipe(text, { pooling: "mean", normalize: true });
      results.push(new Float32Array(output.data));
    } catch {
      results.push(null);
    }
  }
  return results;
}

/**
 * Compose the text to embed from an observation's fields.
 * Mirrors the content composition in push.ts buildVectorDocument.
 */
export function composeEmbeddingText(obs: {
  title: string;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
}): string {
  const parts = [obs.title];

  if (obs.narrative) parts.push(obs.narrative);

  if (obs.facts) {
    try {
      const facts = JSON.parse(obs.facts) as string[];
      if (Array.isArray(facts) && facts.length > 0) {
        parts.push(facts.map((f) => `- ${f}`).join("\n"));
      }
    } catch {
      parts.push(obs.facts);
    }
  }

  if (obs.concepts) {
    try {
      const concepts = JSON.parse(obs.concepts) as string[];
      if (Array.isArray(concepts) && concepts.length > 0) {
        parts.push(concepts.join(", "));
      }
    } catch {
      // ignore
    }
  }

  return parts.join("\n\n");
}

// --- Internal ---

async function getPipeline(): Promise<any> {
  if (_pipeline) return _pipeline;
  if (_available === false) return null;

  try {
    const { pipeline } = await import("@xenova/transformers");
    _pipeline = await pipeline("feature-extraction", MODEL_NAME);
    _available = true;
    return _pipeline;
  } catch (err) {
    _available = false;
    // Log once, then silent
    console.error(
      `[engrm] Local embedding model unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
