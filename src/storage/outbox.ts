/**
 * Sync outbox queue management.
 *
 * The outbox queues observations and summaries for push to Candengo Vector.
 * Supports exponential backoff on retries and batch processing.
 *
 * Flow: pending → syncing → synced | failed (with retry)
 */

import type { MemDatabase } from "./sqlite.js";

export interface OutboxEntry {
  id: number;
  record_type: "observation" | "summary" | "chat_message";
  record_id: number;
  status: string;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  created_at_epoch: number;
  synced_at_epoch: number | null;
  next_retry_epoch: number | null;
}

/**
 * Get pending outbox entries that are ready to sync.
 * Returns entries that are 'pending' or 'failed' with next_retry_epoch in the past.
 */
export function getPendingEntries(
  db: MemDatabase,
  limit: number = 50
): OutboxEntry[] {
  const now = Math.floor(Date.now() / 1000);
  return db.db
    .query<OutboxEntry, [number, number]>(
      `SELECT * FROM sync_outbox
      WHERE (status = 'pending')
        OR (status = 'failed' AND retry_count < max_retries AND (next_retry_epoch IS NULL OR next_retry_epoch <= ?))
      ORDER BY created_at_epoch ASC
      LIMIT ?`
    )
    .all(now, limit);
}

/**
 * Mark an entry as syncing (in-progress).
 */
export function markSyncing(db: MemDatabase, entryId: number): void {
  db.db
    .query("UPDATE sync_outbox SET status = 'syncing' WHERE id = ?")
    .run(entryId);
}

/**
 * Mark an entry as successfully synced.
 */
export function markSynced(db: MemDatabase, entryId: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.db
    .query(
      "UPDATE sync_outbox SET status = 'synced', synced_at_epoch = ? WHERE id = ?"
    )
    .run(now, entryId);
}

/**
 * Mark an entry as failed with exponential backoff for retry.
 * Backoff: 30s, 60s, 120s, 240s, ... capped at 1 hour.
 */
export function markFailed(
  db: MemDatabase,
  entryId: number,
  error: string
): void {
  const now = Math.floor(Date.now() / 1000);

  // Atomic increment — avoids TOCTOU race on retry_count.
  // Backoff: 30 * 2^(retry_count) seconds, capped at 3600.
  db.db
    .query(
      `UPDATE sync_outbox SET
        status = 'failed',
        retry_count = retry_count + 1,
        last_error = ?,
        next_retry_epoch = ? + MIN(30 * (1 << retry_count), 3600)
      WHERE id = ?`
    )
    .run(error, now, entryId);
}

/**
 * Clean up old synced entries (older than the given epoch).
 * Prevents the outbox table from growing unbounded.
 */
export function purgeSynced(
  db: MemDatabase,
  olderThanEpoch: number
): number {
  const result = db.db
    .query(
      "DELETE FROM sync_outbox WHERE status = 'synced' AND synced_at_epoch < ?"
    )
    .run(olderThanEpoch);
  return result.changes;
}

/**
 * Get outbox stats for diagnostics.
 */
export function getOutboxStats(
  db: MemDatabase
): Record<string, number> {
  const rows = db.db
    .query<{ status: string; count: number }, []>(
      "SELECT status, COUNT(*) as count FROM sync_outbox GROUP BY status"
    )
    .all();

  const stats: Record<string, number> = {
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
  };

  for (const row of rows) {
    stats[row.status] = row.count;
  }

  return stats;
}

/**
 * Reset failed entries back to pending so they can be retried immediately.
 * Useful after auth/config changes that make previously terminal failures recoverable.
 */
export function resetFailedEntries(db: MemDatabase): number {
  const result = db.db
    .query(
      `UPDATE sync_outbox
       SET status = 'pending',
           retry_count = 0,
           last_error = NULL,
           next_retry_epoch = NULL
       WHERE status = 'failed'`
    )
    .run();
  return result.changes;
}

/**
 * Reset in-progress entries back to pending.
 * This is safe on process restart because syncing state is local bookkeeping only.
 */
export function resetSyncingEntries(db: MemDatabase): number {
  const result = db.db
    .query(
      `UPDATE sync_outbox
       SET status = 'pending',
           next_retry_epoch = NULL
       WHERE status = 'syncing'`
    )
    .run();
  return result.changes;
}
