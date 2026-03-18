import { runMigrations, ensureObservationTypes } from "./migrations.js";

/**
 * Cross-runtime SQLite adapter.
 *
 * Uses bun:sqlite when running under Bun (fast, native),
 * falls back to better-sqlite3 when running under Node.js.
 * Both expose the same .query() / .exec() / .close() interface.
 */

// Unified result type (matches both runtimes)
interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface CompatDatabase {
  query<Row = unknown, Params extends unknown[] = unknown[]>(
    sql: string
  ): {
    get(...params: Params): Row | undefined;
    all(...params: Params): Row[];
    run(...params: Params): RunResult;
  };
  exec(sql: string): void;
  close(): void;
}

const IS_BUN = typeof globalThis.Bun !== "undefined";

/**
 * Create a CompatDatabase from a file path.
 * Auto-detects runtime and uses the appropriate SQLite driver.
 */
function openDatabase(dbPath: string): CompatDatabase {
  if (IS_BUN) {
    return openBunDatabase(dbPath);
  }
  return openNodeDatabase(dbPath);
}

/**
 * Open database using bun:sqlite (Bun runtime).
 * bun:sqlite already has .query() — just type-cast it.
 */
function openBunDatabase(dbPath: string): CompatDatabase {
  // Dynamic import to avoid Node.js parse errors
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Database } = require("bun:sqlite");

  // Use Homebrew SQLite on macOS for extension support
  if (process.platform === "darwin") {
    const { existsSync } = require("node:fs");
    const paths = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        try { Database.setCustomSQLite(p); } catch { /* already set */ }
        break;
      }
    }
  }

  const db = new Database(dbPath);
  return db as CompatDatabase;
}

/**
 * Open database using better-sqlite3 (Node.js runtime).
 * Wraps .prepare() to provide a .query() interface matching bun:sqlite.
 */
function openNodeDatabase(dbPath: string): CompatDatabase {
  // Dynamic import to avoid Bun trying to load native addon
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BetterSqlite3 = require("better-sqlite3");
  const raw = new BetterSqlite3(dbPath);

  return {
    query<Row = unknown, Params extends unknown[] = unknown[]>(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        get(...params: Params): Row | undefined {
          return stmt.get(...params) as Row | undefined;
        },
        all(...params: Params): Row[] {
          return stmt.all(...params) as Row[];
        },
        run(...params: Params): RunResult {
          return stmt.run(...params);
        },
      };
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    close(): void {
      raw.close();
    },
  };
}

// --- Row types ---

export interface ProjectRow {
  id: number;
  canonical_id: string;
  name: string;
  local_path: string | null;
  remote_url: string | null;
  first_seen_epoch: number;
  last_active_epoch: number;
}

export interface ObservationRow {
  id: number;
  session_id: string | null;
  project_id: number;
  type: string;
  title: string;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  quality: number;
  lifecycle: string;
  sensitivity: string;
  user_id: string;
  device_id: string;
  agent: string;
  created_at: string;
  created_at_epoch: number;
  archived_at_epoch: number | null;
  compacted_into: number | null;
  superseded_by: number | null;
  remote_source_id: string | null;
}

export interface SessionRow {
  id: number;
  session_id: string;
  project_id: number | null;
  user_id: string;
  device_id: string;
  agent: string;
  status: string;
  observation_count: number;
  started_at_epoch: number | null;
  completed_at_epoch: number | null;
}

export interface FtsMatchRow {
  id: number;
  rank: number;
}

export interface VecMatchRow {
  observation_id: number;
  distance: number;
}

export interface SessionSummaryRow {
  id: number;
  session_id: string;
  project_id: number | null;
  user_id: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at_epoch: number | null;
}

export interface SecurityFindingRow {
  id: number;
  session_id: string | null;
  project_id: number;
  finding_type: string;
  severity: string;
  pattern_name: string;
  file_path: string | null;
  snippet: string | null;
  tool_name: string | null;
  user_id: string;
  device_id: string;
  created_at_epoch: number;
}

// --- Insert types ---

export interface InsertObservation {
  session_id?: string | null;
  project_id: number;
  type: string;
  title: string;
  narrative?: string | null;
  facts?: string | null;
  concepts?: string | null;
  files_read?: string | null;
  files_modified?: string | null;
  quality: number;
  lifecycle?: string;
  sensitivity?: string;
  user_id: string;
  device_id: string;
  agent?: string;
  created_at?: string;
  created_at_epoch?: number;
}

export interface InsertProject {
  canonical_id: string;
  name: string;
  local_path?: string | null;
  remote_url?: string | null;
}

export interface InsertSessionSummary {
  session_id: string;
  project_id: number | null;
  user_id: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
}

export interface InsertSecurityFinding {
  session_id?: string | null;
  project_id: number;
  finding_type: string;
  severity: string;
  pattern_name: string;
  file_path?: string | null;
  snippet?: string | null;
  tool_name?: string | null;
  user_id: string;
  device_id: string;
}

// --- Database class ---

export class MemDatabase {
  readonly db: CompatDatabase;
  readonly vecAvailable: boolean;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    // Attempt to load sqlite-vec extension before migrations
    this.vecAvailable = this.loadVecExtension();

    runMigrations(this.db);
    ensureObservationTypes(this.db);
  }

  private loadVecExtension(): boolean {
    try {
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(this.db);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Projects ---

  upsertProject(project: InsertProject): ProjectRow {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .query<ProjectRow, [string]>(
        "SELECT * FROM projects WHERE canonical_id = ?"
      )
      .get(project.canonical_id);

    if (existing) {
      this.db
        .query(
          `UPDATE projects SET
            local_path = COALESCE(?, local_path),
            remote_url = COALESCE(?, remote_url),
            last_active_epoch = ?
          WHERE id = ?`
        )
        .run(
          project.local_path ?? null,
          project.remote_url ?? null,
          now,
          existing.id
        );
      return {
        ...existing,
        local_path: project.local_path ?? existing.local_path,
        remote_url: project.remote_url ?? existing.remote_url,
        last_active_epoch: now,
      };
    }

    const result = this.db
      .query(
        `INSERT INTO projects (canonical_id, name, local_path, remote_url, first_seen_epoch, last_active_epoch)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.canonical_id,
        project.name,
        project.local_path ?? null,
        project.remote_url ?? null,
        now,
        now
      );

    return this.db
      .query<ProjectRow, [number]>("SELECT * FROM projects WHERE id = ?")
      .get(Number(result.lastInsertRowid))!;
  }

  getProjectByCanonicalId(canonicalId: string): ProjectRow | null {
    return (
      this.db
        .query<ProjectRow, [string]>(
          "SELECT * FROM projects WHERE canonical_id = ?"
        )
        .get(canonicalId) ?? null
    );
  }

  getProjectById(id: number): ProjectRow | null {
    return (
      this.db
        .query<ProjectRow, [number]>("SELECT * FROM projects WHERE id = ?")
        .get(id) ?? null
    );
  }

  // --- Observations ---

  insertObservation(obs: InsertObservation): ObservationRow {
    const now = obs.created_at_epoch ?? Math.floor(Date.now() / 1000);
    const createdAt = obs.created_at ?? new Date(now * 1000).toISOString();

    const result = this.db
      .query(
        `INSERT INTO observations (
          session_id, project_id, type, title, narrative, facts, concepts,
          files_read, files_modified, quality, lifecycle, sensitivity,
          user_id, device_id, agent, created_at, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        obs.session_id ?? null,
        obs.project_id,
        obs.type,
        obs.title,
        obs.narrative ?? null,
        obs.facts ?? null,
        obs.concepts ?? null,
        obs.files_read ?? null,
        obs.files_modified ?? null,
        obs.quality,
        obs.lifecycle ?? "active",
        obs.sensitivity ?? "shared",
        obs.user_id,
        obs.device_id,
        obs.agent ?? "claude-code",
        createdAt,
        now
      );

    const id = Number(result.lastInsertRowid);
    const row = this.getObservationById(id)!;

    // Maintain FTS5 index (external content mode — manual sync)
    this.ftsInsert(row);

    // Increment session observation count if applicable
    if (obs.session_id) {
      this.db
        .query(
          "UPDATE sessions SET observation_count = observation_count + 1 WHERE session_id = ?"
        )
        .run(obs.session_id);
    }

    return row;
  }

  getObservationById(id: number): ObservationRow | null {
    return (
      this.db
        .query<ObservationRow, [number]>(
          "SELECT * FROM observations WHERE id = ?"
        )
        .get(id) ?? null
    );
  }

  getObservationsByIds(ids: number[], userId?: string): ObservationRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const visibilityClause = userId
      ? " AND (sensitivity != 'personal' OR user_id = ?)"
      : "";
    return this.db
      .query<ObservationRow, (number | string)[]>(
        `SELECT * FROM observations
         WHERE id IN (${placeholders})${visibilityClause}
         ORDER BY created_at_epoch DESC`
      )
      .all(...ids, ...(userId ? [userId] : []));
  }

  /**
   * Get recent observations for a project within a time window.
   * Used for deduplication checks.
   */
  getRecentObservations(
    projectId: number,
    sincEpoch: number,
    limit: number = 50
  ): ObservationRow[] {
    return this.db
      .query<ObservationRow, [number, number, number]>(
        `SELECT * FROM observations
        WHERE project_id = ? AND created_at_epoch > ?
        ORDER BY created_at_epoch DESC
        LIMIT ?`
      )
      .all(projectId, sincEpoch, limit);
  }

  /**
   * FTS5 search scoped to a project. Returns observation IDs with BM25 rank.
   */
  searchFts(
    query: string,
    projectId: number | null,
    lifecycles: string[] = ["active", "aging", "pinned"],
    limit: number = 20,
    userId?: string
  ): FtsMatchRow[] {
    const lifecyclePlaceholders = lifecycles.map(() => "?").join(",");
    const visibilityClause = userId
      ? " AND (o.sensitivity != 'personal' OR o.user_id = ?)"
      : "";

    if (projectId !== null) {
      return this.db
        .query<FtsMatchRow, (string | number)[]>(
          `SELECT o.id, observations_fts.rank
          FROM observations_fts
          JOIN observations o ON o.id = observations_fts.rowid
          WHERE observations_fts MATCH ?
            AND o.project_id = ?
            AND o.lifecycle IN (${lifecyclePlaceholders})
            ${visibilityClause}
          ORDER BY observations_fts.rank
          LIMIT ?`
        )
        .all(query, projectId, ...lifecycles, ...(userId ? [userId] : []), limit);
    }

    return this.db
      .query<FtsMatchRow, (string | number)[]>(
        `SELECT o.id, observations_fts.rank
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.lifecycle IN (${lifecyclePlaceholders})
          ${visibilityClause}
        ORDER BY observations_fts.rank
        LIMIT ?`
      )
      .all(query, ...lifecycles, ...(userId ? [userId] : []), limit);
  }

  /**
   * Get chronological observations around an anchor.
   */
  getTimeline(
    anchorId: number,
    projectId: number | null,
    depthBefore: number = 3,
    depthAfter: number = 3,
    userId?: string
  ): ObservationRow[] {
    const visibilityClause = userId
      ? " AND (sensitivity != 'personal' OR user_id = ?)"
      : "";
    const anchor = (
      this.db
        .query<ObservationRow, (number | string)[]>(
          `SELECT * FROM observations WHERE id = ?${visibilityClause}`
        )
        .get(anchorId, ...(userId ? [userId] : [])) ?? null
    );
    if (!anchor) return [];

    const projectFilter = projectId !== null ? "AND project_id = ?" : "";
    const projectParams = projectId !== null ? [projectId] : [];
    const visibilityParams = userId ? [userId] : [];

    const before = this.db
      .query<ObservationRow, (number | string | null)[]>(
        `SELECT * FROM observations
        WHERE created_at_epoch < ? ${projectFilter}
          AND lifecycle IN ('active', 'aging', 'pinned')
          ${visibilityClause}
        ORDER BY created_at_epoch DESC
        LIMIT ?`
      )
      .all(anchor.created_at_epoch, ...projectParams, ...visibilityParams, depthBefore);

    const after = this.db
      .query<ObservationRow, (number | string | null)[]>(
        `SELECT * FROM observations
        WHERE created_at_epoch > ? ${projectFilter}
          AND lifecycle IN ('active', 'aging', 'pinned')
          ${visibilityClause}
        ORDER BY created_at_epoch ASC
        LIMIT ?`
      )
      .all(anchor.created_at_epoch, ...projectParams, ...visibilityParams, depthAfter);

    return [...before.reverse(), anchor, ...after];
  }

  /**
   * Pin or unpin an observation.
   */
  pinObservation(id: number, pinned: boolean): boolean {
    const obs = this.getObservationById(id);
    if (!obs) return false;

    // Only active or aging observations can be pinned.
    // Pinned observations can be unpinned back to active.
    if (pinned) {
      if (obs.lifecycle !== "active" && obs.lifecycle !== "aging") return false;
      this.db
        .query("UPDATE observations SET lifecycle = 'pinned' WHERE id = ?")
        .run(id);
    } else {
      if (obs.lifecycle !== "pinned") return false;
      this.db
        .query("UPDATE observations SET lifecycle = 'active' WHERE id = ?")
        .run(id);
    }
    return true;
  }

  /**
   * Count active + aging observations (for quota checks).
   */
  getActiveObservationCount(userId?: string): number {
    if (userId) {
      const result = this.db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) as count FROM observations
          WHERE lifecycle IN ('active', 'aging')
            AND sensitivity != 'secret'
            AND user_id = ?`
        )
        .get(userId);
      return result?.count ?? 0;
    }

    const result = this.db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM observations
        WHERE lifecycle IN ('active', 'aging')
          AND sensitivity != 'secret'`
      )
      .get();
    return result?.count ?? 0;
  }

  // --- Supersession ---

  /**
   * Mark an observation as superseded by a newer one.
   * The old observation is archived and excluded from context/search.
   *
   * Supports chains: if oldId is already superseded, resolves to the
   * current chain head and supersedes that instead. Max depth 10.
   */
  supersedeObservation(oldId: number, newId: number): boolean {
    // Don't allow self-supersession
    if (oldId === newId) return false;

    const replacement = this.getObservationById(newId);
    if (!replacement) return false;

    // Resolve to the current chain head (follow superseded_by links)
    let targetId = oldId;
    const visited = new Set<number>();
    for (let depth = 0; depth < 10; depth++) {
      const target = this.getObservationById(targetId);
      if (!target) return false;

      // If not superseded, this is the head — supersede it
      if (target.superseded_by === null) break;

      // If the head is already the replacement, nothing to do
      if (target.superseded_by === newId) return true;

      // Follow the chain
      visited.add(targetId);
      targetId = target.superseded_by;

      // Cycle detection
      if (visited.has(targetId)) return false;
    }

    const target = this.getObservationById(targetId);
    if (!target) return false;
    if (target.superseded_by !== null) return false; // chain too deep
    if (targetId === newId) return false; // would self-supersede after resolution

    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        `UPDATE observations
         SET superseded_by = ?, lifecycle = 'archived', archived_at_epoch = ?
         WHERE id = ?`
      )
      .run(newId, now, targetId);

    // Remove from search indexes (archived observations shouldn't appear)
    this.ftsDelete(target);
    this.vecDelete(targetId);

    return true;
  }

  /**
   * Check if an observation has been superseded.
   */
  isSuperseded(id: number): boolean {
    const obs = this.getObservationById(id);
    return obs !== null && obs.superseded_by !== null;
  }

  // --- Sessions ---

  upsertSession(
    sessionId: string,
    projectId: number | null,
    userId: string,
    deviceId: string,
    agent: string = "claude-code"
  ): SessionRow {
    const existing = this.db
      .query<SessionRow, [string]>(
        "SELECT * FROM sessions WHERE session_id = ?"
      )
      .get(sessionId);

    if (existing) return existing;

    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        `INSERT INTO sessions (session_id, project_id, user_id, device_id, agent, started_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, projectId, userId, deviceId, agent, now);

    return this.db
      .query<SessionRow, [string]>(
        "SELECT * FROM sessions WHERE session_id = ?"
      )
      .get(sessionId)!;
  }

  completeSession(sessionId: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        "UPDATE sessions SET status = 'completed', completed_at_epoch = ? WHERE session_id = ?"
      )
      .run(now, sessionId);
  }

  // --- Sync outbox ---

  addToOutbox(recordType: "observation" | "summary", recordId: number): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        `INSERT INTO sync_outbox (record_type, record_id, created_at_epoch)
        VALUES (?, ?, ?)`
      )
      .run(recordType, recordId, now);
  }

  // --- Sync state ---

  getSyncState(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM sync_state WHERE key = ?"
      )
      .get(key);
    return row?.value ?? null;
  }

  setSyncState(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?"
      )
      .run(key, value, value);
  }

  // --- FTS5 maintenance (external content mode) ---

  private ftsInsert(obs: ObservationRow): void {
    this.db
      .query(
        `INSERT INTO observations_fts (rowid, title, narrative, facts, concepts)
        VALUES (?, ?, ?, ?, ?)`
      )
      .run(obs.id, obs.title, obs.narrative, obs.facts, obs.concepts);
  }

  ftsDelete(obs: ObservationRow): void {
    this.db
      .query(
        `INSERT INTO observations_fts (observations_fts, rowid, title, narrative, facts, concepts)
        VALUES ('delete', ?, ?, ?, ?, ?)`
      )
      .run(obs.id, obs.title, obs.narrative, obs.facts, obs.concepts);
  }

  // --- sqlite-vec (local semantic search) ---

  /**
   * Insert an embedding for an observation.
   */
  vecInsert(observationId: number, embedding: Float32Array): void {
    if (!this.vecAvailable) return;
    this.db
      .query(
        "INSERT OR REPLACE INTO vec_observations (observation_id, embedding) VALUES (?, ?)"
      )
      .run(observationId, new Uint8Array(embedding.buffer));
  }

  /**
   * Delete an embedding when observation is superseded/archived.
   */
  vecDelete(observationId: number): void {
    if (!this.vecAvailable) return;
    this.db
      .query("DELETE FROM vec_observations WHERE observation_id = ?")
      .run(observationId);
  }

  /**
   * KNN search returning observation IDs with distance.
   * Results filtered by project and lifecycle via JOIN.
   */
  searchVec(
    queryEmbedding: Float32Array,
    projectId: number | null,
    lifecycles: string[] = ["active", "aging", "pinned"],
    limit: number = 20,
    userId?: string
  ): VecMatchRow[] {
    if (!this.vecAvailable) return [];

    const lifecyclePlaceholders = lifecycles.map(() => "?").join(",");
    const embeddingBlob = new Uint8Array(queryEmbedding.buffer);
    const visibilityClause = userId
      ? " AND (o.sensitivity != 'personal' OR o.user_id = ?)"
      : "";

    if (projectId !== null) {
      return this.db
        .query<VecMatchRow, any[]>(
          `SELECT v.observation_id, v.distance
           FROM vec_observations v
           JOIN observations o ON o.id = v.observation_id
           WHERE v.embedding MATCH ?
             AND k = ?
             AND o.project_id = ?
             AND o.lifecycle IN (${lifecyclePlaceholders})
             AND o.superseded_by IS NULL`
             + visibilityClause
        )
        .all(embeddingBlob, limit, projectId, ...lifecycles, ...(userId ? [userId] : []));
    }

    return this.db
      .query<VecMatchRow, any[]>(
        `SELECT v.observation_id, v.distance
         FROM vec_observations v
         JOIN observations o ON o.id = v.observation_id
         WHERE v.embedding MATCH ?
           AND k = ?
           AND o.lifecycle IN (${lifecyclePlaceholders})
           AND o.superseded_by IS NULL`
          + visibilityClause
      )
      .all(embeddingBlob, limit, ...lifecycles, ...(userId ? [userId] : []));
  }

  /**
   * Count observations without embeddings (for backfill progress).
   */
  getUnembeddedCount(): number {
    if (!this.vecAvailable) return 0;
    const result = this.db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM observations o
         WHERE o.lifecycle IN ('active', 'aging', 'pinned')
         AND o.superseded_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM vec_observations v WHERE v.observation_id = o.id
         )`
      )
      .get();
    return result?.count ?? 0;
  }

  /**
   * Get unembedded observations for backfill.
   */
  getUnembeddedObservations(limit: number = 100): ObservationRow[] {
    if (!this.vecAvailable) return [];
    return this.db
      .query<ObservationRow, [number]>(
        `SELECT o.* FROM observations o
         WHERE o.lifecycle IN ('active', 'aging', 'pinned')
         AND o.superseded_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM vec_observations v WHERE v.observation_id = o.id
         )
         ORDER BY o.created_at_epoch DESC
         LIMIT ?`
      )
      .all(limit);
  }

  // --- Session summaries ---

  insertSessionSummary(summary: InsertSessionSummary): SessionSummaryRow {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .query(
        `INSERT INTO session_summaries (session_id, project_id, user_id, request, investigated, learned, completed, next_steps, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        summary.session_id,
        summary.project_id,
        summary.user_id,
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.next_steps,
        now
      );

    const id = Number(result.lastInsertRowid);
    return this.db
      .query<SessionSummaryRow, [number]>(
        "SELECT * FROM session_summaries WHERE id = ?"
      )
      .get(id)!;
  }

  getSessionSummary(sessionId: string): SessionSummaryRow | null {
    return (
      this.db
        .query<SessionSummaryRow, [string]>(
          "SELECT * FROM session_summaries WHERE session_id = ?"
        )
        .get(sessionId) ?? null
    );
  }

  getRecentSummaries(projectId: number, limit: number = 5): SessionSummaryRow[] {
    return this.db
      .query<SessionSummaryRow, [number, number]>(
        `SELECT * FROM session_summaries
         WHERE project_id = ?
         ORDER BY created_at_epoch DESC, id DESC
         LIMIT ?`
      )
      .all(projectId, limit);
  }

  // --- Session metrics ---

  incrementSessionMetrics(
    sessionId: string,
    increments: { files?: number; searches?: number; toolCalls?: number }
  ): void {
    const sets: string[] = [];
    const params: (number | string)[] = [];

    if (increments.files) {
      sets.push("files_touched_count = files_touched_count + ?");
      params.push(increments.files);
    }
    if (increments.searches) {
      sets.push("searches_performed = searches_performed + ?");
      params.push(increments.searches);
    }
    if (increments.toolCalls) {
      sets.push("tool_calls_count = tool_calls_count + ?");
      params.push(increments.toolCalls);
    }

    if (sets.length === 0) return;

    params.push(sessionId);
    this.db
      .query(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id = ?`)
      .run(...params);
  }

  getSessionMetrics(sessionId: string): SessionRow & {
    files_touched_count: number;
    searches_performed: number;
    tool_calls_count: number;
  } | null {
    return (
      this.db
        .query<
          SessionRow & {
            files_touched_count: number;
            searches_performed: number;
            tool_calls_count: number;
          },
          [string]
        >("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId) ?? null
    );
  }

  // --- Security findings ---

  insertSecurityFinding(finding: InsertSecurityFinding): SecurityFindingRow {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .query(
        `INSERT INTO security_findings (session_id, project_id, finding_type, severity, pattern_name, file_path, snippet, tool_name, user_id, device_id, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        finding.session_id ?? null,
        finding.project_id,
        finding.finding_type,
        finding.severity,
        finding.pattern_name,
        finding.file_path ?? null,
        finding.snippet ?? null,
        finding.tool_name ?? null,
        finding.user_id,
        finding.device_id,
        now
      );

    const id = Number(result.lastInsertRowid);
    return this.db
      .query<SecurityFindingRow, [number]>(
        "SELECT * FROM security_findings WHERE id = ?"
      )
      .get(id)!;
  }

  getSecurityFindings(
    projectId: number,
    options: { severity?: string; limit?: number } = {}
  ): SecurityFindingRow[] {
    const limit = options.limit ?? 50;
    if (options.severity) {
      return this.db
        .query<SecurityFindingRow, [number, string, number]>(
          `SELECT * FROM security_findings
           WHERE project_id = ? AND severity = ?
           ORDER BY created_at_epoch DESC
           LIMIT ?`
        )
        .all(projectId, options.severity, limit);
    }
    return this.db
      .query<SecurityFindingRow, [number, number]>(
        `SELECT * FROM security_findings
         WHERE project_id = ?
         ORDER BY created_at_epoch DESC
         LIMIT ?`
      )
      .all(projectId, limit);
  }

  getSecurityFindingsCount(projectId: number): Record<string, number> {
    const rows = this.db
      .query<{ severity: string; count: number }, [number]>(
        `SELECT severity, COUNT(*) as count FROM security_findings
         WHERE project_id = ?
         GROUP BY severity`
      )
      .all(projectId);

    const counts: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const row of rows) {
      counts[row.severity] = row.count;
    }
    return counts;
  }

  setSessionRiskScore(sessionId: string, score: number): void {
    this.db
      .query("UPDATE sessions SET risk_score = ? WHERE session_id = ?")
      .run(score, sessionId);
  }

  // --- Observations by session ---

  getObservationsBySession(sessionId: string): ObservationRow[] {
    return this.db
      .query<ObservationRow, [string]>(
        `SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC`
      )
      .all(sessionId);
  }

  // --- Packs ---

  getInstalledPacks(): string[] {
    try {
      const rows = this.db
        .query<{ name: string }, []>("SELECT name FROM packs_installed")
        .all();
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  markPackInstalled(name: string, observationCount: number): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        "INSERT OR REPLACE INTO packs_installed (name, installed_at, observation_count) VALUES (?, ?, ?)"
      )
      .run(name, now, observationCount);
  }
}
