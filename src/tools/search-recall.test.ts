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
});
