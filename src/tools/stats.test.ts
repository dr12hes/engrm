import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getMemoryStats } from "./stats.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-stats-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getMemoryStats", () => {
  test("summarizes captured memory state", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: tmpDir,
    });

    db.insertObservation({
      project_id: project.id,
      type: "message",
      title: "Team note",
      quality: 0.2,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Fix auth flow",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertSessionSummary({
      session_id: "sess-123",
      project_id: project.id,
      user_id: "david",
      request: "Fix auth flow",
      investigated: "Looked at token refresh",
      learned: "Refresh token path was skipped",
      completed: "Added refresh before retry",
      next_steps: null,
    });
    db.markPackInstalled("typescript-patterns", 12);
    db.addToOutbox("observation", 1);

    const stats = getMemoryStats(db);

    expect(stats.active_observations).toBe(2);
    expect(stats.messages).toBe(1);
    expect(stats.session_summaries).toBe(1);
    expect(stats.installed_packs).toContain("typescript-patterns");
    expect(stats.outbox.pending).toBe(1);
  });
});
