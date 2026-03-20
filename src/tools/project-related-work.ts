/**
 * project_related_work MCP tool.
 *
 * Shows memory objects that appear relevant to the current repo/project but are
 * currently stored under other project IDs. Useful for spotting attribution
 * drift in multi-repo sessions.
 */

import { detectProject, type DetectedProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";

export interface ProjectRelatedWorkInput {
  cwd?: string;
  user_id?: string;
  limit?: number;
}

export interface RelatedWorkItem {
  id: number;
  type: string;
  title: string;
  source_project: string;
  source_project_id: number | null;
  matched_on: string;
}

export interface ProjectRelatedWorkResult {
  project: string;
  canonical_id: string;
  related: RelatedWorkItem[];
}

export function getProjectRelatedWork(
  db: MemDatabase,
  input: ProjectRelatedWorkInput
): ProjectRelatedWorkResult {
  const cwd = input.cwd ?? process.cwd();
  const detected = detectProject(cwd);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const visibilityClause = input.user_id
    ? " AND (o.sensitivity != 'personal' OR o.user_id = ?)"
    : "";
  const visibilityParams = input.user_id ? [input.user_id] : [];

  const terms = buildProjectTerms(detected);
  if (terms.length === 0) {
    return {
      project: detected.name,
      canonical_id: detected.canonical_id,
      related: [],
    };
  }

  const localProject = db.getProjectByCanonicalId(detected.canonical_id);
  const localProjectId = localProject?.id ?? -1;

  const params: (string | number)[] = [];
  const whereParts: string[] = [];
  for (const term of terms) {
    const like = `%${term}%`;
    whereParts.push(
      `(LOWER(o.title) LIKE ? OR LOWER(COALESCE(o.narrative, '')) LIKE ? OR LOWER(COALESCE(o.files_read, '')) LIKE ? OR LOWER(COALESCE(o.files_modified, '')) LIKE ?)`
    );
    params.push(like, like, like, like);
  }

  const rows = db.db
    .query<
      {
        id: number;
        type: string;
        title: string;
        source_project_id: number | null;
        source_project: string | null;
        narrative: string | null;
        files_read: string | null;
        files_modified: string | null;
      },
      (string | number)[]
    >(
      `SELECT
         o.id,
         o.type,
         o.title,
         o.project_id as source_project_id,
         p.name as source_project,
         o.narrative,
         o.files_read,
         o.files_modified
       FROM observations o
       LEFT JOIN projects p ON p.id = o.project_id
       WHERE o.project_id != ?
         AND o.lifecycle IN ('active', 'aging', 'pinned')
         AND o.superseded_by IS NULL
         ${visibilityClause}
         AND (${whereParts.join(" OR ")})
       ORDER BY o.created_at_epoch DESC
       LIMIT ?`
    )
    .all(localProjectId, ...visibilityParams, ...params, limit);

  return {
    project: detected.name,
    canonical_id: detected.canonical_id,
    related: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      source_project: row.source_project ?? "unknown",
      source_project_id: row.source_project_id,
      matched_on: classifyMatch(row, terms),
    })),
  };
}

function buildProjectTerms(detected: DetectedProject): string[] {
  const explicit = new Set<string>();
  explicit.add(detected.name.toLowerCase());

  const canonicalParts = detected.canonical_id.toLowerCase().split("/");
  for (const part of canonicalParts) {
    if (part.length >= 4) explicit.add(part);
  }

  if (detected.name.toLowerCase() === "huginn") {
    explicit.add("aiserver");
  }

  return [...explicit].filter(Boolean);
}

function classifyMatch(
  row: {
    title: string;
    narrative: string | null;
    files_read: string | null;
    files_modified: string | null;
  },
  terms: string[]
): string {
  const title = row.title.toLowerCase();
  const narrative = (row.narrative ?? "").toLowerCase();
  const files = `${row.files_read ?? ""} ${row.files_modified ?? ""}`.toLowerCase();

  for (const term of terms) {
    if (files.includes(term)) return `files:${term}`;
    if (title.includes(term)) return `title:${term}`;
    if (narrative.includes(term)) return `narrative:${term}`;
  }
  return "related";
}
