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
      source_tool: "Edit",
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
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume auth cleanup from home machine · 2026-03-21 22:25Z",
      narrative: "Current thread: Resume auth cleanup from home machine",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.7,
      user_id: "david",
      device_id: "laptop",
      source_tool: "create_handoff",
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "The auth cleanup is ready to resume from the latest retry work.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
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
    expect(result?.recent_handoffs_count).toBe(1);
    expect(result?.recent_chat_count).toBe(1);
    expect(result?.raw_capture_active).toBe(true);
    expect(result?.capture_summary.rich_sessions).toBe(1);
    expect(result?.hot_files[0]?.path).toBe("src/auth.ts");
    expect(result?.recent_outcomes).toContain("Fixed auth redirect");
    expect(result?.recent_outcomes).not.toContain("Modified auth.ts");
    expect(result?.provenance_summary).toEqual([
      { tool: "assistant-stop", count: 1 },
      { tool: "create_handoff", count: 1 },
      { tool: "Edit", count: 1 },
    ]);
    expect(result?.assistant_checkpoint_count).toBe(1);
    expect(result?.assistant_checkpoint_types).toEqual([{ type: "change", count: 1 }]);
    expect(result?.top_types[0]).toEqual({ type: "change", count: 2 });
    expect(result?.estimated_read_tokens).toBeGreaterThan(0);
    expect(result?.suggested_tools).toContain("recent_sessions");
    expect(result?.suggested_tools).toContain("activity_feed");
    expect(result?.suggested_tools).toContain("tool_memory_index");
    expect(result?.suggested_tools).toContain("capture_git_worktree");
  });
});
