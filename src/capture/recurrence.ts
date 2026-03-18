/**
 * Pattern recurrence detector.
 *
 * After a bugfix is saved, searches for similar bugfixes from
 * different sessions. If a match with >0.85 similarity is found,
 * auto-creates a "pattern" observation capturing the recurring issue.
 */

import type { Config } from "../config.js";
import type { MemDatabase, ObservationRow, VecMatchRow } from "../storage/sqlite.js";
import { embedText, composeEmbeddingText } from "../embeddings/embedder.js";
import { saveObservation } from "../tools/save.js";

/** Similarity threshold for pattern detection (cosine distance < 0.15 ≈ >0.85 similarity) */
const DISTANCE_THRESHOLD = 0.15;

export interface RecurrenceResult {
  patternCreated: boolean;
  patternId?: number;
  matchedObservationId?: number;
  matchedProjectName?: string;
  matchedTitle?: string;
  similarity?: number;
}

/**
 * Check if a newly saved bugfix matches existing bugfixes from other sessions.
 * If so, create a "pattern" observation.
 */
export async function detectRecurrence(
  db: MemDatabase,
  config: Config,
  observation: ObservationRow
): Promise<RecurrenceResult> {
  // Only trigger for bugfix observations
  if (observation.type !== "bugfix") {
    return { patternCreated: false };
  }

  // Need vec search for similarity detection
  if (!db.vecAvailable) {
    return { patternCreated: false };
  }

  // Generate embedding for the new bugfix
  const text = composeEmbeddingText(observation);
  const embedding = await embedText(text);
  if (!embedding) {
    return { patternCreated: false };
  }

  // Search for similar observations across all projects
  const vecResults: VecMatchRow[] = db.searchVec(
    embedding,
    null, // no project filter — cross-project
    ["active", "aging", "pinned"],
    10
  );

  // Find similar bugfixes from different sessions
  for (const match of vecResults) {
    // Skip self-match
    if (match.observation_id === observation.id) continue;

    // Check distance threshold (lower = more similar)
    if (match.distance > DISTANCE_THRESHOLD) continue;

    const matched = db.getObservationById(match.observation_id);
    if (!matched) continue;

    // Must be a bugfix from a different session
    if (matched.type !== "bugfix") continue;
    if (matched.session_id === observation.session_id) continue;

    // Check if a pattern already exists for this pair
    if (await patternAlreadyExists(db, observation, matched)) continue;

    // Resolve project name for cross-project label
    let matchedProjectName: string | undefined;
    if (matched.project_id !== observation.project_id) {
      const proj = db.getProjectById(matched.project_id);
      if (proj) matchedProjectName = proj.name;
    }

    // Create pattern observation
    const similarity = 1 - match.distance;
    const result = await saveObservation(db, config, {
      type: "pattern",
      title: `Recurring bugfix: ${observation.title}`,
      narrative: `This bug pattern has appeared in multiple sessions. Original: "${matched.title}" (session ${matched.session_id?.slice(0, 8) ?? "unknown"}). Latest: "${observation.title}". Similarity: ${(similarity * 100).toFixed(0)}%. Consider addressing the root cause.`,
      facts: [
        `First seen: ${matched.created_at.split("T")[0]}`,
        `Recurred: ${observation.created_at.split("T")[0]}`,
        `Similarity: ${(similarity * 100).toFixed(0)}%`,
      ],
      concepts: mergeConceptsFromBoth(observation, matched),
      cwd: process.cwd(),
      session_id: observation.session_id ?? undefined,
    });

    if (result.success && result.observation_id) {
      return {
        patternCreated: true,
        patternId: result.observation_id,
        matchedObservationId: matched.id,
        matchedProjectName,
        matchedTitle: matched.title,
        similarity,
      };
    }
  }

  return { patternCreated: false };
}

/**
 * Check if a pattern observation already exists linking these two observations.
 */
async function patternAlreadyExists(
  db: MemDatabase,
  obs1: ObservationRow,
  obs2: ObservationRow
): Promise<boolean> {
  // Look for pattern observations that reference both titles
  const recentPatterns = db.db
    .query<ObservationRow, [string]>(
      `SELECT * FROM observations
       WHERE type = 'pattern' AND lifecycle IN ('active', 'aging', 'pinned')
       AND title LIKE ?
       ORDER BY created_at_epoch DESC LIMIT 5`
    )
    .all(`%${obs1.title.slice(0, 30)}%`);

  for (const p of recentPatterns) {
    if (p.narrative?.includes(obs2.title.slice(0, 30))) return true;
  }
  return false;
}

/**
 * Merge concepts from two observations, deduplicating.
 */
function mergeConceptsFromBoth(
  obs1: ObservationRow,
  obs2: ObservationRow
): string[] {
  const concepts = new Set<string>();
  for (const obs of [obs1, obs2]) {
    if (obs.concepts) {
      try {
        const parsed = JSON.parse(obs.concepts);
        if (Array.isArray(parsed)) {
          for (const c of parsed) {
            if (typeof c === "string") concepts.add(c);
          }
        }
      } catch {
        // malformed JSON
      }
    }
  }
  return [...concepts];
}
