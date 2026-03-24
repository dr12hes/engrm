import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { loadRecallItem } from "./load-recall-item.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-load-recall-item-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadRecallItem", () => {
  test("loads exact handoff, session, chat, and memory recall items", () => {
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
      content: "The next check is the explicit notification filter.",
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
      narrative: "Event page now uses the explicit notification list.",
      quality: 0.72,
      user_id: "david",
      device_id: "laptop",
      source_tool: "assistant-stop",
    });

    const handoff = loadRecallItem(db, { key: "handoff:1", user_id: "david" });
    const thread = loadRecallItem(db, { key: "session:sess-1", user_id: "david" });
    const chat = loadRecallItem(db, { key: "chat:1", user_id: "david" });
    const memory = loadRecallItem(db, { key: "obs:2", user_id: "david" });

    expect(handoff.kind).toBe("handoff");
    expect(handoff.payload?.type).toBe("handoff");
    expect(handoff.source_agent).toBe("claude-code");
    expect(thread.kind).toBe("thread");
    expect(thread.payload?.type).toBe("thread");
    expect(thread.payload?.current_thread).toContain("EventService");
    expect(thread.source_agent).toBe("claude-code");
    expect(chat.kind).toBe("chat");
    expect(chat.payload?.type).toBe("chat");
    expect(chat.payload?.source).toBe("transcript");
    expect(chat.source_agent).toBe("claude-code");
    expect(memory.kind).toBe("memory");
    expect(memory.payload?.type).toBe("memory");
    expect(memory.payload?.observation_type).toBe("change");
    expect(memory.source_agent).toBe("claude-code");
  });
});
