/**
 * capture_quality MCP tool.
 *
 * Gives a workspace-wide view of memory capture quality across projects:
 * chronology richness, assistant checkpoints, and dominant provenance tools.
 */

import type { MemDatabase } from "../storage/sqlite.js";
import { getWorkspaceMemoryIndex } from "./workspace-memory-index.js";
import { getRecentSessions } from "./recent-sessions.js";

export interface CaptureQualityInput {
  limit?: number;
  user_id?: string;
}

export interface CaptureQualityResult {
  totals: {
    projects: number;
    observations: number;
    sessions: number;
    prompts: number;
    tool_events: number;
    assistant_checkpoints: number;
  };
  session_states: {
    rich: number;
    partial: number;
    summary_only: number;
    legacy: number;
  };
  projects_with_raw_capture: number;
  provenance_summary: Array<{ tool: string; count: number }>;
  top_projects: Array<{
    name: string;
    canonical_id: string;
    observation_count: number;
    session_count: number;
    prompt_count: number;
    tool_event_count: number;
    assistant_checkpoint_count: number;
    raw_capture_state: "rich" | "partial" | "summary-only";
  }>;
}

export function getCaptureQuality(
  db: MemDatabase,
  input: CaptureQualityInput = {}
): CaptureQualityResult {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
  const workspace = getWorkspaceMemoryIndex(db, {
    limit,
    user_id: input.user_id,
  });

  const allSessions = getRecentSessions(db, {
    limit: 200,
    project_scoped: false,
    user_id: input.user_id,
  }).sessions;

  const sessionStates = {
    rich: allSessions.filter((s) => s.capture_state === "rich").length,
    partial: allSessions.filter((s) => s.capture_state === "partial").length,
    summary_only: allSessions.filter((s) => s.capture_state === "summary-only").length,
    legacy: allSessions.filter((s) => s.capture_state === "legacy").length,
  };

  const topProjects = workspace.projects.slice(0, limit).map((project) => ({
    name: project.name,
    canonical_id: project.canonical_id,
    observation_count: project.observation_count,
    session_count: project.session_count,
    prompt_count: project.prompt_count,
    tool_event_count: project.tool_event_count,
    assistant_checkpoint_count: project.assistant_checkpoint_count,
    raw_capture_state:
      project.prompt_count > 0 && project.tool_event_count > 0
        ? "rich"
        : project.prompt_count > 0 || project.tool_event_count > 0
          ? "partial"
          : "summary-only",
  }));

  return {
    totals: {
      projects: workspace.projects.length,
      observations: workspace.totals.observations,
      sessions: workspace.totals.sessions,
      prompts: workspace.totals.prompts,
      tool_events: workspace.totals.tool_events,
      assistant_checkpoints: workspace.totals.assistant_checkpoints,
    },
    session_states: sessionStates,
    projects_with_raw_capture: workspace.projects_with_raw_capture,
    provenance_summary: workspace.provenance_summary,
    top_projects: topProjects,
  };
}
