/**
 * recent_requests MCP tool.
 *
 * Surfaces raw user prompt chronology so agents can inspect what the user
 * actually asked for recently, not just the observations Engrm derived later.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, UserPromptRow } from "../storage/sqlite.js";

export interface RecentRequestsInput {
  limit?: number;
  project_scoped?: boolean;
  session_id?: string;
  cwd?: string;
  user_id?: string;
}

export interface RecentRequestsResult {
  prompts: UserPromptRow[];
  project?: string;
}

export function getRecentRequests(
  db: MemDatabase,
  input: RecentRequestsInput
): RecentRequestsResult {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));

  if (input.session_id) {
    return {
      prompts: db.getSessionUserPrompts(input.session_id, limit).slice(-limit).reverse(),
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
    prompts: db.getRecentUserPrompts(projectId, limit, input.user_id),
    project: projectName,
  };
}
