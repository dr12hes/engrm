import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDatabase } from "../storage/sqlite.js";
import { getActivityFeed } from "./activity-feed.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-activity-feed-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getActivityFeed", () => {
  test("merges prompts, tools, observations, and summaries for a project", () => {
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
      request: "Fix auth flow",
      investigated: null,
      learned: "Need to normalize callback hosts",
      completed: "Added redirect validation",
      next_steps: null,
    });
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-1",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "bugfix",
      title: "Fixed auth redirect validation",
      quality: 0.9,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 1,
    });

    const result = getActivityFeed(db, {
      cwd: "/tmp/repo",
      user_id: "david",
      limit: 10,
    });

    expect(result.project).toBe("repo");
    const summaryEvent = result.events.find((event) => event.kind === "summary");
    expect(summaryEvent).toBeTruthy();
    expect(summaryEvent?.detail).toContain("Capture: rich");
    expect(summaryEvent?.detail).toContain("Prompts/tools: 1/1");
    expect(result.events.some((event) => event.kind === "prompt")).toBe(true);
    expect(result.events.some((event) => event.kind === "tool")).toBe(true);
    expect(result.events.some((event) => event.kind === "observation")).toBe(true);
    const obsEvent = result.events.find((event) => event.kind === "observation");
    expect(obsEvent?.detail).toContain("via Edit");
    expect(obsEvent?.detail).toContain("#1");
  });

  test("supports session-specific chronology", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-2", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-2",
      project_id: project.id,
      prompt: "Add audit trail",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-2",
      project_id: project.id,
      tool_name: "Read",
      file_path: "src/audit.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-2",
      project_id: project.id,
      type: "feature",
      title: "Added audit trail",
      quality: 0.85,
      user_id: "david",
      device_id: "laptop",
    });

    const result = getActivityFeed(db, {
      session_id: "sess-2",
      limit: 10,
    });

    expect(result.events).toHaveLength(3);
    const toolEvent = result.events.find((event) => event.kind === "tool");
    expect(toolEvent?.detail).toBe("src/audit.ts");
    expect(result.events.some((event) => event.kind === "prompt")).toBe(true);
    expect(result.events.some((event) => event.kind === "tool")).toBe(true);
    expect(result.events.some((event) => event.kind === "observation")).toBe(true);
  });
});
