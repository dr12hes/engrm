/**
 * reclassify_project_memory MCP tool.
 *
 * Moves repo-relevant observations that were stored under another project into
 * the current git project. Intended as a controlled cleanup/admin step while
 * attribution quality improves.
 */

import { detectProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { getProjectRelatedWork } from "./project-related-work.js";

export interface ReclassifyProjectMemoryInput {
  cwd?: string;
  user_id?: string;
  limit?: number;
  dry_run?: boolean;
}

export interface ReclassifyProjectMemoryResult {
  project: string;
  canonical_id: string;
  target_project_id: number;
  moved: number;
  candidates: Array<{
    id: number;
    title: string;
    type: string;
    from: string;
    matched_on: string;
    moved: boolean;
  }>;
}

export function reclassifyProjectMemory(
  db: MemDatabase,
  input: ReclassifyProjectMemoryInput
): ReclassifyProjectMemoryResult {
  const cwd = input.cwd ?? process.cwd();
  const detected = detectProject(cwd);
  const target = db.upsertProject({
    canonical_id: detected.canonical_id,
    name: detected.name,
    local_path: detected.local_path,
    remote_url: detected.remote_url,
  });

  const related = getProjectRelatedWork(db, {
    cwd,
    user_id: input.user_id,
    limit: input.limit ?? 50,
  }).related;

  let moved = 0;
  const candidates = related.map((item) => {
    const eligible =
      item.matched_on.startsWith("files:") ||
      item.matched_on.startsWith("title:") ||
      item.matched_on.startsWith("narrative:");
    const shouldMove = eligible && item.source_project_id !== target.id;

    if (shouldMove && input.dry_run !== true) {
      const ok = db.reassignObservationProject(item.id, target.id);
      if (ok) moved += 1;
      return {
        id: item.id,
        title: item.title,
        type: item.type,
        from: item.source_project,
        matched_on: item.matched_on,
        moved: ok,
      };
    }

    return {
      id: item.id,
      title: item.title,
      type: item.type,
      from: item.source_project,
      matched_on: item.matched_on,
      moved: false,
    };
  });

  return {
    project: target.name,
    canonical_id: target.canonical_id,
    target_project_id: target.id,
    moved,
    candidates,
  };
}
