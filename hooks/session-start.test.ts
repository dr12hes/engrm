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

    expect(lines.some((line) => line.includes("Recent Requests:"))).toBe(true);
    expect(lines.some((line) => line.includes("Current Request:"))).toBe(false);
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

    const recentWorkIndex = lines.findIndex((line) => line.includes("Recent Work:"));
    const recentSessionsIndex = lines.findIndex((line) => line.includes("Recent Sessions:"));

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

    expect(lines.some((line) => line.includes("Recent Tools:"))).toBe(true);
    expect(lines.join("\n")).toContain("pytest tests/test_mem_insights.py");
  });
});
