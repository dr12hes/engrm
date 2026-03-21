import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { MemDatabase } from "../storage/sqlite.js";
import { createHandoff, formatHandoffSource, getRecentHandoffs, loadHandoff } from "./handoffs.js";

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

  test("createHandoff auto-includes chat snippets for thin sessions", async () => {
    const project = db.upsertProject({
      canonical_id: "github.com/dr12hes/huginn",
      name: "huginn",
      local_path: tmpDir,
    });
    db.upsertSession("sess-thin", project.id, config.user_id, config.device_id, "claude-code");
    db.insertUserPrompt({
      session_id: "sess-thin",
      project_id: project.id,
      prompt: "Get the events feed ready for chat actions.",
      cwd: tmpDir,
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });
    db.insertChatMessage({
      session_id: "sess-thin",
      project_id: project.id,
      role: "assistant",
      content: "I have the feed plumbing in place; next I need to expose it to the chat action path.",
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });
    db.upsertSessionSummary({
      session_id: "sess-thin",
      project_id: project.id,
      user_id: config.user_id,
      request: "Get the events feed ready for chat actions.",
      completed: null,
      next_steps: null,
      current_thread: null,
      capture_state: "partial",
      recent_tool_names: JSON.stringify([]),
      hot_files: JSON.stringify([]),
      recent_outcomes: JSON.stringify([]),
    });

    const result = await createHandoff(db, config, {
      session_id: "sess-thin",
      cwd: tmpDir,
    });

    expect(result.success).toBe(true);
    const obs = db.getObservationById(result.observation_id!);
    expect(obs?.narrative).toContain("Chat snippets:");
    expect(obs?.narrative).toContain("chat action path");
  });

  test("createHandoff keeps chat snippets out of already-rich sessions by default", async () => {
    const project = db.upsertProject({
      canonical_id: "github.com/dr12hes/huginn",
      name: "huginn",
      local_path: tmpDir,
    });
    db.upsertSession("sess-rich", project.id, config.user_id, config.device_id, "claude-code");
    db.insertUserPrompt({
      session_id: "sess-rich",
      project_id: project.id,
      prompt: "Finish wiring the event feed and capture the shipped outcome.",
      cwd: tmpDir,
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });
    db.insertToolEvent({
      session_id: "sess-rich",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "AIServer/app/routers/events.py",
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });
    db.insertChatMessage({
      session_id: "sess-rich",
      project_id: project.id,
      role: "assistant",
      content: "I have enough context now to summarize the finished path cleanly.",
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "claude-code",
    });
    db.upsertSessionSummary({
      session_id: "sess-rich",
      project_id: project.id,
      user_id: config.user_id,
      request: "Finish wiring the event feed and capture the shipped outcome.",
      completed: "Wired the event feed into the existing Event Log path.",
      next_steps: "Verify chat action dispatch next.",
      current_thread: "Event feed shipped into Event Log path",
      capture_state: "rich",
      recent_tool_names: JSON.stringify(["Edit"]),
      hot_files: JSON.stringify(["AIServer/app/routers/events.py"]),
      recent_outcomes: JSON.stringify([
        "Wired event metrics into the existing Event Log feed",
        "Preserved the current Event Log UI path",
      ]),
    });

    const result = await createHandoff(db, config, {
      session_id: "sess-rich",
      cwd: tmpDir,
    });

    expect(result.success).toBe(true);
    const obs = db.getObservationById(result.observation_id!);
    expect(obs?.narrative).not.toContain("Chat snippets:");
  });

  test("formatHandoffSource shows device and recency", () => {
    const now = Math.floor(Date.now() / 1000);
    const label = formatHandoffSource({
      device_id: "laptop-abc",
      created_at_epoch: now - 120,
    });

    expect(label).toContain("from laptop-abc");
    expect(label).toContain("ago");
  });

  test("recent and loaded handoffs prefer another device when available", () => {
    const project = db.upsertProject({
      canonical_id: "github.com/dr12hes/huginn",
      name: "huginn",
      local_path: tmpDir,
    });

    const local = db.insertObservation({
      session_id: "sess-local",
      project_id: project.id,
      type: "message",
      title: "Handoff: local follow-up",
      quality: 0.8,
      user_id: config.user_id,
      device_id: config.device_id,
      agent: "engrm-handoff",
      created_at_epoch: Math.floor(Date.now() / 1000),
      concepts: JSON.stringify(["handoff"]),
    });
    const remote = db.insertObservation({
      session_id: "sess-remote",
      project_id: project.id,
      type: "message",
      title: "Handoff: resume from laptop",
      quality: 0.8,
      user_id: config.user_id,
      device_id: "home-laptop",
      agent: "engrm-handoff",
      created_at_epoch: Math.floor(Date.now() / 1000) - 60,
      concepts: JSON.stringify(["handoff"]),
    });

    const recent = getRecentHandoffs(db, {
      cwd: tmpDir,
      user_id: config.user_id,
      current_device_id: config.device_id,
    });
    expect(recent.handoffs[0]?.id).toBe(remote.id);
    expect(recent.handoffs[1]?.id).toBe(local.id);

    const loaded = loadHandoff(db, {
      cwd: tmpDir,
      user_id: config.user_id,
      current_device_id: config.device_id,
    });
    expect(loaded.handoff?.id).toBe(remote.id);
  });
});
