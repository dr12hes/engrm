/**
 * project_memory_index MCP tool.
 *
 * Gives a structured local overview of a project's captured memory:
 * observation types, recent sessions, prompt/tool volume, and hot files.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, ObservationRow, RecentSessionRow } from "../storage/sqlite.js";
import { getRecentSessions } from "./recent-sessions.js";
import { getRecentRequests } from "./recent-prompts.js";
import { getRecentTools } from "./recent-tools.js";

export interface ProjectMemoryIndexInput {
  cwd?: string;
  user_id?: string;
}

export interface ProjectMemoryIndexResult {
  project: string;
  canonical_id: string;
  observation_counts: Record<string, number>;
  recent_sessions: RecentSessionRow[];
  recent_requests_count: number;
  recent_tools_count: number;
  raw_capture_active: boolean;
  hot_files: Array<{ path: string; count: number }>;
  top_titles: Array<{ type: string; title: string; id: number }>;
}

export function getProjectMemoryIndex(
  db: MemDatabase,
  input: ProjectMemoryIndexInput
): ProjectMemoryIndexResult | null {
  const cwd = input.cwd ?? process.cwd();
  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);
  if (!project) return null;

  const visibilityClause = input.user_id
    ? " AND (sensitivity != 'personal' OR user_id = ?)"
    : "";
  const visibilityParams = input.user_id ? [input.user_id] : [];

  const observations = db.db
    .query<ObservationRow, (number | string)[]>(
      `SELECT * FROM observations
       WHERE project_id = ?
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         ${visibilityClause}
       ORDER BY created_at_epoch DESC`
    )
    .all(project.id, ...visibilityParams);

  const counts: Record<string, number> = {};
  for (const obs of observations) {
    counts[obs.type] = (counts[obs.type] ?? 0) + 1;
  }

  const fileCounts = new Map<string, number>();
  for (const obs of observations) {
    for (const path of extractPaths(obs.files_modified)) {
      fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
    }
  }

  const hotFiles = Array.from(fileCounts.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 8);

  const topTitles = observations
    .slice(0, 12)
    .map((obs) => ({
      type: obs.type,
      title: obs.title,
      id: obs.id,
    }));

  const recentSessions = getRecentSessions(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 6,
  }).sessions;
  const recentRequestsCount = getRecentRequests(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 20,
  }).prompts.length;
  const recentToolsCount = getRecentTools(db, {
    cwd,
    project_scoped: true,
    user_id: input.user_id,
    limit: 20,
  }).tool_events.length;

  return {
    project: project.name,
    canonical_id: project.canonical_id,
    observation_counts: counts,
    recent_sessions: recentSessions,
    recent_requests_count: recentRequestsCount,
    recent_tools_count: recentToolsCount,
    raw_capture_active: recentRequestsCount > 0 || recentToolsCount > 0,
    hot_files: hotFiles,
    top_titles: topTitles,
  };
}

function extractPaths(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}
