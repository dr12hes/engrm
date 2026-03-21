import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { MemDatabase } from "../storage/sqlite.js";
import { createHandoff, getRecentHandoffs, loadHandoff } from "./handoffs.js";

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
    device_id: "laptop-abc",
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
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-handoffs-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  config = makeConfig();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handoff tools", () => {
  test("createHandoff saves a syncable handoff message from a recent session", async () => {
    const project = db.upsertProject({
      canonical_id: "github.com/dr12hes/huginn",
      name: "huginn",
      local_path: tmpDir,
    });
    db.upsertSession("sess-1", project.id, config.user_id, config.device_id, "claude-code");
    db.insertUserPrompt({
      session_id: "sess-1",
      project_id: project.id,
      prompt: "Wire the events data into the existing Event Log feed first.",
      cwd: tmpDir,
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "I'll plumb the events feed first, then expose it to chat actions.",
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });
    db.insertObservation({
      session_id: "sess-1",
      project_id: project.id,
      type: "feature",
      title: "Wired event metrics into the existing Event Log feed",
      narrative: "The current event nav-item can now read from the existing feed instead of a stub.",
      facts: JSON.stringify(["events feed connected", "existing Event Log reused"]),
      concepts: JSON.stringify(["events", "chat"]),
      files_modified: JSON.stringify(["AIServer/app/routers/events.py"]),
      quality: 0.92,
      lifecycle: "active",
      sensitivity: "shared",
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
      source_tool: "Edit",
      source_prompt_number: 1,
    });
    db.upsertSessionSummary({
      session_id: "sess-1",
      project_id: project.id,
      user_id: config.user_id,
      request: "Plumb real event data into the existing events feed first.",
      completed: "Wired the event feed into the existing Event Log path.",
      next_steps: "Expose event-driven chat actions once the feed is stable.",
      current_thread: "Plumbing event data into Event Log and chat actions",
      capture_state: "partial",
      recent_tool_names: JSON.stringify(["Edit"]),
      hot_files: JSON.stringify(["AIServer/app/routers/events.py"]),
      recent_outcomes: JSON.stringify(["Wired event metrics into the existing Event Log feed"]),
    });

    const result = await createHandoff(db, config, {
      cwd: tmpDir,
      include_chat: true,
    });

    expect(result.success).toBe(true);
    expect(result.observation_id).toBeGreaterThan(0);

    const obs = db.getObservationById(result.observation_id!);
    expect(obs?.type).toBe("message");
    expect(obs?.title.startsWith("Handoff:")).toBe(true);
    expect(obs?.narrative).toContain("Current thread:");
    expect(obs?.narrative).toContain("Chat snippets:");
    expect(obs?.narrative).toContain("Tool trail:");
    expect(obs?.concepts).toContain("handoff");

    const recent = getRecentHandoffs(db, {
      cwd: tmpDir,
      user_id: config.user_id,
    });
    expect(recent.handoffs).toHaveLength(1);
    expect(recent.handoffs[0]?.id).toBe(result.observation_id);

    const loaded = loadHandoff(db, {
      id: result.observation_id,
      user_id: config.user_id,
    });
    expect(loaded.handoff?.id).toBe(result.observation_id);
    expect(loaded.handoff?.narrative).toContain("Recent outcomes:");
  });
});
