import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import { runPurgeJob } from "./purge.js";

let db: MemDatabase;
let tmpDir: string;
let projectId: number;

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

function insertObs(
  overrides: Partial<{
    lifecycle: string;
    archived_at_epoch: number | null;
    title: string;
  }> = {}
) {
  db.db
    .query(
      `INSERT INTO observations (project_id, type, title, quality, lifecycle, sensitivity, user_id, device_id, agent, created_at, created_at_epoch, archived_at_epoch)
       VALUES (?, 'discovery', ?, 0.5, ?, 'shared', 'user1', 'dev1', 'claude-code', datetime('now'), ?, ?)`
    )
    .run(
      projectId,
      overrides.title ?? "Test observation",
      overrides.lifecycle ?? "archived",
      NOW - 400 * DAY,
      overrides.archived_at_epoch ?? null
    );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "candengo-purge-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  const project = db.upsertProject({
    canonical_id: "github.com/test/repo",
    name: "repo",
  });
  projectId = project.id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runPurgeJob", () => {
  test("deletes archived observations older than 12 months", () => {
    insertObs({ archived_at_epoch: NOW - 400 * DAY });
    const result = runPurgeJob(db, NOW);
    expect(result.deleted).toBe(1);
    expect(db.getObservationById(1)).toBeNull();
  });

  test("does not delete archived observations newer than 12 months", () => {
    insertObs({ archived_at_epoch: NOW - 300 * DAY });
    const result = runPurgeJob(db, NOW);
    expect(result.deleted).toBe(0);
    expect(db.getObservationById(1)).not.toBeNull();
  });

  test("does not delete pinned observations regardless of age", () => {
    insertObs({
      lifecycle: "pinned",
      archived_at_epoch: NOW - 400 * DAY,
    });
    const result = runPurgeJob(db, NOW);
    expect(result.deleted).toBe(0);
  });

  test("does not delete active or aging observations", () => {
    insertObs({ lifecycle: "active", archived_at_epoch: null });
    insertObs({ lifecycle: "aging", archived_at_epoch: null, title: "Aging obs" });
    const result = runPurgeJob(db, NOW);
    expect(result.deleted).toBe(0);
  });

  test("does not delete archived observations without archived_at_epoch", () => {
    insertObs({ archived_at_epoch: null });
    const result = runPurgeJob(db, NOW);
    expect(result.deleted).toBe(0);
  });

  test("returns accurate count", () => {
    insertObs({ archived_at_epoch: NOW - 400 * DAY, title: "Old 1" });
    insertObs({ archived_at_epoch: NOW - 500 * DAY, title: "Old 2" });
    insertObs({ archived_at_epoch: NOW - 100 * DAY, title: "Recent" });
    const result = runPurgeJob(db, NOW);
    expect(result.deleted).toBe(2);
  });

  test("handles empty database", () => {
    const result = runPurgeJob(db, NOW);
    expect(result.deleted).toBe(0);
  });
});
