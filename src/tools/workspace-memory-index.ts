/**
 * workspace_memory_index MCP tool.
 *
 * Cross-project local overview for testing Engrm's broader memory graph.
 */

import type { MemDatabase } from "../storage/sqlite.js";

export interface WorkspaceMemoryProject {
  canonical_id: string;
  name: string;
  observation_count: number;
  session_count: number;
  prompt_count: number;
  tool_event_count: number;
  assistant_checkpoint_count: number;
  last_active_epoch: number;
}

export interface WorkspaceMemoryIndexInput {
  limit?: number;
  user_id?: string;
}

export interface WorkspaceMemoryIndexResult {
  projects: WorkspaceMemoryProject[];
  totals: {
    observations: number;
    sessions: number;
    prompts: number;
    tool_events: number;
    assistant_checkpoints: number;
  };
  projects_with_raw_capture: number;
  provenance_summary: Array<{ tool: string; count: number }>;
}

export function getWorkspaceMemoryIndex(
  db: MemDatabase,
  input: WorkspaceMemoryIndexInput
): WorkspaceMemoryIndexResult {
  const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
  const visibilityClause = input.user_id
    ? " AND (o.sensitivity != 'personal' OR o.user_id = ?)"
    : "";

  const projects = db.db
    .query<WorkspaceMemoryProject, (string | number)[]>(
      `SELECT
         p.canonical_id,
         p.name,
         (
           SELECT COUNT(*) FROM observations o
           WHERE o.project_id = p.id
             AND o.lifecycle IN ('active', 'aging', 'pinned')
             AND o.superseded_by IS NULL
             ${visibilityClause}
         ) AS observation_count,
         (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
         (SELECT COUNT(*) FROM user_prompts up WHERE up.project_id = p.id) AS prompt_count,
         (SELECT COUNT(*) FROM tool_events te WHERE te.project_id = p.id) AS tool_event_count,
         (
           SELECT COUNT(*) FROM observations o
           WHERE o.project_id = p.id
             AND o.source_tool = 'assistant-stop'
             AND o.lifecycle IN ('active', 'aging', 'pinned')
             AND o.superseded_by IS NULL
             ${visibilityClause}
         ) AS assistant_checkpoint_count,
         p.last_active_epoch
       FROM projects p
       ORDER BY p.last_active_epoch DESC
       LIMIT ?`
    )
    .all(...(input.user_id ? [input.user_id, input.user_id, limit] : [limit]));

  const totals = projects.reduce(
    (acc, project) => {
      acc.observations += project.observation_count;
      acc.sessions += project.session_count;
      acc.prompts += project.prompt_count;
      acc.tool_events += project.tool_event_count;
      acc.assistant_checkpoints += project.assistant_checkpoint_count;
      return acc;
    },
    { observations: 0, sessions: 0, prompts: 0, tool_events: 0, assistant_checkpoints: 0 }
  );

  const visibilityClauseForProvenance = input.user_id
    ? " AND (sensitivity != 'personal' OR user_id = ?)"
    : "";
  const provenanceRows = db.db
    .query<{ source_tool: string; count: number }, (string | number)[]>(
      `SELECT source_tool, COUNT(*) as count
       FROM observations
       WHERE source_tool IS NOT NULL
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         ${visibilityClauseForProvenance}
       GROUP BY source_tool
       ORDER BY count DESC, source_tool ASC
       LIMIT 8`
    )
    .all(...(input.user_id ? [input.user_id] : []));

  return {
    projects,
    totals,
    projects_with_raw_capture: projects.filter(
      (project) => project.prompt_count > 0 || project.tool_event_count > 0
    ).length,
    provenance_summary: provenanceRows.map((row) => ({
      tool: row.source_tool,
      count: row.count,
    })),
  };
}
