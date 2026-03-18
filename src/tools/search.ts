/**
 * search_observations MCP tool.
 *
 * Hybrid search: FTS5 (keyword) + sqlite-vec (semantic),
 * merged via Reciprocal Rank Fusion. Falls back to FTS5-only
 * when embeddings or sqlite-vec are unavailable.
 */

import { detectProject } from "../storage/projects.js";
import type {
  MemDatabase,
  FtsMatchRow,
  VecMatchRow,
} from "../storage/sqlite.js";
import { embedText } from "../embeddings/embedder.js";

export interface SearchInput {
  query: string;
  project_scoped?: boolean;
  limit?: number;
  cwd?: string;
  user_id?: string;
}

export interface SearchResult {
  observations: SearchResultEntry[];
  total: number;
  project?: string;
}

export interface SearchResultEntry {
  id: number;
  type: string;
  title: string;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_modified: string | null;
  quality: number;
  lifecycle: string;
  created_at: string;
  rank: number;
  /** Project name — present when cross-project search returns results from other projects */
  project_name?: string;
}

/**
 * Hybrid search: FTS5 keywords + sqlite-vec semantic, merged via RRF.
 */
export async function searchObservations(
  db: MemDatabase,
  input: SearchInput
): Promise<SearchResult> {
  const query = input.query.trim();
  if (!query) {
    return { observations: [], total: 0 };
  }

  const limit = input.limit ?? 10;
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

  // FTS5 keyword search
  const safeQuery = sanitizeFtsQuery(query);
  const ftsResults = safeQuery
    ? db.searchFts(safeQuery, projectId, undefined, limit * 2, input.user_id)
    : [];

  // Vec semantic search (if available)
  let vecResults: VecMatchRow[] = [];
  const queryEmbedding = await embedText(query);
  if (queryEmbedding && db.vecAvailable) {
    vecResults = db.searchVec(
      queryEmbedding,
      projectId,
      ["active", "aging", "pinned"],
      limit * 2,
      input.user_id
    );
  }

  // Merge via RRF if we have both, otherwise use whichever is available
  const merged = mergeResults(ftsResults, vecResults, limit);

  if (merged.length === 0) {
    return { observations: [], total: 0, project: projectName };
  }

  const ids = merged.map((r) => r.id);
  const scoreMap = new Map(merged.map((r) => [r.id, r.score]));
  const observations = db.getObservationsByIds(ids, input.user_id);

  // Filter out superseded observations
  const active = observations.filter((obs) => obs.superseded_by === null);

  // Build project name lookup for cross-project labeling
  const projectNameCache = new Map<number, string>();
  if (!projectScoped) {
    for (const obs of active) {
      if (!projectNameCache.has(obs.project_id)) {
        const proj = db.getProjectById(obs.project_id);
        if (proj) projectNameCache.set(obs.project_id, proj.name);
      }
    }
  }

  // Apply lifecycle weighting
  const entries: SearchResultEntry[] = active.map((obs) => {
    const baseScore = scoreMap.get(obs.id) ?? 0;
    const lifecycleWeight = obs.lifecycle === "aging" ? 0.7 : 1.0;

    return {
      id: obs.id,
      type: obs.type,
      title: obs.title,
      narrative: obs.narrative,
      facts: obs.facts,
      concepts: obs.concepts,
      files_modified: obs.files_modified,
      quality: obs.quality,
      lifecycle: obs.lifecycle,
      created_at: obs.created_at,
      rank: baseScore * lifecycleWeight,
      // Label cross-project results with source project
      ...(!projectScoped
        ? { project_name: projectNameCache.get(obs.project_id) }
        : {}),
    };
  });

  // Sort by score (higher = better match)
  entries.sort((a, b) => b.rank - a.rank);

  return {
    observations: entries,
    total: entries.length,
    project: projectName,
  };
}

// --- Reciprocal Rank Fusion ---

const RRF_K = 60;

interface ScoredId {
  id: number;
  score: number;
}

/**
 * Merge FTS5 and vec results using Reciprocal Rank Fusion.
 * RRF is rank-based, so no score normalization needed.
 * Items appearing in both lists get boosted.
 */
export function mergeResults(
  ftsResults: FtsMatchRow[],
  vecResults: VecMatchRow[],
  limit: number
): ScoredId[] {
  const scores = new Map<number, number>();

  // FTS results sorted by rank (more negative = better match)
  for (let rank = 0; rank < ftsResults.length; rank++) {
    const id = ftsResults[rank]!.id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  }

  // Vec results sorted by distance (lower = closer)
  for (let rank = 0; rank < vecResults.length; rank++) {
    const id = vecResults[rank]!.observation_id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Sanitize a query for FTS5.
 */
function sanitizeFtsQuery(query: string): string {
  let safe = query.replace(/[{}()[\]^~*:]/g, " ");
  safe = safe.replace(/\s+/g, " ").trim();
  if (!safe) return "";
  return safe;
}
