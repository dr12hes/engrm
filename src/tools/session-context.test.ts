import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getSessionContext } from "./session-context.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-session-context-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getSessionContext", () => {
  test("previews injected context for the current project", () => {
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
      request: "Investigate why startup context still feels thin",
      investigated: null,
      learned: null,
      completed: "Exposed project memory index in MCP",
      next_steps: "Surface stronger handoff cues ahead of raw chronology.\nVerify the preview still stays compact.",
    });
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Investigate why startup context still feels thin",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/context.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "discovery",
      title: "Prompt chronology was missing from startup context",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "change",
      title: "Exposed project memory index in MCP",
      files_modified: JSON.stringify(["src/tools/project-memory-index.ts"]),
      quality: 0.7,
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "message",
      title: "Handoff: Finish improving startup handoff quality · 2026-03-21 22:20Z",
      narrative: "Current thread: Finish improving startup handoff quality",
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
      content: "We should make the explicit handoff show up ahead of raw prompt chronology.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
    });
    db.upsertSession("sess-2", project.id, "david", "desktop", "codex-cli");
    db.insertSessionSummary({
      session_id: "sess-2",
      project_id: project.id,
      user_id: "david",
      request: "Check desktop continuity",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
    });

    const result = getSessionContext(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result).not.toBeNull();
    expect(result?.project_name).toBe("repo");
    expect(result?.active_agents).toEqual(["claude-code", "codex-cli"]);
    expect(result?.cross_agent_active).toBe(true);
    expect(result?.continuity_state).toBe("fresh");
    expect(result?.recall_mode).toBe("direct");
    expect(result?.recall_items_ready).toBeGreaterThan(0);
    expect(result?.recall_index_preview.length).toBeGreaterThan(0);
    expect(result?.recall_index_preview[0]?.key).toContain(":");
    expect(result?.best_recall_key).toBe("handoff:3");
    expect(result?.best_recall_kind).toBe("handoff");
    expect(result?.best_recall_title).toContain("Finish improving startup handoff quality");
    expect(result?.resume_freshness).toBe("live");
    expect(result?.resume_source_session_id).toBe("sess-1");
    expect(result?.resume_source_device_id).toBe("laptop");
    expect(result?.resume_next_actions[0]).toContain("Surface stronger handoff cues");
    expect(result?.recent_requests).toBe(1);
    expect(result?.recent_tools).toBe(1);
    expect(result?.capture_state).toBe("rich");
    expect(result?.raw_capture_active).toBe(true);
    expect(result?.recent_handoffs).toBe(1);
    expect(result?.saved_handoffs).toBe(1);
    expect(result?.rolling_handoff_drafts).toBe(0);
    expect(result?.latest_handoff_title).toContain("Handoff:");
    expect(result?.recent_chat_messages).toBe(1);
    expect(result?.recent_chat_sessions).toBe(1);
    expect(result?.chat_source_summary).toEqual({ transcript: 0, history: 0, hook: 1 });
    expect(result?.chat_coverage_state).toBe("hook-only");
    expect(result?.estimated_read_tokens).toBeGreaterThan(0);
    expect(result?.suggested_tools).toContain("recent_sessions");
    expect(result?.suggested_tools).toContain("agent_memory_index");
    expect(result?.suggested_tools).toContain("activity_feed");
    expect(result?.suggested_tools).toContain("list_recall_items");
    expect(result?.suggested_tools).toContain("load_recall_item");
    expect(result?.suggested_tools).toContain("resume_thread");
    expect(result?.recent_outcomes).toContain("Exposed project memory index in MCP");
    expect(result?.hot_files).toEqual([
      { path: "src/tools/project-memory-index.ts", count: 1 },
    ]);
    expect(result?.continuity_summary).toContain("Fresh repo-local continuity");
    expect(result?.preview).toContain("## Recent Handoffs");
    expect(result?.preview).toContain("## Recent Requests");
    expect(result?.preview).toContain("## Recent Tools");
  });
});
