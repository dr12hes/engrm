import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { MemDatabase } from "../storage/sqlite.js";
import { getSessionStory } from "./session-story.js";
import { createHandoff, upsertRollingHandoff } from "./handoffs.js";

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
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-session-story-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  config = makeConfig();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getSessionStory", () => {
  test("returns prompts, tools, observations, summary, and metrics for a session", () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: "/tmp/repo",
    });

    db.upsertSession("sess-1", project.id, "david", "laptop", "claude-code");
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
      title: "Fixed auth redirect",
      files_modified: JSON.stringify(["src/auth.ts"]),
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 1,
    });
    db.insertSessionSummary({
      session_id: "sess-1",
      project_id: project.id,
      user_id: "david",
      request: "Fix auth flow",
      investigated: null,
      learned: "Cookie domain mismatch",
      completed: "Added cookie fix",
      next_steps: null,
    });
    db.incrementSessionMetrics("sess-1", { toolCalls: 1, files: 1 });
    db.insertChatMessage({
      session_id: "sess-1",
      project_id: project.id,
      role: "assistant",
      content: "I fixed the auth redirect and the transcript-backed thread should be resumable.",
      user_id: "david",
      device_id: "laptop",
      agent: "claude-code",
      source_kind: "transcript",
      transcript_index: 1,
    });

    const story = getSessionStory(db, { session_id: "sess-1" });
    expect(story.session?.session_id).toBe("sess-1");
    expect(story.prompts).toHaveLength(1);
    expect(story.tool_events).toHaveLength(1);
    expect(story.observations).toHaveLength(1);
    expect(story.summary?.request).toBe("Fix auth flow");
    expect(story.chat_messages).toHaveLength(1);
    expect(story.chat_source_summary).toEqual({ transcript: 1, history: 0, hook: 0 });
    expect(story.chat_coverage_state).toBe("transcript-backed");
    expect(story.metrics?.tool_calls_count).toBe(1);
    expect(story.capture_state).toBe("rich");
    expect(story.capture_gaps).toEqual([]);
    expect(story.project_name).toBe("repo");
    expect(story.latest_request).toBe("Fix auth flow");
    expect(story.recent_outcomes).toContain("Fixed auth redirect");
    expect(story.hot_files).toEqual([{ path: "src/auth.ts", count: 1 }]);
    expect(story.provenance_summary).toEqual([{ tool: "Edit", count: 1 }]);
    expect(story.handoffs).toEqual([]);
  });

  test("separates explicit handoffs from reusable observations", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: tmpDir,
    });

    db.upsertSession("sess-2", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-2",
      project_id: project.id,
      prompt: "Get the events feed plumbed into chat actions.",
      cwd: tmpDir,
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-2",
      project_id: project.id,
      type: "feature",
      title: "Plumbed the events feed into the chat action path",
      quality: 0.9,
      user_id: "david",
      device_id: "laptop",
      source_tool: "Edit",
      source_prompt_number: 1,
    });
    db.upsertSessionSummary({
      session_id: "sess-2",
      project_id: project.id,
      user_id: "david",
      request: "Get the events feed plumbed into chat actions.",
      completed: "Plumbed the events feed into the chat action path.",
      current_thread: "Events feed into chat actions",
    });

    const handoff = await createHandoff(db, config, {
      session_id: "sess-2",
      cwd: tmpDir,
    });

    expect(handoff.success).toBe(true);

    const story = getSessionStory(db, { session_id: "sess-2" });
    expect(story.observations).toHaveLength(1);
    expect(story.handoffs).toHaveLength(1);
    expect(story.saved_handoffs).toHaveLength(1);
    expect(story.rolling_handoff_drafts).toHaveLength(0);
    expect(story.handoffs[0]?.title.startsWith("Handoff:")).toBe(true);
  });

  test("separates rolling handoff drafts from saved handoffs", async () => {
    const project = db.upsertProject({
      canonical_id: "local/repo",
      name: "repo",
      local_path: tmpDir,
    });

    db.upsertSession("sess-3", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-3",
      project_id: project.id,
      prompt: "Keep the current thread resumable across machines.",
      cwd: tmpDir,
      user_id: "david",
      device_id: "laptop",
    });
    db.upsertSessionSummary({
      session_id: "sess-3",
      project_id: project.id,
      user_id: "david",
      request: "Keep the current thread resumable across machines.",
      completed: null,
      next_steps: null,
      current_thread: "Current thread resumable across machines",
      capture_state: "partial",
      recent_tool_names: JSON.stringify([]),
      hot_files: JSON.stringify([]),
      recent_outcomes: JSON.stringify([]),
    });

    await upsertRollingHandoff(db, config, {
      session_id: "sess-3",
      cwd: tmpDir,
    });
    await createHandoff(db, config, {
      session_id: "sess-3",
      cwd: tmpDir,
    });

    const story = getSessionStory(db, { session_id: "sess-3" });
    expect(story.handoffs).toHaveLength(2);
    expect(story.saved_handoffs).toHaveLength(1);
    expect(story.rolling_handoff_drafts).toHaveLength(1);
    expect(story.rolling_handoff_drafts[0]?.title.startsWith("Handoff Draft:")).toBe(true);
  });
});
