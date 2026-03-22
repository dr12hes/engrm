import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getRecentChat } from "./recent-chat.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-recent-chat-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRecentChat", () => {
  test("reports transcript coverage and session spread", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "user",
      content: "Please carry the event work over to my home machine.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "I will preserve the current thread in the handoff draft.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 2,
    });
    db.insertChatMessage({
      session_id: "sess-2",
      project_id: project.id,
      role: "assistant",
      content: "Only hook-edge capture is available for this shorter session.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "hook",
    });

    const result = getRecentChat(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.session_count).toBe(2);
    expect(result.source_summary).toEqual({ transcript: 2, history: 0, hook: 1 });
    expect(result.transcript_backed).toBe(true);
  });

  test("dedupes the same message across hook/history/transcript capture lanes", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "We should keep the live thread resumable across machines.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "hook",
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "We should keep the live thread resumable across machines.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "hook",
      remote_source_id: "history:sess-1:123:abc",
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "We should keep the live thread resumable across machines.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });

    const result = getRecentChat(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.source_kind).toBe("transcript");
    expect(result.source_summary).toEqual({ transcript: 1, history: 0, hook: 0 });
  });
});
