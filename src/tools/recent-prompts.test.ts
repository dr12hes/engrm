import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getRecentRequests } from "./recent-prompts.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-recent-prompts-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRecentRequests", () => {
  test("returns recent prompts scoped to the current project", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Investigate auth loop",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop",
    });

    const result = getRecentRequests(db, {
      cwd: "/tmp/repo",
      user_id: "david",
    });

    expect(result.project).toBe("repo");
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.prompt).toContain("auth loop");
  });

  test("returns session prompt chronology when session_id is provided", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "First request",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Second request",
      cwd: "/tmp/repo",
      user_id: "david",
      device_id: "laptop",
    });

    const result = getRecentRequests(db, {
      session_id: "sess-1",
    });

    expect(result.prompts.map((item) => item.prompt_number)).toEqual([2, 1]);
  });
});
