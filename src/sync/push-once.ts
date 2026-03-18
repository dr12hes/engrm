/**
 * Lightweight one-shot push for hooks.
 *
 * Hooks run as separate Bun processes outside the MCP server,
 * so they can't use the SyncEngine's timers. This module provides
 * a direct "push pending outbox entries now" that hooks can call
 * before exiting.
 *
 * Fails silently — hooks must never crash.
 */

import type { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { VectorClient } from "./client.js";
import { pushOutbox } from "./push.js";
import { pullSettings } from "./pull.js";

/**
 * Push any pending outbox entries to Candengo Vector.
 * Returns the number of entries pushed, or 0 on failure.
 *
 * Safe to call from hooks — never throws.
 */
export async function pushOnce(
  db: MemDatabase,
  config: Config
): Promise<number> {
  if (!config.sync.enabled) return 0;
  if (!VectorClient.isConfigured(config)) return 0;

  try {
    const client = new VectorClient(config);
    const result = await pushOutbox(db, client, config, config.sync.batch_size);
    await pullSettings(client, config);
    return result.pushed;
  } catch {
    return 0;
  }
}
