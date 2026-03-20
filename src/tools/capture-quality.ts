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
  provenance_type_mix: Array<{
    tool: string;
    count: number;
    top_types: Array<{ type: string; count: number }>;
  }>;
  assistant_checkpoint_types: Array<{ type: string; count: number }>;
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

  const checkpointTypeRows = db.db
    .query<{ type: string; count: number }, (string | number)[]>(
      `SELECT type, COUNT(*) as count
       FROM observations
       WHERE source_tool = 'assistant-stop'
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         ${input.user_id ? " AND (sensitivity != 'personal' OR user_id = ?)" : ""}
       GROUP BY type
       ORDER BY count DESC, type ASC
       LIMIT 8`
    )
    .all(...(input.user_id ? [input.user_id] : []));

  const provenanceTypeRows = db.db
    .query<{ source_tool: string; type: string; count: number }, (string | number)[]>(
      `SELECT source_tool, type, COUNT(*) as count
       FROM observations
       WHERE source_tool IS NOT NULL
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         ${input.user_id ? " AND (sensitivity != 'personal' OR user_id = ?)" : ""}
       GROUP BY source_tool, type
       ORDER BY source_tool ASC, count DESC, type ASC`
    )
    .all(...(input.user_id ? [input.user_id] : []));

  const provenanceTypeMix = Array.from(
    provenanceTypeRows.reduce((acc, row) => {
      const group = acc.get(row.source_tool) ?? [];
      group.push({ type: row.type, count: row.count });
      acc.set(row.source_tool, group);
      return acc;
    }, new Map<string, Array<{ type: string; count: number }>>()).entries()
  )
    .map(([tool, topTypes]) => ({
      tool,
      count: topTypes.reduce((sum, item) => sum + item.count, 0),
      top_types: topTypes.slice(0, 4),
    }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, 8);

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
    provenance_type_mix: provenanceTypeMix,
    assistant_checkpoint_types: checkpointTypeRows.map((row) => ({
      type: row.type,
      count: row.count,
    })),
    top_projects: topProjects,
  };
}
