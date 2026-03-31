import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { listRecallItems } from "./list-recall-items.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-list-recall-items-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("listRecallItems", () => {
  test("builds a directory-style recall index with handoffs first", () => {
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
      request: "Review EventService routing and explicit notifications",
      investigated: null,
      learned: null,
      completed: "Wired the explicit event list into the events page",
      next_steps: "Verify only explicit notification events appear in the events page.",
      current_thread: "Review EventService routing and explicit notifications",
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "The EventService routing looks correct; the next check is the explicit notification filter.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 2,
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume EventService notification routing · 2026-03-22 18:20Z",
      narrative: "Current thread: Review EventService routing and explicit notifications",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "create_handoff",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "change",
      title: "Wired the explicit event list into the events page",
      quality: 0.72,
      user_id: "david",
      device_id: "laptop",
      source_tool: "assistant-stop",
    });

    const result = listRecallItems(db, {
      cwd: "/tmp/repo",
      user_id: "david",
      current_device_id: "desktop",
    });

    expect(result.project).toBe("repo");
    expect(result.continuity_mode).toBe("direct");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]?.kind).toBe("handoff");
    expect(result.items[0]?.key).toBe("handoff:1");
    expect(result.items[0]?.source_device_id).toBe("laptop");
    expect(result.items[0]?.source_agent).toBe("claude-code");
    expect(result.items.some((item) => item.kind === "thread" && item.session_id === "sess-1")).toBe(true);
    expect(result.items.some((item) => item.kind === "chat" && item.detail.includes("explicit notification filter"))).toBe(true);
    expect(result.items.some((item) => item.kind === "memory" && item.title.includes("Wired the explicit event list"))).toBe(true);
  });

  test("prefers Claude recall items when claude-code is the preferred agent", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("claude-sess", project.id, "david", "laptop", "claude-code");
    db.insertSessionSummary({
      session_id: "claude-sess",
      project_id: project.id,
      user_id: "david",
      request: "Review Claude memory startup",
      investigated: null,
      learned: null,
      completed: "Claude-side resume is ready",
      next_steps: "Verify startup prefers Claude thread first.",
      current_thread: "Review Claude memory startup",
    });
    db.insertObservation({
      session_id: "claude-sess",
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume Claude memory startup · 2026-03-22 18:20Z",
      narrative: "Current thread: Review Claude memory startup",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "create_handoff",
    });

    db.upsertSession("codex-sess", project.id, "david", "desktop", "codex-cli");
    db.insertSessionSummary({
      session_id: "codex-sess",
      project_id: project.id,
      user_id: "david",
      request: "Review Codex thread",
      investigated: null,
      learned: null,
      completed: "Codex-side work is also active",
      next_steps: "Verify Claude still wins when preferred.",
      current_thread: "Review Codex thread",
    });
    db.insertObservation({
      session_id: "codex-sess",
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume Codex thread · 2026-03-22 18:25Z",
      narrative: "Current thread: Review Codex thread",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.8,
      user_id: "david",
      device_id: "desktop",
      source_tool: "create_handoff",
    });

    const result = listRecallItems(db, {
      cwd: "/tmp/repo",
      user_id: "david",
      current_device_id: "desktop",
      preferred_agent: "claude-code",
    });

    expect(result.items[0]?.source_agent).toBe("claude-code");
    expect(result.items[0]?.key).toBe("handoff:1");
  });
});
