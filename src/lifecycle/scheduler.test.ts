import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import { runDueJobs } from "./scheduler.js";

let db: MemDatabase;
let tmpDir: string;
let projectId: number;

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

function insertObs(
  overrides: Partial<{
    lifecycle: string;
    created_at_epoch: number;
    title: string;
  }> = {}
) {
  db.db
    .query(
      `INSERT INTO observations (project_id, type, title, quality, lifecycle, sensitivity, user_id, device_id, agent, created_at, created_at_epoch)
       VALUES (?, 'discovery', ?, 0.5, ?, 'shared', 'user1', 'dev1', 'claude-code', datetime('now'), ?)`
    )
    .run(
      projectId,
      overrides.title ?? "Test observation",
      overrides.lifecycle ?? "active",
      overrides.created_at_epoch ?? NOW - 60 * DAY
    );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "candengo-scheduler-test-"));
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

describe("runDueJobs", () => {
  test("runs aging when never run before", () => {
    insertObs({ created_at_epoch: NOW - 31 * DAY });
    const result = runDueJobs(db, NOW);
    expect(result.agingRan).toBe(true);
    expect(result.aging!.transitioned).toBe(1);
  });

  test("runs aging when last run > 24h ago", () => {
    db.setSyncState("lifecycle_aging_last_run", String(NOW - 25 * 3600));
    insertObs({ created_at_epoch: NOW - 31 * DAY });
    const result = runDueJobs(db, NOW);
    expect(result.agingRan).toBe(true);
  });

  test("skips aging when last run < 24h ago", () => {
    db.setSyncState("lifecycle_aging_last_run", String(NOW - 23 * 3600));
    const result = runDueJobs(db, NOW);
    expect(result.agingRan).toBe(false);
  });

  test("runs compaction when never run before", () => {
    const result = runDueJobs(db, NOW);
    expect(result.compactionRan).toBe(true);
  });

  test("runs compaction when last run > 7 days ago", () => {
    db.setSyncState(
      "lifecycle_compaction_last_run",
      String(NOW - 8 * DAY)
    );
    const result = runDueJobs(db, NOW);
    expect(result.compactionRan).toBe(true);
  });

  test("skips compaction when last run < 7 days ago", () => {
    db.setSyncState(
      "lifecycle_compaction_last_run",
      String(NOW - 6 * DAY)
    );
    const result = runDueJobs(db, NOW);
    expect(result.compactionRan).toBe(false);
  });

  test("runs purge when last run > 30 days ago", () => {
    db.setSyncState("lifecycle_purge_last_run", String(NOW - 31 * DAY));
    const result = runDueJobs(db, NOW);
    expect(result.purgeRan).toBe(true);
  });

  test("skips purge when last run < 30 days ago", () => {
    db.setSyncState("lifecycle_purge_last_run", String(NOW - 29 * DAY));
    const result = runDueJobs(db, NOW);
    expect(result.purgeRan).toBe(false);
  });

  test("updates sync_state timestamps after each job", () => {
    runDueJobs(db, NOW);
    expect(db.getSyncState("lifecycle_aging_last_run")).toBe(String(NOW));
    expect(db.getSyncState("lifecycle_compaction_last_run")).toBe(String(NOW));
    expect(db.getSyncState("lifecycle_purge_last_run")).toBe(String(NOW));
  });

  test("all jobs run independently", () => {
    // All should run on first invocation (never run before)
    const result = runDueJobs(db, NOW);
    expect(result.agingRan).toBe(true);
    expect(result.compactionRan).toBe(true);
    expect(result.purgeRan).toBe(true);
  });
});
