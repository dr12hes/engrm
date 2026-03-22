import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { searchRecall } from "./search-recall.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-search-recall-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("searchRecall", () => {
  test("merges memory and chat recall into one result set", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Use eventservice as the shared event dispatch surface",
      narrative: "This keeps notification routing and chat-triggered actions aligned.",
      quality: 0.82,
      user_id: "david",
      device_id: "laptop",
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "user",
      content: "Please review eventservice because I think we already addressed that issue.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
      created_at_epoch: Math.floor(Date.now() / 1000),
    });

    const result = await searchRecall(db, {
      query: "eventservice",
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.totals.memory).toBe(1);
    expect(result.totals.chat).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results.some((item) => item.kind === "memory")).toBe(true);
    expect(result.results.some((item) => item.kind === "chat")).toBe(true);
    expect(result.results[0]?.kind).toBe("chat");
    expect(result.results[0]?.source_kind).toBe("transcript");
  });

  test("treats meta recall queries as continuity-first", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });
    const now = Math.floor(Date.now() / 1000);

    db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "License changed from ELv2 to FSL-1.1-ALv2",
      narrative: "Older repo memory that should not beat the live thread.",
      quality: 0.9,
      user_id: "david",
      device_id: "desktop",
      created_at: new Date((now - 9 * 24 * 3600) * 1000).toISOString(),
      created_at_epoch: now - 9 * 24 * 3600,
    });
    db.insertChatMessage({
      session_id: "sess-live",
      project_id: project.id,
      role: "assistant",
      content: "We were just talking about eventservice and alert routing.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
      created_at_epoch: now - 90,
    });

    const result = await searchRecall(db, {
      query: "what were we just talking about",
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.results[0]?.kind).toBe("chat");
    expect(result.results[0]?.detail).toContain("eventservice");
  });

  test("prefers entries from the most recent active session", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });
    const now = Math.floor(Date.now() / 1000);

    db.upsertSession("sess-old", project.id, "david", "desktop", "claude-code");
    db.upsertSession("sess-new", project.id, "david", "laptop", "claude-code");

    db.insertObservation({
      session_id: "sess-old",
      project_id: project.id,
      type: "decision",
      title: "Use eventservice as the shared event dispatch surface",
      narrative: "Older matching memory.",
      quality: 0.9,
      user_id: "david",
      device_id: "desktop",
      created_at: new Date((now - 2 * 24 * 3600) * 1000).toISOString(),
      created_at_epoch: now - 2 * 24 * 3600,
    });

    db.insertChatMessage({
      session_id: "sess-new",
      project_id: project.id,
      role: "assistant",
      content: "We are actively reviewing eventservice and notification flow.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
      created_at_epoch: now - 45,
    });

    const result = await searchRecall(db, {
      query: "eventservice",
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.results[0]?.kind).toBe("chat");
    expect(result.results[0]?.session_id).toBe("sess-new");
  });
});
