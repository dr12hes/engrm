/**
 * Aging job: transition active observations older than 30 days to 'aging'.
 *
 * Runs daily (checked on MCP server startup via scheduler).
 * Aging observations remain in FTS5 and are searchable at 0.7x weight.
 */

import type { MemDatabase } from "../storage/sqlite.js";

const AGING_THRESHOLD_SECONDS = 30 * 86400; // 30 days

export interface AgingResult {
  transitioned: number;
}

/**
 * Move active observations older than 30 days to aging lifecycle.
 * Pinned observations are never aged.
 */
export function runAgingJob(
  db: MemDatabase,
  nowEpoch?: number
): AgingResult {
  const now = nowEpoch ?? Math.floor(Date.now() / 1000);
  const cutoff = now - AGING_THRESHOLD_SECONDS;

  const result = db.db
    .query(
      `UPDATE observations SET lifecycle = 'aging'
       WHERE lifecycle = 'active'
       AND created_at_epoch < ?`
    )
    .run(cutoff);

  return { transitioned: result.changes };
}
