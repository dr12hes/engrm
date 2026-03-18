/**
 * memory_stats MCP tool.
 *
 * Gives a compact operational view of the memory layer so users can
 * understand what has been captured and synced.
 */

import type { MemDatabase } from "../storage/sqlite.js";
import { getOutboxStats } from "../storage/outbox.js";

export interface MemoryStatsResult {
  active_observations: number;
  messages: number;
  session_summaries: number;
  installed_packs: string[];
  outbox: Record<string, number>;
}

export function getMemoryStats(db: MemDatabase): MemoryStatsResult {
  const activeObservations = db.getActiveObservationCount();
  const messages = db.db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM observations
       WHERE type = 'message' AND lifecycle IN ('active', 'aging', 'pinned')`
    )
    .get()?.count ?? 0;

  const sessionSummaries = db.db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM session_summaries")
    .get()?.count ?? 0;

  return {
    active_observations: activeObservations,
    messages,
    session_summaries: sessionSummaries,
    installed_packs: db.getInstalledPacks(),
    outbox: getOutboxStats(db),
  };
}
