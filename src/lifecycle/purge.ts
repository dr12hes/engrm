/**
 * Purge job: permanently delete archived observations older than 12 months.
 *
 * Runs monthly (checked on MCP server startup via scheduler).
 * Pinned observations and digests are never purged.
 */

import type { MemDatabase } from "../storage/sqlite.js";

const PURGE_THRESHOLD_SECONDS = 365 * 86400; // 12 months

export interface PurgeResult {
  deleted: number;
}

/**
 * Delete archived observations whose archived_at_epoch is older than 12 months.
 * Only affects observations with lifecycle = 'archived' and a non-null archived_at_epoch.
 */
export function runPurgeJob(
  db: MemDatabase,
  nowEpoch?: number
): PurgeResult {
  const now = nowEpoch ?? Math.floor(Date.now() / 1000);
  const cutoff = now - PURGE_THRESHOLD_SECONDS;

  const result = db.db
    .query(
      `DELETE FROM observations
       WHERE lifecycle = 'archived'
       AND archived_at_epoch IS NOT NULL
       AND archived_at_epoch < ?`
    )
    .run(cutoff);

  return { deleted: result.changes };
}
