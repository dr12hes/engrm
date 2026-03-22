import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { repairRecall } from "./repair-recall.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-repair-recall-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  delete process.env["ENGRM_CLAUDE_HISTORY_PATH"];
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("repairRecall", () => {
  test("rehydrates recent project sessions from Claude history fallback", async () => {
    const cwd = join(tmpDir, "workspace");
    const historyProject = join(tmpDir, "history-project");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(historyProject, { recursive: true });
    writeFileSync(join(cwd, ".engrm.json"), JSON.stringify({ project_id: "local/shared-project" }));
    writeFileSync(join(historyProject, ".engrm.json"), JSON.stringify({ project_id: "local/shared-project" }));

    const project = db.upsertProject({
      canonical_id: "local/shared-project",
      name: "shared-project",
      local_path: cwd,
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
    db.upsertSession("sess-2", project.id, "david", "laptop", "claude-code");

    const historyPath = join(tmpDir, "history.jsonl");
    const now = Date.now();
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          display: "please review eventservice because I think we fixed it already",
          project: historyProject,
          sessionId: "other-session-a",
          timestamp: now - 60_000,
        }),
        JSON.stringify({
          display: "we need alerts to show only explicit notification events",
          project: historyProject,
          sessionId: "other-session-b",
          timestamp: now - 30_000,
        }),
      ].join("\n")
    );
    process.env["ENGRM_CLAUDE_HISTORY_PATH"] = historyPath;

    const result = await repairRecall(
      db,
      { user_id: "david", device_id: "laptop" } as any,
      { cwd, user_id: "david", limit: 2 }
    );

    expect(result.scope).toBe("project");
    expect(result.project_name).toBe("shared-project");
    expect(result.inspected_sessions).toBe(2);
    expect(result.sessions_with_imports).toBeGreaterThan(0);
    expect(result.imported_chat_messages).toBeGreaterThan(0);
    expect(result.results.some((session) => session.chat_coverage_state === "history-backed")).toBe(true);
    expect(result.results.every((session) => session.prompt_count_after >= 0)).toBe(true);
  });
});
