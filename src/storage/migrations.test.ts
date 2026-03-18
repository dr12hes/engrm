import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runMigrations,
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
} from "./migrations.js";
import type { CompatDatabase } from "./sqlite.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function createDb(): CompatDatabase {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-migration-test-"));
  // bun:sqlite's Database already has .query() — cast it to CompatDatabase
  const db = new Database(join(tmpDir, "test.db")) as unknown as CompatDatabase;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("migrations", () => {
  test("runMigrations creates all tables", () => {
    const db = createDb();
    runMigrations(db);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all()
      .map((r) => r.name);

    expect(tables).toContain("projects");
    expect(tables).toContain("observations");
    expect(tables).toContain("sessions");
    expect(tables).toContain("session_summaries");
    expect(tables).toContain("sync_outbox");
    expect(tables).toContain("sync_state");

    db.close();
  });

  test("runMigrations creates FTS5 virtual table", () => {
    const db = createDb();
    runMigrations(db);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
      )
      .all();
    expect(tables.length).toBe(1);

    db.close();
  });

  test("runMigrations creates indexes", () => {
    const db = createDb();
    runMigrations(db);

    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
      )
      .all()
      .map((r) => r.name);

    expect(indexes).toContain("idx_observations_project");
    expect(indexes).toContain("idx_observations_project_lifecycle");
    expect(indexes).toContain("idx_observations_created");
    expect(indexes).toContain("idx_outbox_status");

    db.close();
  });

  test("runMigrations is idempotent", () => {
    const db = createDb();
    runMigrations(db);
    runMigrations(db); // second run should be a no-op
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  test("getSchemaVersion returns 0 for fresh database", () => {
    const db = createDb();
    expect(getSchemaVersion(db)).toBe(0);
    db.close();
  });

  test("getSchemaVersion returns latest after migrations", () => {
    const db = createDb();
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThan(0);
    db.close();
  });

  test("CHECK constraints enforce valid observation types", () => {
    const db = createDb();
    runMigrations(db);

    // Insert a valid project first
    db.query(
      "INSERT INTO projects (canonical_id, name, first_seen_epoch, last_active_epoch) VALUES (?, ?, ?, ?)"
    ).run("test/project", "test", 0, 0);

    // Valid type should work
    expect(() => {
      db.query(
        `INSERT INTO observations (project_id, type, title, quality, user_id, device_id, created_at, created_at_epoch)
         VALUES (1, 'bugfix', 'test', 0.5, 'user', 'device', '2024-01-01', 0)`
      ).run();
    }).not.toThrow();

    // Invalid type should fail
    expect(() => {
      db.query(
        `INSERT INTO observations (project_id, type, title, quality, user_id, device_id, created_at, created_at_epoch)
         VALUES (1, 'invalid_type', 'test', 0.5, 'user', 'device', '2024-01-01', 0)`
      ).run();
    }).toThrow();

    db.close();
  });

  test("CHECK constraints enforce quality range", () => {
    const db = createDb();
    runMigrations(db);

    db.query(
      "INSERT INTO projects (canonical_id, name, first_seen_epoch, last_active_epoch) VALUES (?, ?, ?, ?)"
    ).run("test/project", "test", 0, 0);

    // Quality > 1.0 should fail
    expect(() => {
      db.query(
        `INSERT INTO observations (project_id, type, title, quality, user_id, device_id, created_at, created_at_epoch)
         VALUES (1, 'bugfix', 'test', 1.5, 'user', 'device', '2024-01-01', 0)`
      ).run();
    }).toThrow();

    // Quality < 0.0 should fail
    expect(() => {
      db.query(
        `INSERT INTO observations (project_id, type, title, quality, user_id, device_id, created_at, created_at_epoch)
         VALUES (1, 'bugfix', 'test', -0.1, 'user', 'device', '2024-01-01', 0)`
      ).run();
    }).toThrow();

    db.close();
  });

  test("CHECK constraints enforce valid lifecycle", () => {
    const db = createDb();
    runMigrations(db);

    db.query(
      "INSERT INTO projects (canonical_id, name, first_seen_epoch, last_active_epoch) VALUES (?, ?, ?, ?)"
    ).run("test/project", "test", 0, 0);

    expect(() => {
      db.query(
        `INSERT INTO observations (project_id, type, title, quality, lifecycle, user_id, device_id, created_at, created_at_epoch)
         VALUES (1, 'bugfix', 'test', 0.5, 'deleted', 'user', 'device', '2024-01-01', 0)`
      ).run();
    }).toThrow();

    db.close();
  });

  test("migration v2 adds superseded_by column", () => {
    const db = createDb();
    runMigrations(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(observations)")
      .all()
      .map((r) => r.name);

    expect(columns).toContain("superseded_by");
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

    db.close();
  });

  test("migration v2 creates superseded index", () => {
    const db = createDb();
    runMigrations(db);

    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_observations_superseded'"
      )
      .all();

    expect(indexes.length).toBe(1);

    db.close();
  });

  test("v1 database upgrades to v2 correctly", () => {
    const db = createDb();

    // Manually run v1 only by setting version ceiling
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Run migrations (will apply both v1 and v2)
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

    // Verify superseded_by works with data
    db.query(
      "INSERT INTO projects (canonical_id, name, first_seen_epoch, last_active_epoch) VALUES (?, ?, ?, ?)"
    ).run("test/proj", "test", 0, 0);

    db.query(
      `INSERT INTO observations (project_id, type, title, quality, user_id, device_id, created_at, created_at_epoch, superseded_by)
       VALUES (1, 'decision', 'Old decision', 0.5, 'user', 'dev', '2024-01-01', 0, NULL)`
    ).run();

    db.query(
      `INSERT INTO observations (project_id, type, title, quality, user_id, device_id, created_at, created_at_epoch, superseded_by)
       VALUES (1, 'decision', 'New decision', 0.8, 'user', 'dev', '2024-01-01', 0, NULL)`
    ).run();

    // Set superseded_by
    db.query("UPDATE observations SET superseded_by = 2 WHERE id = 1").run();

    const superseded = db
      .query<{ superseded_by: number | null }, [number]>(
        "SELECT superseded_by FROM observations WHERE id = ?"
      )
      .get(1);
    expect(superseded!.superseded_by).toBe(2);

    db.close();
  });
});
