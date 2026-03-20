import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getRecentSessions } from "./recent-sessions.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-recent-sessions-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRecentSessions", () => {
  test("returns recent sessions scoped to the current project", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });
    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.insertSessionSummary({
      session_id: "sess-1",
      project_id: project.id,
      user_id: "david",
      request: "Fix auth flow",
      investigated: null,
      learned: null,
      completed: "Added retry",
      next_steps: null,
    });

    const result = getRecentSessions(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.request).toBe("Fix auth flow");
  });
});
