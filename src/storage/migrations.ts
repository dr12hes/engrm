import type { CompatDatabase } from "./sqlite.js";

/**
 * Schema version tracking and migrations for engrm.
 *
 * All schema changes go through numbered migrations. The current version
 * is stored in the `schema_version` pragma. Migrations run sequentially
 * on startup if the DB is behind.
 */

interface Migration {
  version: number;
  description: string;
  sql: string;
  /** If provided, migration is skipped when this returns false. */
  condition?: (db: CompatDatabase) => boolean;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema: projects, observations, sessions, sync, FTS5",
    sql: `
      -- Projects (canonical identity across machines)
      CREATE TABLE projects (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_id    TEXT UNIQUE NOT NULL,
          name            TEXT NOT NULL,
          local_path      TEXT,
          remote_url      TEXT,
          first_seen_epoch INTEGER NOT NULL,
          last_active_epoch INTEGER NOT NULL
      );

      -- Core observations table
      CREATE TABLE observations (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT,
          project_id      INTEGER NOT NULL REFERENCES projects(id),
          type            TEXT NOT NULL CHECK (type IN (
              'bugfix', 'discovery', 'decision', 'pattern',
              'change', 'feature', 'refactor', 'digest'
          )),
          title           TEXT NOT NULL,
          narrative       TEXT,
          facts           TEXT,
          concepts        TEXT,
          files_read      TEXT,
          files_modified  TEXT,
          quality         REAL DEFAULT 0.5 CHECK (quality BETWEEN 0.0 AND 1.0),
          lifecycle       TEXT DEFAULT 'active' CHECK (lifecycle IN (
              'active', 'aging', 'archived', 'purged', 'pinned'
          )),
          sensitivity     TEXT DEFAULT 'shared' CHECK (sensitivity IN (
              'shared', 'personal', 'secret'
          )),
          user_id         TEXT NOT NULL,
          device_id       TEXT NOT NULL,
          agent           TEXT DEFAULT 'claude-code',
          created_at      TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          archived_at_epoch INTEGER,
          compacted_into  INTEGER REFERENCES observations(id) ON DELETE SET NULL
      );

      -- Session tracking
      CREATE TABLE sessions (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT UNIQUE NOT NULL,
          project_id      INTEGER REFERENCES projects(id),
          user_id         TEXT NOT NULL,
          device_id       TEXT NOT NULL,
          agent           TEXT DEFAULT 'claude-code',
          status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed')),
          observation_count INTEGER DEFAULT 0,
          started_at_epoch INTEGER,
          completed_at_epoch INTEGER
      );

      -- Session summaries (generated on Stop hook)
      CREATE TABLE session_summaries (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT UNIQUE NOT NULL,
          project_id      INTEGER REFERENCES projects(id),
          user_id         TEXT NOT NULL,
          request         TEXT,
          investigated    TEXT,
          learned         TEXT,
          completed       TEXT,
          next_steps      TEXT,
          created_at_epoch INTEGER
      );

      -- Sync outbox (offline-first queue)
      CREATE TABLE sync_outbox (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          record_type     TEXT NOT NULL CHECK (record_type IN ('observation', 'summary')),
          record_id       INTEGER NOT NULL,
          status          TEXT DEFAULT 'pending' CHECK (status IN (
              'pending', 'syncing', 'synced', 'failed'
          )),
          retry_count     INTEGER DEFAULT 0,
          max_retries     INTEGER DEFAULT 10,
          last_error      TEXT,
          created_at_epoch INTEGER NOT NULL,
          synced_at_epoch  INTEGER,
          next_retry_epoch INTEGER
      );

      -- Sync high-water mark and lifecycle job tracking
      CREATE TABLE sync_state (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
      );

      -- FTS5 for local offline search (external content mode)
      CREATE VIRTUAL TABLE observations_fts USING fts5(
          title, narrative, facts, concepts,
          content=observations,
          content_rowid=id
      );

      -- Indexes: observations
      CREATE INDEX idx_observations_project ON observations(project_id);
      CREATE INDEX idx_observations_project_lifecycle ON observations(project_id, lifecycle);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch);
      CREATE INDEX idx_observations_session ON observations(session_id);
      CREATE INDEX idx_observations_lifecycle ON observations(lifecycle);
      CREATE INDEX idx_observations_quality ON observations(quality);
      CREATE INDEX idx_observations_user ON observations(user_id);

      -- Indexes: sessions
      CREATE INDEX idx_sessions_project ON sessions(project_id);

      -- Indexes: sync outbox
      CREATE INDEX idx_outbox_status ON sync_outbox(status, next_retry_epoch);
      CREATE INDEX idx_outbox_record ON sync_outbox(record_type, record_id);
    `,
  },
  {
    version: 2,
    description: "Add superseded_by for knowledge supersession",
    sql: `
      ALTER TABLE observations ADD COLUMN superseded_by INTEGER REFERENCES observations(id) ON DELETE SET NULL;
      CREATE INDEX idx_observations_superseded ON observations(superseded_by);
    `,
  },
  {
    version: 3,
    description: "Add remote_source_id for pull deduplication",
    sql: `
      ALTER TABLE observations ADD COLUMN remote_source_id TEXT;
      CREATE UNIQUE INDEX idx_observations_remote_source ON observations(remote_source_id) WHERE remote_source_id IS NOT NULL;
    `,
  },
  {
    version: 4,
    description: "Add sqlite-vec for local semantic search",
    sql: `
      CREATE VIRTUAL TABLE vec_observations USING vec0(
        observation_id INTEGER PRIMARY KEY,
        embedding float[384]
      );
    `,
    condition: (db) => isVecExtensionLoaded(db),
  },
  {
    version: 5,
    description: "Session metrics and security findings",
    sql: `
      ALTER TABLE sessions ADD COLUMN files_touched_count INTEGER DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN searches_performed INTEGER DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN tool_calls_count INTEGER DEFAULT 0;

      CREATE TABLE security_findings (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT,
          project_id      INTEGER NOT NULL REFERENCES projects(id),
          finding_type    TEXT NOT NULL,
          severity        TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical', 'high', 'medium', 'low')),
          pattern_name    TEXT NOT NULL,
          file_path       TEXT,
          snippet         TEXT,
          tool_name       TEXT,
          user_id         TEXT NOT NULL,
          device_id       TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL
      );

      CREATE INDEX idx_security_findings_session ON security_findings(session_id);
      CREATE INDEX idx_security_findings_project ON security_findings(project_id, created_at_epoch);
      CREATE INDEX idx_security_findings_severity ON security_findings(severity);
    `,
  },
  {
    version: 6,
    description: "Add risk_score, expand observation types to include standard",
    sql: `
      ALTER TABLE sessions ADD COLUMN risk_score INTEGER;

      -- Recreate observations table with expanded type CHECK to include 'standard'
      -- SQLite doesn't support ALTER CHECK, so we recreate the table
      CREATE TABLE observations_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT,
          project_id      INTEGER NOT NULL REFERENCES projects(id),
          type            TEXT NOT NULL CHECK (type IN (
              'bugfix', 'discovery', 'decision', 'pattern',
              'change', 'feature', 'refactor', 'digest', 'standard'
          )),
          title           TEXT NOT NULL,
          narrative       TEXT,
          facts           TEXT,
          concepts        TEXT,
          files_read      TEXT,
          files_modified  TEXT,
          quality         REAL DEFAULT 0.5 CHECK (quality BETWEEN 0.0 AND 1.0),
          lifecycle       TEXT DEFAULT 'active' CHECK (lifecycle IN (
              'active', 'aging', 'archived', 'purged', 'pinned'
          )),
          sensitivity     TEXT DEFAULT 'shared' CHECK (sensitivity IN (
              'shared', 'personal', 'secret'
          )),
          user_id         TEXT NOT NULL,
          device_id       TEXT NOT NULL,
          agent           TEXT DEFAULT 'claude-code',
          created_at      TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          archived_at_epoch INTEGER,
          compacted_into  INTEGER REFERENCES observations(id) ON DELETE SET NULL,
          superseded_by   INTEGER REFERENCES observations(id) ON DELETE SET NULL,
          remote_source_id TEXT
      );

      INSERT INTO observations_new SELECT * FROM observations;

      DROP TABLE observations;
      ALTER TABLE observations_new RENAME TO observations;

      -- Recreate indexes
      CREATE INDEX idx_observations_project ON observations(project_id);
      CREATE INDEX idx_observations_project_lifecycle ON observations(project_id, lifecycle);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch);
      CREATE INDEX idx_observations_session ON observations(session_id);
      CREATE INDEX idx_observations_lifecycle ON observations(lifecycle);
      CREATE INDEX idx_observations_quality ON observations(quality);
      CREATE INDEX idx_observations_user ON observations(user_id);
      CREATE INDEX idx_observations_superseded ON observations(superseded_by);
      CREATE UNIQUE INDEX idx_observations_remote_source ON observations(remote_source_id) WHERE remote_source_id IS NOT NULL;

      -- Recreate FTS5 (external content mode — must rebuild after table recreation)
      DROP TABLE IF EXISTS observations_fts;
      CREATE VIRTUAL TABLE observations_fts USING fts5(
          title, narrative, facts, concepts,
          content=observations,
          content_rowid=id
      );
      -- Rebuild FTS index
      INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
    `,
  },
  {
    version: 7,
    description: "Add packs_installed table for help pack tracking",
    sql: `
      CREATE TABLE IF NOT EXISTS packs_installed (
          name            TEXT PRIMARY KEY,
          installed_at    INTEGER NOT NULL,
          observation_count INTEGER DEFAULT 0
      );
    `,
  },
  {
    version: 8,
    description: "Add message type to observations CHECK constraint",
    sql: `
      CREATE TABLE IF NOT EXISTS observations_v8 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT,
          project_id      INTEGER NOT NULL REFERENCES projects(id),
          type            TEXT NOT NULL CHECK (type IN (
              'bugfix', 'discovery', 'decision', 'pattern',
              'change', 'feature', 'refactor', 'digest', 'standard', 'message'
          )),
          title           TEXT NOT NULL,
          narrative       TEXT,
          facts           TEXT,
          concepts        TEXT,
          files_read      TEXT,
          files_modified  TEXT,
          quality         REAL DEFAULT 0.5 CHECK (quality BETWEEN 0.0 AND 1.0),
          lifecycle       TEXT DEFAULT 'active' CHECK (lifecycle IN (
              'active', 'aging', 'archived', 'purged', 'pinned'
          )),
          sensitivity     TEXT DEFAULT 'shared' CHECK (sensitivity IN (
              'shared', 'personal', 'secret'
          )),
          user_id         TEXT NOT NULL,
          device_id       TEXT NOT NULL,
          agent           TEXT DEFAULT 'claude-code',
          created_at      TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          archived_at_epoch INTEGER,
          compacted_into  INTEGER REFERENCES observations(id) ON DELETE SET NULL,
          superseded_by   INTEGER REFERENCES observations(id) ON DELETE SET NULL,
          remote_source_id TEXT
      );
      INSERT INTO observations_v8 SELECT * FROM observations;
      DROP TABLE observations;
      ALTER TABLE observations_v8 RENAME TO observations;
      CREATE INDEX idx_observations_project ON observations(project_id);
      CREATE INDEX idx_observations_project_lifecycle ON observations(project_id, lifecycle);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch);
      CREATE INDEX idx_observations_session ON observations(session_id);
      CREATE INDEX idx_observations_lifecycle ON observations(lifecycle);
      CREATE INDEX idx_observations_quality ON observations(quality);
      CREATE INDEX idx_observations_user ON observations(user_id);
      CREATE INDEX idx_observations_superseded ON observations(superseded_by);
      CREATE UNIQUE INDEX idx_observations_remote_source ON observations(remote_source_id) WHERE remote_source_id IS NOT NULL;
      DROP TABLE IF EXISTS observations_fts;
      CREATE VIRTUAL TABLE observations_fts USING fts5(
          title, narrative, facts, concepts,
          content=observations,
          content_rowid=id
      );
      INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
    `,
  },
  {
    version: 9,
    description: "Add first-class user prompt capture",
    sql: `
      CREATE TABLE IF NOT EXISTS user_prompts (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id        TEXT NOT NULL,
          project_id        INTEGER REFERENCES projects(id),
          prompt_number     INTEGER NOT NULL,
          prompt            TEXT NOT NULL,
          prompt_hash       TEXT NOT NULL,
          cwd               TEXT,
          user_id           TEXT NOT NULL,
          device_id         TEXT NOT NULL,
          agent             TEXT DEFAULT 'claude-code',
          created_at_epoch  INTEGER NOT NULL,
          UNIQUE(session_id, prompt_number)
      );

      CREATE INDEX IF NOT EXISTS idx_user_prompts_session
        ON user_prompts(session_id, prompt_number DESC);
      CREATE INDEX IF NOT EXISTS idx_user_prompts_project
        ON user_prompts(project_id, created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_user_prompts_created
        ON user_prompts(created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_user_prompts_hash
        ON user_prompts(prompt_hash);
    `,
  },
  {
    version: 10,
    description: "Add first-class tool event chronology",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_events (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id          TEXT NOT NULL,
          project_id          INTEGER REFERENCES projects(id),
          tool_name           TEXT NOT NULL,
          tool_input_json     TEXT,
          tool_response_preview TEXT,
          file_path           TEXT,
          command             TEXT,
          user_id             TEXT NOT NULL,
          device_id           TEXT NOT NULL,
          agent               TEXT DEFAULT 'claude-code',
          created_at_epoch    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tool_events_session
        ON tool_events(session_id, created_at_epoch DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_events_project
        ON tool_events(project_id, created_at_epoch DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_events_tool_name
        ON tool_events(tool_name, created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_events_created
        ON tool_events(created_at_epoch DESC, id DESC);
    `,
  },
];

/**
 * Check if the sqlite-vec extension is loaded in this database.
 */
function isVecExtensionLoaded(db: CompatDatabase): boolean {
  try {
    db.exec("SELECT vec_version()");
    return true;
  } catch {
    return false;
  }
}

function tableExists(db: CompatDatabase, name: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`
    )
    .get(name);
  return Boolean(row?.name);
}

function columnExists(db: CompatDatabase, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const rows = db.query<{ name: string }>(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureLegacyBaseTables(db: CompatDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function inferLegacySchemaVersion(db: CompatDatabase): number {
  const hasProjects = tableExists(db, "projects");
  const hasObservations = tableExists(db, "observations");
  const hasSessions = tableExists(db, "sessions");
  if (!(hasProjects && hasObservations && hasSessions)) return 0;

  ensureLegacyBaseTables(db);

  let version = 1;

  if (columnExists(db, "observations", "superseded_by")) version = Math.max(version, 2);
  if (columnExists(db, "observations", "remote_source_id")) version = Math.max(version, 3);
  if (tableExists(db, "vec_observations")) version = Math.max(version, 4);

  const hasSessionMetrics =
    columnExists(db, "sessions", "files_touched_count") &&
    columnExists(db, "sessions", "searches_performed") &&
    columnExists(db, "sessions", "tool_calls_count");
  if (hasSessionMetrics || tableExists(db, "security_findings")) version = Math.max(version, 5);

  if (columnExists(db, "sessions", "risk_score")) version = Math.max(version, 6);
  if (tableExists(db, "packs_installed")) version = Math.max(version, 7);
  if (tableExists(db, "user_prompts")) version = Math.max(version, 9);
  if (tableExists(db, "tool_events")) version = Math.max(version, 10);

  return version;
}

/**
 * Run all pending migrations on the given database.
 * Uses SQLite's user_version pragma to track schema version.
 */
export function runMigrations(db: CompatDatabase): void {
  const currentVersion = db.query<{ user_version: number }>("PRAGMA user_version").get() as {
    user_version: number;
  };
  let version = currentVersion.user_version;

  const inferred = inferLegacySchemaVersion(db);
  if (inferred > version) {
    db.exec(`PRAGMA user_version = ${inferred}`);
    version = inferred;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;

    // Skip conditional migrations when condition is not met
    if (migration.condition && !migration.condition(db)) {
      continue;
    }

    db.exec("BEGIN TRANSACTION");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.description}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

/**
 * Verify the observations table supports all required types.
 * Fixes the CHECK constraint if it's missing newer types (message, standard).
 * This handles cases where user_version was bumped but the table wasn't recreated.
 */
export function ensureObservationTypes(db: CompatDatabase): void {
  try {
    // Test if 'message' type is allowed
    db.exec(
      "INSERT INTO observations (session_id, project_id, type, title, user_id, device_id, agent, created_at, created_at_epoch) " +
      "VALUES ('_typecheck', 1, 'message', '_test', '_test', '_test', '_test', '2000-01-01', 0)"
    );
    // Clean up test row
    db.exec("DELETE FROM observations WHERE session_id = '_typecheck'");
  } catch {
    // CHECK constraint failed — recreate table with all types
    db.exec("BEGIN TRANSACTION");
    try {
      db.exec(`
        CREATE TABLE observations_repair (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          type TEXT NOT NULL CHECK (type IN (
            'bugfix','discovery','decision','pattern','change','feature',
            'refactor','digest','standard','message')),
          title TEXT NOT NULL, narrative TEXT, facts TEXT, concepts TEXT,
          files_read TEXT, files_modified TEXT,
          quality REAL DEFAULT 0.5 CHECK (quality BETWEEN 0.0 AND 1.0),
          lifecycle TEXT DEFAULT 'active' CHECK (lifecycle IN ('active','aging','archived','purged','pinned')),
          sensitivity TEXT DEFAULT 'shared' CHECK (sensitivity IN ('shared','personal','secret')),
          user_id TEXT NOT NULL, device_id TEXT NOT NULL, agent TEXT DEFAULT 'claude-code',
          created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
          archived_at_epoch INTEGER,
          compacted_into INTEGER REFERENCES observations(id) ON DELETE SET NULL,
          superseded_by INTEGER REFERENCES observations(id) ON DELETE SET NULL,
          remote_source_id TEXT
        );
        INSERT INTO observations_repair SELECT * FROM observations;
        DROP TABLE observations;
        ALTER TABLE observations_repair RENAME TO observations;
        CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project_id);
        CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
        CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch);
        CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
        CREATE INDEX IF NOT EXISTS idx_observations_lifecycle ON observations(lifecycle);
        CREATE INDEX IF NOT EXISTS idx_observations_quality ON observations(quality);
        CREATE INDEX IF NOT EXISTS idx_observations_user ON observations(user_id);
        CREATE INDEX IF NOT EXISTS idx_observations_superseded ON observations(superseded_by);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_remote_source ON observations(remote_source_id) WHERE remote_source_id IS NOT NULL;
        DROP TABLE IF EXISTS observations_fts;
        CREATE VIRTUAL TABLE observations_fts USING fts5(
          title, narrative, facts, concepts, content=observations, content_rowid=id
        );
        INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
      `);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      // Non-fatal — message type just won't work
    }
  }
}

/**
 * Get the current schema version.
 */
export function getSchemaVersion(db: CompatDatabase): number {
  const result = db.query<{ user_version: number }>("PRAGMA user_version").get() as {
    user_version: number;
  };
  return result.user_version;
}

/**
 * Expected schema version after all unconditional migrations have run.
 * Conditional migrations (e.g., sqlite-vec) may bump this higher at runtime.
 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS
  .filter((m) => !m.condition)
  .reduce((max, m) => Math.max(max, m.version), 0);
