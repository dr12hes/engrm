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
      type: "message",
      title: "Handoff: Resume auth cleanup · 2026-03-25 08:00Z",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.2,
      user_id: "david",
      device_id: "laptop-abc",
      source_tool: "create_handoff",
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
    db.insertUserPrompt({
      session_id: "sess-123",
      project_id: project.id,
      prompt: "Fix auth flow",
      cwd: tmpDir,
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.insertToolEvent({
      session_id: "sess-123",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      tool_input_json: "{\"file_path\":\"src/auth.ts\"}",
      tool_response_preview: "Edited src/auth.ts",
      user_id: "david",
      device_id: "laptop-abc",
    });
    db.markPackInstalled("typescript-patterns", 12);
    db.addToOutbox("observation", 1);
    db.db
      .query("UPDATE sync_outbox SET status = 'failed', last_error = 'Vector API error 401 on /v1/ingest: {\"detail\":\"Invalid or missing credentials\"}' WHERE record_id = 1")
      .run();

    const stats = getMemoryStats(db);

    expect(stats.active_observations).toBe(3);
    expect(stats.user_prompts).toBe(1);
    expect(stats.tool_events).toBe(1);
    expect(stats.messages).toBe(1);
    expect(stats.inbox_messages).toBe(1);
    expect(stats.handoffs).toBe(1);
    expect(stats.session_summaries).toBe(1);
    expect(stats.summaries_with_learned).toBe(1);
    expect(stats.summaries_with_completed).toBe(1);
    expect(stats.recent_requests).toEqual(["Fix auth flow"]);
    expect(stats.recent_lessons).toContain("Refresh token path was skipped");
    expect(stats.recent_completed).toContain("Added refresh before retry");
    expect(stats.installed_packs).toContain("typescript-patterns");
    expect(stats.outbox.failed).toBe(1);
    expect(stats.outbox_failure_summary[0]).toEqual({
      category: "auth",
      error: 'Vector API error 401 on /v1/ingest: {"detail":"Invalid or missing credentials"}',
      count: 1,
    });
  });
});
