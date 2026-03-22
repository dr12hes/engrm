import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { searchChat } from "./search-chat.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-search-chat-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("searchChat", () => {
  test("returns source coverage for matching chat results", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "user",
      content: "The eventservice review still feels incomplete.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });
    db.insertChatMessage({
      session_id: "sess-2",
      project_id: project.id,
      role: "assistant",
      content: "I left a hook-edge note about the eventservice follow-up.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "hook",
    });

    const result = await searchChat(db, {
      cwd: "/tmp/repo",
      user_id: "david",
      query: "eventservice",
    });

    expect(result.messages).toHaveLength(2);
    expect(result.session_count).toBe(2);
    expect(result.source_summary).toEqual({ transcript: 1, history: 0, hook: 1 });
    expect(result.transcript_backed).toBe(true);
  });

  test("prefers fresher transcript-backed chat over older hook matches", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });
    const now = Math.floor(Date.now() / 1000);

    db.insertChatMessage({
      session_id: "sess-old",
      project_id: project.id,
      role: "assistant",
      content: "We talked about eventservice last week.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "hook",
      created_at_epoch: now - 7 * 24 * 3600,
    });
    db.insertChatMessage({
      session_id: "sess-new",
      project_id: project.id,
      role: "user",
      content: "Please review eventservice because I think we already addressed it.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
      created_at_epoch: now - 120,
    });

    const result = await searchChat(db, {
      cwd: "/tmp/repo",
      user_id: "david",
      query: "eventservice",
      limit: 2,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.session_id).toBe("sess-new");
    expect(result.messages[0]?.source_kind).toBe("transcript");
  });

  test("treats meta recall queries as recent thread recovery", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });
    const now = Math.floor(Date.now() / 1000);

    db.insertChatMessage({
      session_id: "sess-old",
      project_id: project.id,
      role: "assistant",
      content: "Old thread about licensing and packaging.",
      user_id: "david",
      device_id: "desktop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
      created_at_epoch: now - 3 * 24 * 3600,
    });
    db.insertChatMessage({
      session_id: "sess-live",
      project_id: project.id,
      role: "user",
      content: "Let's keep working on eventservice and notification routing.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
      created_at_epoch: now - 60,
    });

    const result = await searchChat(db, {
      cwd: "/tmp/repo",
      user_id: "david",
      query: "what were we just talking about",
      limit: 2,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.session_id).toBe("sess-live");
    expect(result.messages[0]?.content).toContain("eventservice");
    expect(result.semantic_backed).toBe(false);
  });
});
