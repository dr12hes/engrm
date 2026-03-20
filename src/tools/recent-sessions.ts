/**
 * recent_sessions MCP tool.
 *
 * Lists the latest local sessions with enough metadata to decide which one
 * to inspect in detail via session_story.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, RecentSessionRow } from "../storage/sqlite.js";

export interface RecentSessionView extends RecentSessionRow {
  capture_state: "rich" | "partial" | "summary-only" | "legacy";
}

export interface RecentSessionsInput {
  limit?: number;
  project_scoped?: boolean;
  cwd?: string;
  user_id?: string;
}

export interface RecentSessionsResult {
  sessions: RecentSessionView[];
  project?: string;
}

export function getRecentSessions(
  db: MemDatabase,
  input: RecentSessionsInput
): RecentSessionsResult {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
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
    sessions: db.getRecentSessions(projectId, limit, input.user_id).map((session) => ({
      ...session,
      capture_state: classifyCaptureState(session),
    })),
    project: projectName,
  };
}

function classifyCaptureState(session: RecentSessionRow): RecentSessionView["capture_state"] {
  const hasSummary = Boolean(session.request || session.completed);
  const hasPrompts = session.prompt_count > 0;
  const hasTools = session.tool_event_count > 0;

  if (hasPrompts && hasTools) return "rich";
  if (hasPrompts || hasTools) return hasSummary ? "partial" : "partial";
  if (hasSummary) return "summary-only";
  return "legacy";
}
