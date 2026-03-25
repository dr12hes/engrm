import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getUnreadInboxMessageCount, getUnreadInboxMessages } from "./inbox-messages.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-inbox-messages-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("inbox messages", () => {
  test("excludes handoffs from unread inbox counts", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertObservation({
      project_id: project.id,
      type: "message",
      title: "Handoff: Resume auth cleanup · 2026-03-25 08:00Z",
      narrative: "Current thread: auth cleanup",
      concepts: JSON.stringify(["handoff", "session-handoff"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "create_handoff",
    });
    db.insertObservation({
      project_id: project.id,
      type: "message",
      title: "Check the desktop before lunch",
      narrative: "The OpenClaw box looked flaky this morning.",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "send_message",
    });

    const count = getUnreadInboxMessageCount(db, "desktop", "david", 0);
    const messages = getUnreadInboxMessages(db, "desktop", "david", 0);

    expect(count).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.title).toBe("Check the desktop before lunch");
  });
});
