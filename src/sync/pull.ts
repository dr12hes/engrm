/**
 * Pull engine: fetch observations from Candengo Vector change feed
 * and merge into local SQLite.
 *
 * Uses server-side cursors to track position in the change feed.
 * Skips observations from the current device (already local).
 */

import type { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { saveConfig } from "../config.js";
import { VectorClient, type VectorSearchResult } from "./client.js";
import { parseSourceId } from "./auth.js";
import { composeEmbeddingText, embedText } from "../embeddings/embedder.js";

const PULL_CURSOR_KEY = "pull_cursor";

export interface PullResult {
  received: number;
  merged: number;
  skipped: number;
}

/** Safety limit to prevent infinite loops if server keeps returning has_more. */
const MAX_PAGES = 20;

/**
 * Pull changes from Candengo Vector and merge into local SQLite.
 * Loops on has_more until all pages are consumed (up to MAX_PAGES).
 */
export async function pullFromVector(
  db: MemDatabase,
  client: VectorClient,
  config: Config,
  limit: number = 50
): Promise<PullResult> {
  let cursor = db.getSyncState(PULL_CURSOR_KEY) ?? undefined;
  let totalReceived = 0;
  let totalMerged = 0;
  let totalSkipped = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.pullChanges(cursor, limit);
    const { merged, skipped } = mergeChanges(db, config, response.changes);

    totalReceived += response.changes.length;
    totalMerged += merged;
    totalSkipped += skipped;

    // Update cursor after each page so progress is saved even if we crash
    if (response.cursor) {
      db.setSyncState(PULL_CURSOR_KEY, response.cursor);
      cursor = response.cursor;
    }

    if (!response.has_more || response.changes.length === 0) break;
  }

  return { received: totalReceived, merged: totalMerged, skipped: totalSkipped };
}

/**
 * Merge a batch of changes into local SQLite. Returns merged/skipped counts.
 * Embedding is intentionally synchronous-per-change to avoid overwhelming the model.
 */
function mergeChanges(
  db: MemDatabase,
  config: Config,
  changes: VectorSearchResult[]
): { merged: number; skipped: number } {
  let merged = 0;
  let skipped = 0;

  for (const change of changes) {
    const parsed = parseSourceId(change.source_id);
    const remoteSummary = isRemoteSummary(change);

    // Skip observations from own device
    if (parsed && parsed.deviceId === config.device_id) {
      skipped++;
      continue;
    }

    // Find or create the project
    const projectCanonical =
      (change.metadata?.project_canonical as string) ?? null;
    if (!projectCanonical) {
      skipped++;
      continue;
    }

    let project = db.getProjectByCanonicalId(projectCanonical);
    if (!project) {
      project = db.upsertProject({
        canonical_id: projectCanonical,
        name:
          (change.metadata?.project_name as string) ??
          projectCanonical.split("/").pop() ??
          "unknown",
      });
    }

    if (remoteSummary) {
      const mergedSummary = mergeRemoteSummary(db, config, change, project.id);
      if (mergedSummary) {
        merged++;
      }
    }

    // Check if already imported (by remote_source_id)
    const existing = db.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM observations WHERE remote_source_id = ?"
      )
      .get(change.source_id);

    if (existing) {
      if (!remoteSummary) skipped++;
      continue;
    }

    const normalizedType = normalizeRemoteObservationType(
      change.metadata?.type,
      change.source_id
    );
    if (!normalizedType) {
      skipped++;
      continue;
    }

    // Insert the observation
    const obs = db.insertObservation({
      session_id: (change.metadata?.session_id as string) ?? null,
      project_id: project.id,
      type: normalizedType,
      title: (change.metadata?.title as string) ?? change.content.split("\n")[0] ?? "Untitled",
      narrative: extractNarrative(change.content),
      facts: change.metadata?.facts
        ? JSON.stringify(change.metadata.facts)
        : null,
      concepts: change.metadata?.concepts
        ? JSON.stringify(change.metadata.concepts)
        : null,
      quality: (change.metadata?.quality as number) ?? 0.5,
      lifecycle: "active",
      sensitivity: (change.metadata?.sensitivity as string) ?? "shared",
      user_id: (change.metadata?.user_id as string) ?? "unknown",
      device_id: (change.metadata?.device_id as string) ?? "unknown",
      agent: (change.metadata?.agent as string) ?? "unknown",
      created_at: (change.metadata?.created_at as string) ?? undefined,
      created_at_epoch: (change.metadata?.created_at_epoch as number) ?? undefined,
    });

    // Mark with remote source ID for dedup
    db.db
      .query("UPDATE observations SET remote_source_id = ? WHERE id = ?")
      .run(change.source_id, obs.id);

    // Embed for local vector search (fire-and-forget — don't block pull loop)
    if (db.vecAvailable) {
      embedAndInsert(db, obs).catch(() => {});
    }

    merged++;
  }

  return { merged, skipped };
}

function isRemoteSummary(change: VectorSearchResult): boolean {
  const rawType = typeof change.metadata?.type === "string" ? change.metadata.type.toLowerCase() : "";
  return rawType === "summary" || change.source_id.includes("-summary-");
}

function mergeRemoteSummary(
  db: MemDatabase,
  config: Config,
  change: VectorSearchResult,
  projectId: number
): boolean {
  const sessionId = typeof change.metadata?.session_id === "string" ? change.metadata.session_id : null;
  if (!sessionId) return false;

  const summary = db.upsertSessionSummary({
    session_id: sessionId,
    project_id: projectId,
    user_id:
      (typeof change.metadata?.user_id === "string" ? change.metadata.user_id : null) ??
      config.user_id,
    request: typeof change.metadata?.request === "string" ? change.metadata.request : null,
    investigated:
      typeof change.metadata?.investigated === "string" ? change.metadata.investigated : null,
    learned: typeof change.metadata?.learned === "string" ? change.metadata.learned : null,
    completed: typeof change.metadata?.completed === "string" ? change.metadata.completed : null,
    next_steps: typeof change.metadata?.next_steps === "string" ? change.metadata.next_steps : null,
  });

  return Boolean(summary);
}

function normalizeRemoteObservationType(
  rawType: unknown,
  sourceId: string
): string | null {
  const type = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  if (
    type === "bugfix" ||
    type === "discovery" ||
    type === "decision" ||
    type === "pattern" ||
    type === "change" ||
    type === "feature" ||
    type === "refactor" ||
    type === "digest" ||
    type === "standard" ||
    type === "message"
  ) {
    return type;
  }

  if (type === "summary") {
    return "digest";
  }

  if (!type) {
    if (sourceId.includes("-summary-")) return "digest";
    if (sourceId.includes("-message-")) return "message";
    return "standard";
  }

  return "standard";
}

/**
 * Embed an observation and insert into vec_observations.
 */
async function embedAndInsert(
  db: MemDatabase,
  obs: { id: number; title: string; narrative: string | null; facts: string | null; concepts: string | null }
): Promise<void> {
  const text = composeEmbeddingText(obs);
  const embedding = await embedText(text);
  if (embedding) db.vecInsert(obs.id, embedding);
}

/**
 * Extract narrative from Vector content (everything after the title line).
 */
function extractNarrative(content: string): string | null {
  const lines = content.split("\n");
  if (lines.length <= 1) return null;
  const narrative = lines.slice(1).join("\n").trim();
  return narrative.length > 0 ? narrative : null;
}

/**
 * Pull user settings from the server and merge into local config.
 * Returns true if any settings were changed and saved.
 *
 * Best-effort: never throws — returns false on any error.
 */
export async function pullSettings(
  client: VectorClient,
  config: Config
): Promise<boolean> {
  try {
    const settings = await client.fetchSettings();
    if (!settings) return false;

    let changed = false;

    // Merge transcript_analysis settings
    if (settings.transcript_analysis !== undefined) {
      const ta = settings.transcript_analysis;
      if (typeof ta === "object" && ta !== null) {
        const taObj = ta as Record<string, unknown>;
        if (
          taObj.enabled !== undefined &&
          taObj.enabled !== config.transcript_analysis.enabled
        ) {
          config.transcript_analysis.enabled = !!taObj.enabled;
          changed = true;
        }
      }
    }

    // Merge observer settings
    if (settings.observer !== undefined) {
      const obs = settings.observer;
      if (typeof obs === "object" && obs !== null) {
        const obsObj = obs as Record<string, unknown>;
        if (
          obsObj.enabled !== undefined &&
          obsObj.enabled !== config.observer.enabled
        ) {
          config.observer.enabled = !!obsObj.enabled;
          changed = true;
        }
        if (
          obsObj.model !== undefined &&
          typeof obsObj.model === "string" &&
          obsObj.model !== config.observer.model
        ) {
          config.observer.model = obsObj.model;
          changed = true;
        }
      }
    }

    if (changed) {
      saveConfig(config);
    }

    return changed;
  } catch {
    return false;
  }
}
