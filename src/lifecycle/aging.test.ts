import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import { runAgingJob } from "./aging.js";

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
  const epoch = overrides.created_at_epoch ?? NOW;
  db.db
    .query(
      `INSERT INTO observations (project_id, type, title, quality, lifecycle, sensitivity, user_id, device_id, agent, created_at, created_at_epoch)
       VALUES (?, 'discovery', ?, 0.5, ?, 'shared', 'user1', 'dev1', 'claude-code', datetime('now'), ?)`
    )
    .run(
      projectId,
      overrides.title ?? "Test observation",
      overrides.lifecycle ?? "active",
      epoch
    );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "candengo-aging-test-"));
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

describe("runAgingJob", () => {
  test("transitions active observations older than 30 days to aging", () => {
    insertObs({ created_at_epoch: NOW - 31 * DAY });
    const result = runAgingJob(db, NOW);
    expect(result.transitioned).toBe(1);

    const obs = db.getObservationById(1);
    expect(obs!.lifecycle).toBe("aging");
  });

  test("does not transition observations newer than 30 days", () => {
    insertObs({ created_at_epoch: NOW - 29 * DAY });
    const result = runAgingJob(db, NOW);
    expect(result.transitioned).toBe(0);

    const obs = db.getObservationById(1);
    expect(obs!.lifecycle).toBe("active");
  });

  test("does not affect pinned observations", () => {
    insertObs({ lifecycle: "pinned", created_at_epoch: NOW - 60 * DAY });
    const result = runAgingJob(db, NOW);
    expect(result.transitioned).toBe(0);

    const obs = db.getObservationById(1);
    expect(obs!.lifecycle).toBe("pinned");
  });

  test("does not re-process already aging observations", () => {
    insertObs({ lifecycle: "aging", created_at_epoch: NOW - 60 * DAY });
    const result = runAgingJob(db, NOW);
    expect(result.transitioned).toBe(0);
  });

  test("does not affect archived observations", () => {
    insertObs({ lifecycle: "archived", created_at_epoch: NOW - 60 * DAY });
    const result = runAgingJob(db, NOW);
    expect(result.transitioned).toBe(0);
  });

  test("returns accurate count for multiple observations", () => {
    insertObs({ created_at_epoch: NOW - 31 * DAY, title: "Old 1" });
    insertObs({ created_at_epoch: NOW - 45 * DAY, title: "Old 2" });
    insertObs({ created_at_epoch: NOW - 10 * DAY, title: "Recent" });
    const result = runAgingJob(db, NOW);
    expect(result.transitioned).toBe(2);
  });

  test("handles empty database", () => {
    const result = runAgingJob(db, NOW);
    expect(result.transitioned).toBe(0);
  });
});
