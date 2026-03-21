import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { MemDatabase } from "../storage/sqlite.js";
import { getActivityFeed } from "./activity-feed.js";
import { createHandoff } from "./handoffs.js";

let db: MemDatabase;
let tmpDir: string;
let config: Config;

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    candengo_url: "https://engrm.dev",
    candengo_api_key: "test-key",
    site_id: "test-site",
    namespace: "test-ns",
    user_id: "david",
    device_id: "laptop",
    user_email: "",
    teams: [],
    sync: { enabled: true, interval_seconds: 30, batch_size: 50 },
    search: { default_limit: 10, local_boost: 1.2, scope: "all" },
    scrubbing: {
      enabled: true,
      custom_patterns: [],
      default_sensitivity: "shared",
    },
    sentinel: {
      enabled: false,
      mode: "advisory",
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "",
      base_url: "",
      skip_patterns: [],
      daily_limit: 100,
      tier: "free",
    },
    observer: {
      enabled: true,
      mode: "per_event",
      model: "sonnet",
    },
    transcript_analysis: {
      enabled: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-activity-feed-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  config = makeConfig();
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

  test("surfaces explicit handoffs as first-class feed events", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: tmpDir,
    });

    db.upsertSession("sess-handoff", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-handoff",
      project_id: project.id,
      prompt: "Finish wiring the events feed into chat actions.",
      user_id: "david",
      device_id: "laptop",
      cwd: tmpDir,
    });
    db.insertObservation({
      session_id: "sess-handoff",
      project_id: project.id,
      type: "feature",
      title: "Wired the events feed into chat actions",
      quality: 0.9,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 1,
    });
    db.upsertSessionSummary({
      session_id: "sess-handoff",
      project_id: project.id,
      user_id: "david",
      request: "Finish wiring the events feed into chat actions.",
      completed: "Wired the events feed into chat actions",
      current_thread: "Events feed into chat actions",
    });

    await createHandoff(db, config, {
      session_id: "sess-handoff",
      cwd: tmpDir,
    });

    const result = getActivityFeed(db, {
      session_id: "sess-handoff",
      limit: 10,
    });

    const handoffEvent = result.events.find((event) => event.kind === "handoff");
    expect(handoffEvent).toBeTruthy();
    expect(handoffEvent?.title.startsWith("Handoff:")).toBe(true);
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
    db.insertChatMessage({
      session_id: "sess-2",
      project_id: project.id,
      role: "assistant",
      content: "I traced the audit flow and I am wiring the persistence next.",
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

    expect(result.events).toHaveLength(4);
    const toolEvent = result.events.find((event) => event.kind === "tool");
    expect(toolEvent?.detail).toBe("src/audit.ts");
    const chatEvent = result.events.find((event) => event.kind === "chat");
    expect(chatEvent?.title).toBe("assistant");
    expect(chatEvent?.detail).toContain("wiring the persistence next");
    expect(result.events.some((event) => event.kind === "prompt")).toBe(true);
    expect(result.events.some((event) => event.kind === "tool")).toBe(true);
    expect(result.events.some((event) => event.kind === "chat")).toBe(true);
    expect(result.events.some((event) => event.kind === "observation")).toBe(true);
  });
});
