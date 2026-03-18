/**
 * recent_activity MCP tool.
 *
 * Provides a lightweight visibility layer so users can inspect what Engrm
 * has captured recently without running a search query.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase, ObservationRow } from "../storage/sqlite.js";

export interface RecentObservationRow extends ObservationRow {
  project_name?: string | null;
}

export interface RecentActivityInput {
  limit?: number;
  project_scoped?: boolean;
  type?: string;
  cwd?: string;
  user_id?: string;
}

export interface RecentActivityResult {
  observations: RecentObservationRow[];
  project?: string;
}

export function getRecentActivity(
  db: MemDatabase,
  input: RecentActivityInput
): RecentActivityResult {
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

  const params: Array<string | number> = [];
  const conditions = [
    "lifecycle IN ('active', 'aging', 'pinned')",
    "superseded_by IS NULL",
  ];

  if (input.user_id) {
    conditions.push("(sensitivity != 'personal' OR user_id = ?)");
    params.push(input.user_id);
  }

  if (projectId !== null) {
    conditions.push("project_id = ?");
    params.push(projectId);
  }

  if (input.type) {
    conditions.push("type = ?");
    params.push(input.type);
  }

  params.push(limit);

  const observations = db.db
    .query<RecentObservationRow, Array<string | number>>(
      `SELECT observations.*, projects.name AS project_name
       FROM observations
       LEFT JOIN projects ON projects.id = observations.project_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY observations.created_at_epoch DESC
       LIMIT ?`
    )
    .all(...params);

  return {
    observations,
    project: projectName,
  };
}
