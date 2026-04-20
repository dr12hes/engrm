import {
  runMigrations,
  ensureObservationTypes,
  ensureSessionSummaryColumns,
  ensureChatMessageColumns,
  ensureChatVectorTable,
  ensureSyncOutboxSupportsChatMessages,
} from "./migrations.js";
import { createHash } from "node:crypto";
import { normalizeSummaryRequest, normalizeSummarySection } from "../intelligence/summary-sections.js";

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
  __raw?: unknown;
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
    if (process.platform === "darwin") {
      try {
        return openNodeDatabase(dbPath);
      } catch {
        // Fall back to bun:sqlite if the native addon is unavailable
      }
    }
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
    __raw: raw,
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
  source_tool: string | null;
  source_prompt_number: number | null;
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

export interface RecentSessionRow extends SessionRow {
  project_name: string | null;
  request: string | null;
  completed: string | null;
  current_thread?: string | null;
  capture_state?: string | null;
  recent_tool_names?: string | null;
  hot_files?: string | null;
  recent_outcomes?: string | null;
  prompt_count: number;
  tool_event_count: number;
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
  current_thread?: string | null;
  capture_state?: string | null;
  recent_tool_names?: string | null;
  hot_files?: string | null;
  recent_outcomes?: string | null;
  created_at_epoch: number | null;
}

export interface UserPromptRow {
  id: number;
  session_id: string;
  project_id: number | null;
  prompt_number: number;
  prompt: string;
  prompt_hash: string;
  cwd: string | null;
  user_id: string;
  device_id: string;
  agent: string;
  created_at_epoch: number;
}

export interface ToolEventRow {
  id: number;
  session_id: string;
  project_id: number | null;
  tool_name: string;
  tool_input_json: string | null;
  tool_response_preview: string | null;
  file_path: string | null;
  command: string | null;
  user_id: string;
  device_id: string;
  agent: string;
  created_at_epoch: number;
}

export interface ChatMessageRow {
  id: number;
  session_id: string;
  project_id: number | null;
  role: "user" | "assistant";
  content: string;
  user_id: string;
  device_id: string;
  agent: string;
  created_at_epoch: number;
  remote_source_id: string | null;
  source_kind: "hook" | "transcript";
  transcript_index: number | null;
}

export interface VecChatMatchRow {
  chat_message_id: number;
  distance: number;
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
  source_tool?: string | null;
  source_prompt_number?: number | null;
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
  current_thread?: string | null;
  capture_state?: string | null;
  recent_tool_names?: string | null;
  hot_files?: string | null;
  recent_outcomes?: string | null;
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

export interface InsertUserPrompt {
  session_id: string;
  project_id: number | null;
  prompt: string;
  cwd?: string | null;
  user_id: string;
  device_id: string;
  agent?: string;
  created_at_epoch?: number;
}

export interface InsertToolEvent {
  session_id: string;
  project_id: number | null;
  tool_name: string;
  tool_input_json?: string | null;
  tool_response_preview?: string | null;
  file_path?: string | null;
  command?: string | null;
  user_id: string;
  device_id: string;
  agent?: string;
  created_at_epoch?: number;
}

export interface InsertChatMessage {
  session_id: string;
  project_id: number | null;
  role: "user" | "assistant";
  content: string;
  user_id: string;
  device_id: string;
  agent?: string;
  created_at_epoch?: number;
  remote_source_id?: string | null;
  source_kind?: "hook" | "transcript";
  transcript_index?: number | null;
}

// --- Database class ---

export class MemDatabase {
  readonly db: CompatDatabase;
  readonly vecAvailable: boolean;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Attempt to load sqlite-vec extension before migrations
    this.vecAvailable = this.loadVecExtension();

    runMigrations(this.db);
    ensureObservationTypes(this.db);
    ensureSessionSummaryColumns(this.db);
    ensureChatMessageColumns(this.db);
    ensureChatVectorTable(this.db);
    ensureSyncOutboxSupportsChatMessages(this.db);
  }

  private loadVecExtension(): boolean {
    try {
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load((this.db.__raw ?? this.db) as object);
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
    const canonicalId = project.canonical_id?.trim();
    const name = project.name?.trim();
    if (!canonicalId) {
      throw new Error("Project canonical_id is required");
    }
    if (!name) {
      throw new Error("Project name is required");
    }
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .query<ProjectRow, [string]>(
        "SELECT * FROM projects WHERE canonical_id = ?"
      )
      .get(canonicalId);

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
        canonicalId,
        name,
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
          user_id, device_id, agent, source_tool, source_prompt_number,
          created_at, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        obs.source_tool ?? null,
        obs.source_prompt_number ?? null,
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

  reassignObservationProject(observationId: number, projectId: number): boolean {
    const existing = this.getObservationById(observationId);
    if (!existing) return false;
    if (existing.project_id === projectId) return true;

    this.db
      .query("UPDATE observations SET project_id = ? WHERE id = ?")
      .run(projectId, observationId);

    return true;
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

  updateObservationContent(
    id: number,
    update: {
      title: string;
      narrative?: string | null;
      facts?: string | null;
      concepts?: string | null;
      created_at_epoch?: number;
    }
  ): ObservationRow | null {
    const existing = this.getObservationById(id);
    if (!existing) return null;

    const createdAtEpoch = update.created_at_epoch ?? existing.created_at_epoch;
    const createdAt = new Date(createdAtEpoch * 1000).toISOString();

    this.db
      .query(
        `UPDATE observations
         SET title = ?, narrative = ?, facts = ?, concepts = ?, created_at = ?, created_at_epoch = ?
         WHERE id = ?`
      )
      .run(
        update.title,
        update.narrative ?? null,
        update.facts ?? null,
        update.concepts ?? null,
        createdAt,
        createdAtEpoch,
        id
      );

    this.ftsDelete(existing);
    const refreshed = this.getObservationById(id);
    if (!refreshed) return null;
    this.ftsInsert(refreshed);
    return refreshed;
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

    if (existing) {
      if (existing.project_id === null && projectId !== null) {
        this.db
          .query("UPDATE sessions SET project_id = ? WHERE session_id = ?")
          .run(projectId, sessionId);
        return this.db
          .query<SessionRow, [string]>(
            "SELECT * FROM sessions WHERE session_id = ?"
          )
          .get(sessionId)!;
      }
      return existing;
    }

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

  getSessionById(sessionId: string): SessionRow | null {
    return (
      this.db
        .query<SessionRow, [string]>(
          "SELECT * FROM sessions WHERE session_id = ?"
        )
        .get(sessionId) ?? null
    );
  }

  getRecentSessions(
    projectId: number | null,
    limit: number = 10,
    userId?: string
  ): RecentSessionRow[] {
    const visibilityClause = userId ? " AND s.user_id = ?" : "";
    if (projectId !== null) {
      return this.db
        .query<RecentSessionRow, (number | string)[]>(
          `SELECT
             s.*,
             p.name AS project_name,
             ss.request AS request,
             ss.completed AS completed,
             ss.current_thread AS current_thread,
             ss.capture_state AS capture_state,
             ss.recent_tool_names AS recent_tool_names,
             ss.hot_files AS hot_files,
             ss.recent_outcomes AS recent_outcomes,
             (SELECT COUNT(*) FROM user_prompts up WHERE up.session_id = s.session_id) AS prompt_count,
             (SELECT COUNT(*) FROM tool_events te WHERE te.session_id = s.session_id) AS tool_event_count
           FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id
           LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
           WHERE s.project_id = ?${visibilityClause}
           ORDER BY COALESCE(s.completed_at_epoch, s.started_at_epoch, 0) DESC, s.id DESC
           LIMIT ?`
        )
        .all(projectId, ...(userId ? [userId] : []), limit);
    }

    return this.db
      .query<RecentSessionRow, (number | string)[]>(
        `SELECT
           s.*,
           p.name AS project_name,
           ss.request AS request,
           ss.completed AS completed,
           ss.current_thread AS current_thread,
           ss.capture_state AS capture_state,
           ss.recent_tool_names AS recent_tool_names,
           ss.hot_files AS hot_files,
           ss.recent_outcomes AS recent_outcomes,
           (SELECT COUNT(*) FROM user_prompts up WHERE up.session_id = s.session_id) AS prompt_count,
           (SELECT COUNT(*) FROM tool_events te WHERE te.session_id = s.session_id) AS tool_event_count
         FROM sessions s
         LEFT JOIN projects p ON p.id = s.project_id
         LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
         WHERE 1 = 1${visibilityClause}
         ORDER BY COALESCE(s.completed_at_epoch, s.started_at_epoch, 0) DESC, s.id DESC
         LIMIT ?`
      )
      .all(...(userId ? [userId] : []), limit);
  }

  // --- User prompts ---

  insertUserPrompt(input: InsertUserPrompt): UserPromptRow {
    const createdAt = input.created_at_epoch ?? Math.floor(Date.now() / 1000);
    const normalizedPrompt = input.prompt.trim();
    const promptHash = hashPrompt(normalizedPrompt);

    const latest = this.db
      .query<UserPromptRow, [string]>(
        `SELECT * FROM user_prompts
         WHERE session_id = ?
         ORDER BY prompt_number DESC
         LIMIT 1`
      )
      .get(input.session_id);

    if (latest && latest.prompt_hash === promptHash) {
      return latest;
    }

    const promptNumber = (latest?.prompt_number ?? 0) + 1;

    const result = this.db
      .query(
        `INSERT INTO user_prompts (
          session_id, project_id, prompt_number, prompt, prompt_hash, cwd,
          user_id, device_id, agent, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.session_id,
        input.project_id,
        promptNumber,
        normalizedPrompt,
        promptHash,
        input.cwd ?? null,
        input.user_id,
        input.device_id,
        input.agent ?? "claude-code",
        createdAt
      );

    return this.getUserPromptById(Number(result.lastInsertRowid))!;
  }

  getUserPromptById(id: number): UserPromptRow | null {
    return (
      this.db
        .query<UserPromptRow, [number]>(
          "SELECT * FROM user_prompts WHERE id = ?"
        )
        .get(id) ?? null
    );
  }

  getRecentUserPrompts(
    projectId: number | null,
    limit: number = 10,
    userId?: string
  ): UserPromptRow[] {
    const visibilityClause = userId ? " AND user_id = ?" : "";
    if (projectId !== null) {
      return this.db
        .query<UserPromptRow, (number | string)[]>(
          `SELECT * FROM user_prompts
           WHERE project_id = ?${visibilityClause}
           ORDER BY created_at_epoch DESC, prompt_number DESC
           LIMIT ?`
        )
        .all(projectId, ...(userId ? [userId] : []), limit);
    }

    return this.db
      .query<UserPromptRow, (number | string)[]>(
        `SELECT * FROM user_prompts
         WHERE 1 = 1${visibilityClause}
         ORDER BY created_at_epoch DESC, prompt_number DESC
         LIMIT ?`
      )
      .all(...(userId ? [userId] : []), limit);
  }

  getSessionUserPrompts(sessionId: string, limit: number = 20): UserPromptRow[] {
    return this.db
      .query<UserPromptRow, [string, number]>(
        `SELECT * FROM user_prompts
         WHERE session_id = ?
         ORDER BY prompt_number ASC
         LIMIT ?`
      )
      .all(sessionId, limit);
  }

  getLatestSessionPromptNumber(sessionId: string): number | null {
    const row = this.db
      .query<{ prompt_number: number }, [string]>(
        `SELECT prompt_number FROM user_prompts
         WHERE session_id = ?
         ORDER BY prompt_number DESC
         LIMIT 1`
      )
      .get(sessionId);
    return row?.prompt_number ?? null;
  }

  // --- Tool events ---

  insertToolEvent(input: InsertToolEvent): ToolEventRow {
    const createdAt = input.created_at_epoch ?? Math.floor(Date.now() / 1000);
    const result = this.db
      .query(
        `INSERT INTO tool_events (
          session_id, project_id, tool_name, tool_input_json, tool_response_preview,
          file_path, command, user_id, device_id, agent, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.session_id,
        input.project_id,
        input.tool_name,
        input.tool_input_json ?? null,
        input.tool_response_preview ?? null,
        input.file_path ?? null,
        input.command ?? null,
        input.user_id,
        input.device_id,
        input.agent ?? "claude-code",
        createdAt
      );

    return this.getToolEventById(Number(result.lastInsertRowid))!;
  }

  getToolEventById(id: number): ToolEventRow | null {
    return (
      this.db
        .query<ToolEventRow, [number]>(
          "SELECT * FROM tool_events WHERE id = ?"
        )
        .get(id) ?? null
    );
  }

  getSessionToolEvents(sessionId: string, limit: number = 20): ToolEventRow[] {
    return this.db
      .query<ToolEventRow, [string, number]>(
        `SELECT * FROM tool_events
         WHERE session_id = ?
         ORDER BY created_at_epoch ASC, id ASC
         LIMIT ?`
      )
      .all(sessionId, limit);
  }

  getRecentToolEvents(
    projectId: number | null,
    limit: number = 20,
    userId?: string
  ): ToolEventRow[] {
    const visibilityClause = userId ? " AND user_id = ?" : "";
    if (projectId !== null) {
      return this.db
        .query<ToolEventRow, (number | string)[]>(
          `SELECT * FROM tool_events
           WHERE project_id = ?${visibilityClause}
           ORDER BY created_at_epoch DESC, id DESC
           LIMIT ?`
        )
        .all(projectId, ...(userId ? [userId] : []), limit);
    }

    return this.db
      .query<ToolEventRow, (number | string)[]>(
        `SELECT * FROM tool_events
         WHERE 1 = 1${visibilityClause}
         ORDER BY created_at_epoch DESC, id DESC
         LIMIT ?`
      )
      .all(...(userId ? [userId] : []), limit);
  }

  // --- Chat messages ---

  insertChatMessage(input: InsertChatMessage): ChatMessageRow {
    const createdAt = input.created_at_epoch ?? Math.floor(Date.now() / 1000);
    const content = input.content.trim();
    const result = this.db
      .query(
        `INSERT INTO chat_messages (
          session_id, project_id, role, content, user_id, device_id, agent, created_at_epoch, remote_source_id, source_kind, transcript_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.session_id,
        input.project_id,
        input.role,
        content,
        input.user_id,
        input.device_id,
        input.agent ?? "claude-code",
        createdAt,
        input.remote_source_id ?? null,
        input.source_kind ?? "hook",
        input.transcript_index ?? null
      );

    return this.getChatMessageById(Number(result.lastInsertRowid))!;
  }

  getChatMessageById(id: number): ChatMessageRow | null {
    return (
      this.db
        .query<ChatMessageRow, [number]>(
          "SELECT * FROM chat_messages WHERE id = ?"
        )
        .get(id) ?? null
    );
  }

  getChatMessageByRemoteSourceId(remoteSourceId: string): ChatMessageRow | null {
    return (
      this.db
        .query<ChatMessageRow, [string]>(
          "SELECT * FROM chat_messages WHERE remote_source_id = ?"
        )
        .get(remoteSourceId) ?? null
    );
  }

  getChatMessagesByIds(ids: number[]): ChatMessageRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query<ChatMessageRow, number[]>(
        `SELECT * FROM chat_messages WHERE id IN (${placeholders})`
      )
      .all(...ids);
    const order = new Map(ids.map((id, index) => [id, index]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  getSessionChatMessages(sessionId: string, limit: number = 50): ChatMessageRow[] {
    return this.db
      .query<ChatMessageRow, [string, number]>(
        `SELECT * FROM chat_messages
         WHERE session_id = ?
           AND (
             source_kind = 'transcript'
             OR NOT EXISTS (
               SELECT 1 FROM chat_messages t2
               WHERE t2.session_id = chat_messages.session_id
                 AND t2.source_kind = 'transcript'
             )
           )
         ORDER BY
           CASE WHEN transcript_index IS NULL THEN created_at_epoch ELSE transcript_index END ASC,
           id ASC
         LIMIT ?`
      )
      .all(sessionId, limit);
  }

  getRecentChatMessages(
    projectId: number | null,
    limit: number = 20,
    userId?: string
  ): ChatMessageRow[] {
    const visibilityClause = userId ? " AND user_id = ?" : "";
    if (projectId !== null) {
      return this.db
        .query<ChatMessageRow, (number | string)[]>(
          `SELECT * FROM chat_messages
           WHERE project_id = ?${visibilityClause}
             AND (
               source_kind = 'transcript'
               OR NOT EXISTS (
                 SELECT 1 FROM chat_messages t2
                 WHERE t2.session_id = chat_messages.session_id
                   AND t2.source_kind = 'transcript'
               )
             )
           ORDER BY created_at_epoch DESC, id DESC
           LIMIT ?`
        )
        .all(projectId, ...(userId ? [userId] : []), limit);
    }

    return this.db
      .query<ChatMessageRow, (number | string)[]>(
        `SELECT * FROM chat_messages
         WHERE 1 = 1${visibilityClause}
           AND (
             source_kind = 'transcript'
             OR NOT EXISTS (
               SELECT 1 FROM chat_messages t2
               WHERE t2.session_id = chat_messages.session_id
                 AND t2.source_kind = 'transcript'
             )
           )
         ORDER BY created_at_epoch DESC, id DESC
         LIMIT ?`
      )
      .all(...(userId ? [userId] : []), limit);
  }

  searchChatMessages(
    query: string,
    projectId: number | null,
    limit: number = 20,
    userId?: string
  ): ChatMessageRow[] {
    const needle = `%${query.toLowerCase()}%`;
    const visibilityClause = userId ? " AND user_id = ?" : "";
    if (projectId !== null) {
      return this.db
        .query<ChatMessageRow, (number | string)[]>(
          `SELECT * FROM chat_messages
           WHERE project_id = ?
             AND lower(content) LIKE ?${visibilityClause}
             AND (
               source_kind = 'transcript'
               OR NOT EXISTS (
                 SELECT 1 FROM chat_messages t2
                 WHERE t2.session_id = chat_messages.session_id
                   AND t2.source_kind = 'transcript'
               )
             )
           ORDER BY created_at_epoch DESC, id DESC
           LIMIT ?`
        )
        .all(projectId, needle, ...(userId ? [userId] : []), limit);
    }

    return this.db
      .query<ChatMessageRow, (number | string)[]>(
        `SELECT * FROM chat_messages
         WHERE lower(content) LIKE ?${visibilityClause}
           AND (
             source_kind = 'transcript'
             OR NOT EXISTS (
               SELECT 1 FROM chat_messages t2
               WHERE t2.session_id = chat_messages.session_id
                 AND t2.source_kind = 'transcript'
             )
           )
         ORDER BY created_at_epoch DESC, id DESC
         LIMIT ?`
      )
      .all(needle, ...(userId ? [userId] : []), limit);
  }

  vecChatInsert(chatMessageId: number, embedding: Float32Array): void {
    if (!this.vecAvailable) return;
    const normalizedId = Number(chatMessageId);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return;
    try {
      this.db
        .query(
          "INSERT OR REPLACE INTO vec_chat_messages (chat_message_id, embedding) VALUES (?, ?)"
        )
        .run(normalizedId, new Uint8Array(embedding.buffer));
    } catch {
      // Keep chat recall usable even if sqlite-vec rejects one row on a given machine.
    }
  }

  searchChatVec(
    queryEmbedding: Float32Array,
    projectId: number | null,
    limit: number = 20,
    userId?: string
  ): VecChatMatchRow[] {
    if (!this.vecAvailable) return [];

    const embeddingBlob = new Uint8Array(queryEmbedding.buffer);
    const visibilityClause = userId ? " AND c.user_id = ?" : "";
    const transcriptPreference = `
      AND (
        c.source_kind = 'transcript'
        OR NOT EXISTS (
          SELECT 1 FROM chat_messages t2
          WHERE t2.session_id = c.session_id
            AND t2.source_kind = 'transcript'
        )
      )`;

    if (projectId !== null) {
      return this.db
        .query<VecChatMatchRow, any[]>(
          `SELECT v.chat_message_id, v.distance
           FROM vec_chat_messages v
           JOIN chat_messages c ON c.id = v.chat_message_id
           WHERE v.embedding MATCH ?
             AND k = ?
             AND c.project_id = ?`
             + visibilityClause
             + transcriptPreference
        )
        .all(embeddingBlob, limit, projectId, ...(userId ? [userId] : []));
    }

    return this.db
      .query<VecChatMatchRow, any[]>(
        `SELECT v.chat_message_id, v.distance
         FROM vec_chat_messages v
         JOIN chat_messages c ON c.id = v.chat_message_id
         WHERE v.embedding MATCH ?
           AND k = ?`
          + visibilityClause
          + transcriptPreference
      )
      .all(embeddingBlob, limit, ...(userId ? [userId] : []));
  }

  getTranscriptChatMessage(sessionId: string, transcriptIndex: number): ChatMessageRow | null {
    return (
      this.db
        .query<ChatMessageRow, [string, number]>(
          "SELECT * FROM chat_messages WHERE session_id = ? AND transcript_index = ?"
        )
        .get(sessionId, transcriptIndex) ?? null
    );
  }

  // --- Sync outbox ---

  addToOutbox(recordType: "observation" | "summary" | "chat_message", recordId: number): void {
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
    const normalized = {
      request: normalizeSummaryRequest(summary.request),
      investigated: normalizeSummarySection(summary.investigated),
      learned: normalizeSummarySection(summary.learned),
      completed: normalizeSummarySection(summary.completed),
      next_steps: normalizeSummarySection(summary.next_steps),
    };
    const result = this.db
      .query(
        `INSERT INTO session_summaries (
          session_id, project_id, user_id, request, investigated, learned, completed, next_steps,
          current_thread, capture_state, recent_tool_names, hot_files, recent_outcomes, created_at_epoch
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        summary.session_id,
        summary.project_id,
        summary.user_id,
        normalized.request,
        normalized.investigated,
        normalized.learned,
        normalized.completed,
        normalized.next_steps,
        summary.current_thread ?? null,
        summary.capture_state ?? null,
        summary.recent_tool_names ?? null,
        summary.hot_files ?? null,
        summary.recent_outcomes ?? null,
        now
      );

    const id = Number(result.lastInsertRowid);
    return this.db
      .query<SessionSummaryRow, [number]>(
        "SELECT * FROM session_summaries WHERE id = ?"
      )
      .get(id)!;
  }

  upsertSessionSummary(summary: InsertSessionSummary): SessionSummaryRow {
    const existing = this.getSessionSummary(summary.session_id);
    if (!existing) {
      return this.insertSessionSummary(summary);
    }

    const now = Math.floor(Date.now() / 1000);
    const normalized = {
      request: normalizeSummaryRequest(summary.request ?? existing.request),
      investigated: normalizeSummarySection(summary.investigated ?? existing.investigated),
      learned: normalizeSummarySection(summary.learned ?? existing.learned),
      completed: normalizeSummarySection(summary.completed ?? existing.completed),
      next_steps: normalizeSummarySection(summary.next_steps ?? existing.next_steps),
      current_thread: summary.current_thread ?? existing.current_thread,
      capture_state: summary.capture_state ?? existing.capture_state,
      recent_tool_names: summary.recent_tool_names ?? existing.recent_tool_names,
      hot_files: summary.hot_files ?? existing.hot_files,
      recent_outcomes: summary.recent_outcomes ?? existing.recent_outcomes,
    };

    this.db
      .query(
        `UPDATE session_summaries
         SET project_id = ?,
             user_id = ?,
             request = ?,
             investigated = ?,
             learned = ?,
             completed = ?,
             next_steps = ?,
             current_thread = ?,
             capture_state = ?,
             recent_tool_names = ?,
             hot_files = ?,
             recent_outcomes = ?,
             created_at_epoch = ?
         WHERE session_id = ?`
      )
      .run(
        summary.project_id ?? existing.project_id,
        summary.user_id,
        normalized.request,
        normalized.investigated,
        normalized.learned,
        normalized.completed,
        normalized.next_steps,
        normalized.current_thread,
        normalized.capture_state,
        normalized.recent_tool_names,
        normalized.hot_files,
        normalized.recent_outcomes,
        now,
        summary.session_id
      );

    return this.getSessionSummary(summary.session_id)!;
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

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
