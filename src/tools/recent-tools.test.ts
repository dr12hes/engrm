import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getRecentTools } from "./recent-tools.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-recent-tools-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRecentTools", () => {
  test("returns recent tools scoped to the current project", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "/tmp/repo/src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });

    const result = getRecentTools(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.tool_events).toHaveLength(1);
    expect(result.tool_events[0]?.tool_name).toBe("Edit");
  });

  test("returns session tool chronology when session_id is provided", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Read",
      user_id: "david",
      device_id: "laptop",
      created_at_epoch: 100,
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      user_id: "david",
      device_id: "laptop",
      created_at_epoch: 200,
    });

    const result = getRecentTools(db, {
      session_id: "sess-1",
    });

    expect(result.tool_events.map((item) => item.tool_name)).toEqual(["Edit", "Read"]);
  });
});
