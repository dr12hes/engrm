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
      next_steps: "Verify retry headers in the auth flow.\nConfirm the home-machine handoff still loads cleanly.",
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
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "message",
      title: "Please check the auth cleanup from the home machine",
      quality: 0.55,
      user_id: "david",
      device_id: "desktop",
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
      role: "user",
      content: "Please leave me a clean resume point for this auth cleanup.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
    });
    db.upsertSession("sess-2", project.id, "david", "desktop", "codex-cli");
    db.insertSessionSummary({
      session_id: "sess-2",
      project_id: project.id,
      user_id: "david",
      request: "Audit desktop resume",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
    });

    const result = getMemoryConsole(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.active_agents).toEqual(["claude-code", "codex-cli"]);
    expect(result.cross_agent_active).toBe(true);
    expect(result.capture_mode).toBe("rich");
    expect(result.continuity_state).toBe("fresh");
    expect(result.recall_mode).toBe("direct");
    expect(result.recall_items_ready).toBeGreaterThan(0);
    expect(result.recall_index_preview.length).toBeGreaterThan(0);
    expect(result.recall_index_preview[0]?.key).toContain(":");
    expect(result.best_recall_key).toMatch(/^handoff:\d+$/);
    expect(result.best_recall_kind).toBe("handoff");
    expect(result.best_recall_title).toContain("Resume auth cleanup from home machine");
    expect(result.best_agent_resume_agent).toBe("claude-code");
    expect(result.resume_freshness).toBe("live");
    expect(typeof result.resume_source_session_id === "string" || result.resume_source_session_id === null).toBe(true);
    expect(typeof result.resume_source_device_id === "string" || result.resume_source_device_id === null).toBe(true);
    expect(Array.isArray(result.resume_next_actions)).toBe(true);
    expect(result.sessions).toHaveLength(2);
    expect(result.requests).toHaveLength(1);
    expect(result.tools).toHaveLength(1);
    expect(result.recent_handoffs).toHaveLength(1);
    expect(result.saved_handoffs).toBe(1);
    expect(result.rolling_handoff_drafts).toBe(0);
    expect(result.recent_inbox_notes).toHaveLength(1);
    expect(result.latest_inbox_note_title).toContain("Please check the auth cleanup");
    expect(result.recent_chat).toHaveLength(1);
    expect(result.recent_chat_sessions).toBe(1);
    expect(result.chat_source_summary).toEqual({ transcript: 0, history: 0, hook: 1 });
    expect(result.chat_coverage_state).toBe("hook-only");
    expect(result.observations).toHaveLength(4);
    expect(result.capture_summary?.rich_sessions).toBe(1);
    expect(result.recent_outcomes).toContain("Fixed auth redirect");
    expect(result.hot_files[0]?.path).toBe("src/auth.ts");
    expect(result.provenance_summary).toEqual([
      { tool: "assistant-stop", count: 1 },
      { tool: "create_handoff", count: 1 },
      { tool: "Edit", count: 1 },
    ]);
    expect(result.assistant_checkpoint_count).toBe(1);
    expect(result.top_types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", count: 2 }),
        expect.objectContaining({ type: "bugfix", count: 1 }),
      ])
    );
    expect(result.estimated_read_tokens).toBeGreaterThan(0);
    expect(result.continuity_summary).toContain("Fresh repo-local continuity");
    expect(result.suggested_tools).toContain("recent_sessions");
    expect(result.suggested_tools).toContain("agent_memory_index");
    expect(result.suggested_tools).toContain("activity_feed");
    expect(result.suggested_tools).toContain("list_recall_items");
    expect(result.suggested_tools).toContain("load_recall_item");
    expect(result.suggested_tools).toContain("resume_thread");
  });
});
