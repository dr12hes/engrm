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
  test("returns source coverage for matching chat results", () => {
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

    const result = searchChat(db, {
      cwd: "/tmp/repo",
      user_id: "david",
      query: "eventservice",
    });

    expect(result.messages).toHaveLength(2);
    expect(result.session_count).toBe(2);
    expect(result.source_summary).toEqual({ transcript: 1, hook: 1 });
    expect(result.transcript_backed).toBe(true);
  });
});
