import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getMemoryConsole } from "./memory-console.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-memory-console-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getMemoryConsole", () => {
  test("returns a combined local overview for a project", () => {
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
      source_tool: "Edit",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "change",
      title: "Bedford Hotel now appears inactive in site list",
      quality: 0.72,
      user_id: "david",
      device_id: "laptop",
      source_tool: "assistant-stop",
    });

    const result = getMemoryConsole(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.capture_mode).toBe("rich");
    expect(result.sessions).toHaveLength(1);
    expect(result.requests).toHaveLength(1);
    expect(result.tools).toHaveLength(1);
    expect(result.observations).toHaveLength(2);
    expect(result.capture_summary?.rich_sessions).toBe(1);
    expect(result.recent_outcomes).toContain("Fixed auth redirect");
    expect(result.hot_files[0]?.path).toBe("src/auth.ts");
    expect(result.provenance_summary).toEqual([{ tool: "assistant-stop", count: 1 }, { tool: "Edit", count: 1 }]);
    expect(result.assistant_checkpoint_count).toBe(1);
    expect(result.top_types[0]).toEqual({ type: "bugfix", count: 1 });
    expect(result.estimated_read_tokens).toBeGreaterThan(0);
    expect(result.suggested_tools).toContain("recent_sessions");
    expect(result.suggested_tools).toContain("activity_feed");
    expect(result.suggested_tools).toContain("capture_git_worktree");
  });
});
