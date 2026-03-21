import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { buildChatVectorDocument, buildSummaryVectorDocument, buildVectorDocument } from "./push.js";

let db: MemDatabase;
let tmpDir: string;
let projectId: number;

function makeConfig(): Config {
  return {
    candengo_url: "https://candengo.com",
    candengo_api_key: "cvk_test123",
    site_id: "test-site",
    namespace: "dev-memory",
    user_id: "david",
    device_id: "laptop-abc",
    user_email: "",
    teams: [],
    sync: { enabled: true, interval_seconds: 30, batch_size: 50 },
    search: { default_limit: 10, local_boost: 1.2, scope: "all" },
    scrubbing: { enabled: true, custom_patterns: [], default_sensitivity: "shared" },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "candengo-push-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  const project = db.upsertProject({
    canonical_id: "github.com/test/repo",
    name: "repo",
  });
  projectId = project.id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildVectorDocument", () => {
  test("produces correct structure", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "bugfix",
      title: "Fixed auth bug",
      narrative: "The auth was broken due to a type mismatch",
      facts: '["fact1", "fact2"]',
      concepts: '["auth", "debugging"]',
      quality: 0.8,
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
      source_tool: "Edit",
      source_prompt_number: 2,
    });

    const doc = buildVectorDocument(obs, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.site_id).toBe("test-site");
    expect(doc.namespace).toBe("dev-memory");
    expect(doc.source_type).toBe("bugfix");
    expect(doc.source_id).toBe(`david-laptop-abc-obs-${obs.id}`);
    expect(doc.content).toContain("Fixed auth bug");
    expect(doc.content).toContain("The auth was broken");
    expect(doc.content).toContain("- fact1");
    expect(doc.content).toContain("- fact2");
    expect(doc.metadata.project_canonical).toBe("github.com/test/repo");
    expect(doc.metadata.quality).toBe(0.8);
    expect(doc.metadata.user_id).toBe("david");
    expect(doc.metadata.source_tool).toBe("Edit");
    expect(doc.metadata.source_prompt_number).toBe(2);
  });

  test("handles observation with no narrative or facts", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "change",
      title: "Simple change",
      quality: 0.3,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const doc = buildVectorDocument(obs, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.content).toBe("Simple change");
    expect(doc.metadata.title).toBe("Simple change");
  });

  test("includes files_modified in metadata", () => {
    const obs = db.insertObservation({
      project_id: projectId,
      type: "change",
      title: "Edit file",
      files_modified: '["src/main.ts", "src/utils.ts"]',
      quality: 0.5,
      user_id: "david",
      device_id: "laptop-abc",
    });

    const doc = buildVectorDocument(obs, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.metadata.files_modified).toEqual([
      "src/main.ts",
      "src/utils.ts",
    ]);
  });
});

describe("buildSummaryVectorDocument", () => {
  test("includes structured summary items and value signals", () => {
    const summary = db.insertSessionSummary({
      session_id: "sess-123",
      project_id: projectId,
      user_id: "david",
      request: "Improve local memory ranking",
      investigated: "- Traced low-value digests in startup brief",
      learned: "- Decisions and patterns should outrank generic changes",
      completed: "- Added shared observation priority model",
      next_steps: "- Follow through: wire richer summaries into sync",
    });

    const observations = [
      db.insertObservation({
        session_id: "sess-123",
        project_id: projectId,
        type: "decision",
        title: "Prefer higher-value memory objects",
        quality: 0.8,
        user_id: "david",
        device_id: "laptop-abc",
        source_tool: "Edit",
        source_prompt_number: 1,
      }),
      db.insertObservation({
        session_id: "sess-123",
        project_id: projectId,
        type: "feature",
        title: "Added richer search previews",
        quality: 0.7,
        user_id: "david",
        device_id: "laptop-abc",
        source_tool: "Bash",
        source_prompt_number: 1,
      }),
      db.insertObservation({
        session_id: "sess-123",
        project_id: projectId,
        type: "pattern",
        title: "Digest-heavy sessions hide useful lessons",
        quality: 0.7,
        user_id: "david",
        device_id: "laptop-abc",
        source_tool: "assistant-stop",
        source_prompt_number: 1,
      }),
      db.insertObservation({
        session_id: "sess-123",
        project_id: projectId,
        type: "change",
        title: "Exposed per-project insights endpoint",
        files_modified: JSON.stringify(["app/services/mem_insights.py"]),
        quality: 0.7,
        user_id: "david",
        device_id: "laptop-abc",
        source_tool: "Edit",
        source_prompt_number: 1,
      }),
    ];

    const doc = buildSummaryVectorDocument(summary, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    }, observations, {
      prompt_count: 1,
      tool_event_count: 1,
      capture_state: "rich",
      recent_request_prompts: ["Improve local memory ranking"],
      latest_request: "Improve local memory ranking",
      recent_tool_names: ["Edit"],
      recent_tool_commands: ["app/services/mem_insights.py"],
      hot_files: ["app/services/mem_insights.py"],
      recent_outcomes: ["Exposed per-project insights endpoint"],
    });

    expect(doc.source_type).toBe("summary");
    expect(doc.content).toContain("Request: Improve local memory ranking");
    expect(doc.metadata.summary_sections_present).toBe(5);
    expect(doc.metadata.learned_items).toEqual([
      "Decisions and patterns should outrank generic changes",
    ]);
    expect(doc.metadata.completed_items).toEqual([
      "Added shared observation priority model",
    ]);
    expect(doc.metadata.next_step_items).toEqual([
      "Follow through: wire richer summaries into sync",
    ]);
    expect(doc.metadata.prompt_count).toBe(1);
    expect(doc.metadata.tool_event_count).toBe(1);
    expect(doc.metadata.capture_state).toBe("rich");
    expect(doc.metadata.recent_request_prompts).toEqual([
      "Improve local memory ranking",
    ]);
    expect(doc.metadata.latest_request).toBe("Improve local memory ranking");
    expect(doc.metadata.recent_tool_names).toEqual(["Edit"]);
    expect(doc.metadata.recent_tool_commands).toEqual(["app/services/mem_insights.py"]);
    expect(doc.metadata.hot_files).toEqual(["app/services/mem_insights.py"]);
    expect(doc.metadata.recent_outcomes).toEqual(["Exposed per-project insights endpoint"]);
    expect(doc.metadata.observation_source_tools).toEqual([
      { tool: "Edit", count: 2 },
      { tool: "assistant-stop", count: 1 },
      { tool: "Bash", count: 1 },
    ]);
    expect(doc.metadata.latest_observation_prompt_number).toBe(1);
    expect(doc.metadata.decisions_count).toBe(1);
    expect(doc.metadata.features_count).toBe(1);
    expect(doc.metadata.repeated_patterns_count).toBe(1);
    expect(doc.metadata.delivery_review_ready).toBe(true);
  });

  test("normalizes duplicated headed completed blobs into distinct items", () => {
    const summary = db.insertSessionSummary({
      session_id: "sess-blob",
      project_id: projectId,
      user_id: "david",
      request: "Deactivate Bedford Hotel on staging",
      investigated: null,
      learned: null,
      completed: `**Deployment:**
- Pushed commit 5fc897c to staging branch
- Ansible deployment completed successfully

**Background processing impact:**
- Bedford Hotel will now be skipped by intelligence_briefing_loop
- Bedford Hotel will now be skipped by vulnerability_scheduler_loop

**Deployment:**
- Pushed commit 5fc897c to staging branch`,
      next_steps: null,
    });

    const doc = buildSummaryVectorDocument(summary, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.metadata.completed_items).toEqual([
      "Deployment: Pushed commit 5fc897c to staging branch",
      "Deployment: Ansible deployment completed successfully",
      "Background processing impact: Bedford Hotel will now be skipped by intelligence_briefing_loop",
      "Background processing impact: Bedford Hotel will now be skipped by vulnerability_scheduler_loop",
    ]);
  });
});

describe("buildChatVectorDocument", () => {
  test("produces a syncable chat document", () => {
    const chat = db.insertChatMessage({
      session_id: "sess-chat",
      project_id: projectId,
      role: "user",
      content: "Can we make the events feed drive chat actions too?",
      user_id: "david",
      device_id: "laptop-abc",
      agent: "claude-code",
    });

    const doc = buildChatVectorDocument(chat, makeConfig(), {
      canonical_id: "github.com/test/repo",
      name: "repo",
    });

    expect(doc.source_type).toBe("chat");
    expect(doc.source_id).toBe(`david-laptop-abc-chat-${chat.id}`);
    expect(doc.content).toBe("Can we make the events feed drive chat actions too?");
    expect(doc.metadata.role).toBe("user");
    expect(doc.metadata.session_id).toBe("sess-chat");
    expect(doc.metadata.project_canonical).toBe("github.com/test/repo");
  });
});
