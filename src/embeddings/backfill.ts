/**
 * Backfill embeddings for observations that pre-date sqlite-vec.
 *
 * Runs on startup, processing a batch of unembedded observations.
 * Non-blocking — if embedding is unavailable, silently returns.
 */

import type { MemDatabase } from "../storage/sqlite.js";
import {
  composeEmbeddingText,
  embedText,
  isEmbeddingAvailable,
} from "./embedder.js";

export interface BackfillResult {
  processed: number;
  failed: number;
  remaining: number;
}

/**
 * Embed observations that don't yet have vectors.
 * Processes up to `batchSize` per call. Returns counts.
 */
export async function backfillEmbeddings(
  db: MemDatabase,
  batchSize: number = 50
): Promise<BackfillResult> {
  if (!db.vecAvailable) return { processed: 0, failed: 0, remaining: 0 };
  if (!(await isEmbeddingAvailable()))
    return { processed: 0, failed: 0, remaining: 0 };

  const observations = db.getUnembeddedObservations(batchSize);
  let processed = 0;
  let failed = 0;

  for (const obs of observations) {
    const text = composeEmbeddingText(obs);
    const embedding = await embedText(text);
    if (embedding) {
      db.vecInsert(obs.id, embedding);
      processed++;
    } else {
      failed++;
    }
  }

  const remaining = db.getUnembeddedCount();
  return { processed, failed, remaining };
}
