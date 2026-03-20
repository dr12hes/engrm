/**
 * recent_tools MCP tool.
 *
 * Shows recent raw tool chronology so agents can inspect what work actually
 * happened before reduction into observations/summaries.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, ToolEventRow } from "../storage/sqlite.js";

export interface RecentToolsInput {
  limit?: number;
  project_scoped?: boolean;
  session_id?: string;
  cwd?: string;
  user_id?: string;
}

export interface RecentToolsResult {
  tool_events: ToolEventRow[];
  project?: string;
}

export function getRecentTools(
  db: MemDatabase,
  input: RecentToolsInput
): RecentToolsResult {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));

  if (input.session_id) {
    return {
      tool_events: db.getSessionToolEvents(input.session_id, limit).slice(-limit).reverse(),
    };
  }

  const projectScoped = input.project_scoped !== false;
  let projectId: number | null = null;
  let projectName: string | undefined;

  if (projectScoped) {
    const cwd = input.cwd ?? process.cwd();
    const detected = detectProject(cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);
    if (project) {
      projectId = project.id;
      projectName = project.name;
    }
  }

  return {
    tool_events: db.getRecentToolEvents(projectId, limit, input.user_id),
    project: projectName,
  };
}
