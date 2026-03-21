import { describe, expect, test } from "bun:test";
import { __testables } from "./session-start.js";
import type { InjectedContext } from "../src/context/inject.js";

function makeContext(overrides: Partial<InjectedContext> = {}): InjectedContext {
  return {
    project_name: "huginn",
    canonical_id: "github.com/dr12hes/huginn",
    observations: [],
    session_count: 2,
    total_active: 89,
    ...overrides,
  };
}

describe("session-start startup brief", () => {
  test("does not repeat current request when it already appears in recent requests", () => {
    const lines = __testables.formatVisibleStartupBrief(
      makeContext({
        recentPrompts: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            prompt_number: 1,
            prompt: "why is engrm mcp not connecting",
            prompt_hash: "hash",
            cwd: "/Volumes/Data/devs/huginn",
            user_id: "david",
            device_id: "BackupMac",
            agent: "claude-code",
            created_at_epoch: 1,
          },
        ],
      })
    );

    expect(lines.some((line) => line.includes("Asked recently:"))).toBe(true);
    expect(lines.some((line) => line.includes("What you're on:"))).toBe(false);
  });

  test("shows recent work from summary outcomes before generic session rollups", () => {
    const lines = __testables.formatVisibleStartupBrief(
      makeContext({
        summaries: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            request: "Investigate topology routing",
            investigated: null,
            learned: "SmoothStep was breaking mid-node routing for dragged switches",
            completed: "Replaced broken ELK edge rendering with ReactFlow path computation",
            next_steps: null,
            created_at_epoch: 1,
            source_observation_id: null,
          },
        ],
        recentSessions: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            user_id: "david",
            device_id: "BackupMac",
            agent: "claude-code",
            status: "active",
            observation_count: 3,
            started_at_epoch: 1,
            completed_at_epoch: 2,
            project_name: "huginn",
            request: "Investigate topology routing",
            completed: "Replaced broken ELK edge rendering with ReactFlow path computation",
            prompt_count: 1,
            tool_event_count: 2,
          },
        ],
      })
    );

    const recentWorkIndex = lines.findIndex((line) => line.includes("What's moved:"));
    const recentSessionsIndex = lines.findIndex((line) => line.includes("Recent threads:"));

    expect(recentWorkIndex).toBeGreaterThan(-1);
    expect(lines.join("\n")).toContain("Replaced broken ELK edge rendering with ReactFlow path computation");
    expect(recentSessionsIndex).toBeGreaterThan(recentWorkIndex);
  });

  test("suppresses next steps that only repeat completed work", () => {
    const lines = __testables.formatVisibleStartupBrief(
      makeContext({
        summaries: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            request: "Improve insights messaging",
            investigated: null,
            learned: "Fixed team ID field reference in insights page initialization",
            completed: "Exposed per-project insights as REST API endpoint",
            next_steps: "Investigate: Fixed team ID field reference in insights page initialization",
            created_at_epoch: 1,
            source_observation_id: null,
          },
        ],
      })
    );

    expect(lines.some((line) => line.includes("Next Steps:"))).toBe(false);
  });

  test("shows recent tools only when they add new information", () => {
    const lines = __testables.formatVisibleStartupBrief(
      makeContext({
        summaries: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            request: "Update mem insights endpoint",
            investigated: null,
            learned: null,
            completed: "Exposed per-project insights as REST API endpoint",
            next_steps: null,
            created_at_epoch: 1,
            source_observation_id: null,
          },
        ],
        recentToolEvents: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            tool_name: "Bash",
            tool_input_json: null,
            tool_response_preview: null,
            file_path: null,
            command: "pytest tests/test_mem_insights.py",
            user_id: "david",
            device_id: "BackupMac",
            agent: "claude-code",
            created_at_epoch: 1,
          },
        ],
      })
    );

    expect(lines.some((line) => line.includes("Tool trail:"))).toBe(true);
    expect(lines.join("\n")).toContain("pytest tests/test_mem_insights.py");
  });

  test("falls back to synced session metadata when local tool chronology is absent", () => {
    const lines = __testables.formatVisibleStartupBrief(
      makeContext({
        recentSessions: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            user_id: "david",
            device_id: "Laptop",
            agent: "claude-code",
            status: "active",
            observation_count: 2,
            started_at_epoch: 1,
            completed_at_epoch: 2,
            project_name: "huginn",
            request: "Wire up event data",
            completed: null,
            capture_state: "partial",
            recent_tool_names: JSON.stringify(["Edit", "Bash"]),
            hot_files: JSON.stringify(["AIServer/app/routers/events.py"]),
            recent_outcomes: JSON.stringify(["Wired event data into existing event log"]),
            prompt_count: 2,
            tool_event_count: 0,
          },
        ],
      })
    );

    expect(lines.some((line) => line.includes("Tool trail:"))).toBe(true);
    expect(lines.join("\n")).toContain("Edit");
    expect(lines.join("\n")).toContain("Wired event data into existing event log");
  });

  test("filters generic summary wrapper lines from recent work", () => {
    const lines = __testables.formatVisibleStartupBrief(
      makeContext({
        observations: [
          {
            id: 1,
            type: "change",
            title: "All clean. Here's a summary of what was fixed:",
            narrative: null,
            facts: null,
            files_read: null,
            files_modified: null,
            quality: 0.8,
            created_at: "2026-03-21T18:00:00Z",
            source_project: undefined,
          },
          {
            id: 2,
            type: "feature",
            title: "IFTTT actions now actually execute",
            narrative: null,
            facts: null,
            files_read: null,
            files_modified: null,
            quality: 0.8,
            created_at: "2026-03-21T18:01:00Z",
            source_project: undefined,
          },
        ],
      })
    );

    expect(lines.join("\n")).not.toContain("All clean. Here's a summary of what was fixed:");
    expect(lines.join("\n")).toContain("IFTTT actions now actually execute");
  });

  test("startup splash shows context economics and inspect hints", () => {
    const splash = __testables.formatSplashScreen({
      projectName: "huginn",
      loaded: 3,
      available: 86,
      securityFindings: 0,
      unreadMessages: 0,
      synced: 0,
      estimatedReadTokens: 420,
      context: makeContext({
        recentPrompts: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            prompt_number: 1,
            prompt: "Fix topology routing",
            prompt_hash: "hash",
            cwd: "/Volumes/Data/devs/huginn",
            user_id: "david",
            device_id: "BackupMac",
            agent: "claude-code",
            created_at_epoch: 1,
          },
        ],
        recentSessions: [
          {
            id: 1,
            session_id: "sess-1",
            project_id: 1,
            user_id: "david",
            device_id: "BackupMac",
            agent: "claude-code",
            status: "active",
            observation_count: 3,
            started_at_epoch: 1,
            completed_at_epoch: 2,
            project_name: "huginn",
            request: "Fix topology routing",
            completed: "Replaced broken ELK edge rendering",
            prompt_count: 1,
            tool_event_count: 2,
          },
        ],
      }),
    });

    expect(splash).toContain("Context economics:");
    expect(splash).toContain("89 total memories");
    expect(splash).toContain("read now ~420t");
    expect(splash).toContain("Handoff");
    expect(splash).toContain("Legend:");
    expect(splash).toContain("Handoff index:");
    expect(splash).toContain("Next look:");
    expect(splash).toContain("Pull detail:");
    expect(splash).toContain("recent_sessions");
    expect(splash).toContain("activity_feed");
  });

  test("context index shows ids, icons, and file hints", () => {
    const splash = __testables.formatSplashScreen({
      projectName: "huginn",
      loaded: 2,
      available: 10,
      securityFindings: 0,
      unreadMessages: 0,
      synced: 0,
      estimatedReadTokens: 220,
      context: makeContext({
        observations: [
          {
            id: 12833,
            type: "change",
            title: "Scanner Plugin Development Guide",
            narrative: null,
            facts: null,
            files_read: null,
            files_modified: JSON.stringify(["docs/plugins/README.md"]),
            quality: 0.8,
            created_at: "2026-03-21T10:35:00Z",
            source_project: undefined,
          },
          {
            id: 12834,
            type: "decision",
            title: "Connector Manifest Guide for Signal Bus Integration",
            narrative: null,
            facts: null,
            files_read: null,
            files_modified: JSON.stringify(["docs/connectors/manifest-guide.md"]),
            quality: 0.79,
            created_at: "2026-03-21T10:36:00Z",
            source_project: undefined,
          },
        ],
      }),
    });

    expect(splash).toContain("#12833");
    expect(splash).toContain("●");
    expect(splash).toContain("docs/plugins/README.md");
    expect(splash).toContain("#12834");
    expect(splash).toContain("◇");
    expect(splash).toContain("docs/connectors/manifest-guide.md");
  });

  test("pull detail ids match the visible handoff index rows", () => {
    const splash = __testables.formatSplashScreen({
      projectName: "huginn",
      loaded: 2,
      available: 10,
      securityFindings: 0,
      unreadMessages: 0,
      synced: 0,
      estimatedReadTokens: 220,
      context: makeContext({
        observations: [
          {
            id: 2001,
            type: "feature",
            title: "Added event log plumbing for nav item",
            narrative: null,
            facts: null,
            files_read: null,
            files_modified: JSON.stringify(["admin/src/nav.tsx"]),
            quality: 0.9,
            created_at: "2026-03-21T10:35:00Z",
            source_project: undefined,
          },
          {
            id: 2002,
            type: "change",
            title: "Requested events now feed the existing event log",
            narrative: null,
            facts: null,
            files_read: null,
            files_modified: JSON.stringify(["admin/src/pages/events.tsx"]),
            quality: 0.8,
            created_at: "2026-03-21T10:36:00Z",
            source_project: undefined,
          },
        ],
      }),
    });

    expect(splash).toContain("#2001");
    expect(splash).toContain("#2002");
    expect(splash).toContain("get_observations([2001, 2002])");
  });
});
