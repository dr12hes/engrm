/**
 * Lifecycle job scheduler.
 *
 * Checks on MCP server startup whether lifecycle jobs are due,
 * and runs them if needed. Uses sync_state table for last-run tracking.
 *
 * Schedule:
 *   - Aging: daily (24h)
 *   - Compaction: weekly (7 days)
 *   - Purge: monthly (30 days)
 */

import type { MemDatabase } from "../storage/sqlite.js";
import { runAgingJob, type AgingResult } from "./aging.js";
import { runCompactionJob, type CompactionResult } from "./compaction.js";
import { runPurgeJob, type PurgeResult } from "./purge.js";

const DAY = 86400;
const AGING_INTERVAL = 1 * DAY;
const COMPACTION_INTERVAL = 7 * DAY;
const PURGE_INTERVAL = 30 * DAY;

const KEY_AGING = "lifecycle_aging_last_run";
const KEY_COMPACTION = "lifecycle_compaction_last_run";
const KEY_PURGE = "lifecycle_purge_last_run";

export interface SchedulerResult {
  agingRan: boolean;
  compactionRan: boolean;
  purgeRan: boolean;
  aging?: AgingResult;
  compaction?: CompactionResult;
  purge?: PurgeResult;
}

/**
 * Run any lifecycle jobs that are due.
 * Each job is independent — one failure does not block others.
 */
export function runDueJobs(
  db: MemDatabase,
  nowEpoch?: number
): SchedulerResult {
  const now = nowEpoch ?? Math.floor(Date.now() / 1000);
  const result: SchedulerResult = {
    agingRan: false,
    compactionRan: false,
    purgeRan: false,
  };

  // Aging: run if never run or > 24h since last run
  try {
    if (isDue(db, KEY_AGING, AGING_INTERVAL, now)) {
      result.aging = runAgingJob(db, now);
      result.agingRan = true;
      db.setSyncState(KEY_AGING, String(now));
    }
  } catch {
    // Aging job failed — continue with other jobs
  }

  // Compaction: run if never run or > 7 days since last run
  try {
    if (isDue(db, KEY_COMPACTION, COMPACTION_INTERVAL, now)) {
      result.compaction = runCompactionJob(db, now);
      result.compactionRan = true;
      db.setSyncState(KEY_COMPACTION, String(now));
    }
  } catch {
    // Compaction job failed — continue with other jobs
  }

  // Purge: run if never run or > 30 days since last run
  try {
    if (isDue(db, KEY_PURGE, PURGE_INTERVAL, now)) {
      result.purge = runPurgeJob(db, now);
      result.purgeRan = true;
      db.setSyncState(KEY_PURGE, String(now));
    }
  } catch {
    // Purge job failed — log would be nice but don't crash
  }

  return result;
}

/**
 * Check if a job is due based on its last run timestamp.
 */
function isDue(
  db: MemDatabase,
  key: string,
  interval: number,
  now: number
): boolean {
  const lastRun = db.getSyncState(key);
  if (!lastRun) return true; // Never run
  const lastEpoch = parseInt(lastRun, 10);
  if (isNaN(lastEpoch)) return true;
  return now - lastEpoch >= interval;
}
