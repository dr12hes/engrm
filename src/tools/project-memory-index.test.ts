import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getProjectMemoryIndex } from "./project-memory-index.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-project-memory-index-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getProjectMemoryIndex", () => {
  test("returns typed project-level memory overview", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "bugfix",
      title: "Fixed auth redirect",
      files_modified: JSON.stringify(["src/auth.ts"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "decision",
      title: "Use cookie retry",
      quality: 0.7,
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "change",
      title: "Modified auth.ts",
      quality: 0.4,
      user_id: "david",
      device_id: "laptop",
    });
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

    const result = getProjectMemoryIndex(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result?.project).toBe("repo");
    expect(result?.observation_counts.bugfix).toBe(1);
    expect(result?.observation_counts.decision).toBe(1);
    expect(result?.recent_requests_count).toBe(1);
    expect(result?.recent_tools_count).toBe(1);
    expect(result?.raw_capture_active).toBe(true);
    expect(result?.hot_files[0]?.path).toBe("src/auth.ts");
    expect(result?.recent_outcomes).toContain("Fixed auth redirect");
    expect(result?.recent_outcomes).not.toContain("Modified auth.ts");
  });
});
