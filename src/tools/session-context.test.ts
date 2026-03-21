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

    const result = getSessionContext(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result).not.toBeNull();
    expect(result?.project_name).toBe("repo");
    expect(result?.recent_requests).toBe(1);
    expect(result?.recent_tools).toBe(1);
    expect(result?.capture_state).toBe("rich");
    expect(result?.raw_capture_active).toBe(true);
    expect(result?.recent_handoffs).toBe(1);
    expect(result?.saved_handoffs).toBe(1);
    expect(result?.rolling_handoff_drafts).toBe(0);
    expect(result?.latest_handoff_title).toContain("Handoff:");
    expect(result?.recent_chat_messages).toBe(1);
    expect(result?.estimated_read_tokens).toBeGreaterThan(0);
    expect(result?.suggested_tools).toContain("recent_sessions");
    expect(result?.suggested_tools).toContain("activity_feed");
    expect(result?.suggested_tools).toContain("tool_memory_index");
    expect(result?.recent_outcomes).toContain("Exposed project memory index in MCP");
    expect(result?.hot_files).toEqual([
      { path: "src/tools/project-memory-index.ts", count: 1 },
    ]);
    expect(result?.preview).toContain("## Recent Handoffs");
    expect(result?.preview).toContain("## Recent Requests");
    expect(result?.preview).toContain("## Recent Tools");
  });
});
