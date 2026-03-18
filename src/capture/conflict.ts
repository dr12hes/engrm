/**
 * Decision conflict detector.
 *
 * When a new decision is saved, searches for existing decisions
 * in the same project with similar titles/concepts. If found,
 * compares narratives for conflicting conclusions and flags them.
 */

import type { MemDatabase, ObservationRow, VecMatchRow } from "../storage/sqlite.js";
import { embedText, composeEmbeddingText } from "../embeddings/embedder.js";

export interface ConflictResult {
  hasConflict: boolean;
  conflictingId?: number;
  conflictingTitle?: string;
  reason?: string;
}

/** Distance threshold for considering decisions similar (cosine distance) */
const SIMILARITY_THRESHOLD = 0.25;

/**
 * Check if a new decision conflicts with existing decisions.
 */
export async function detectDecisionConflict(
  db: MemDatabase,
  observation: ObservationRow
): Promise<ConflictResult> {
  if (observation.type !== "decision") {
    return { hasConflict: false };
  }

  if (!observation.narrative || observation.narrative.trim().length < 20) {
    return { hasConflict: false };
  }

  // Use vec search if available
  if (db.vecAvailable) {
    return detectViaVec(db, observation);
  }

  // Fall back to FTS search
  return detectViaFts(db, observation);
}

async function detectViaVec(
  db: MemDatabase,
  observation: ObservationRow
): Promise<ConflictResult> {
  const text = composeEmbeddingText(observation);
  const embedding = await embedText(text);
  if (!embedding) return { hasConflict: false };

  const results: VecMatchRow[] = db.searchVec(
    embedding,
    observation.project_id,
    ["active", "aging", "pinned"],
    10
  );

  for (const match of results) {
    if (match.observation_id === observation.id) continue;
    if (match.distance > SIMILARITY_THRESHOLD) continue;

    const existing = db.getObservationById(match.observation_id);
    if (!existing) continue;
    if (existing.type !== "decision") continue;
    if (!existing.narrative) continue;

    // Check for conflicting conclusions
    const conflict = narrativesConflict(observation.narrative!, existing.narrative);
    if (conflict) {
      return {
        hasConflict: true,
        conflictingId: existing.id,
        conflictingTitle: existing.title,
        reason: conflict,
      };
    }
  }

  return { hasConflict: false };
}

async function detectViaFts(
  db: MemDatabase,
  observation: ObservationRow
): Promise<ConflictResult> {
  // Search for similar decisions by title keywords
  const keywords = observation.title
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5)
    .join(" ");

  if (!keywords) return { hasConflict: false };

  const ftsResults = db.searchFts(
    keywords,
    observation.project_id,
    ["active", "aging", "pinned"],
    10
  );

  for (const match of ftsResults) {
    if (match.id === observation.id) continue;

    const existing = db.getObservationById(match.id);
    if (!existing) continue;
    if (existing.type !== "decision") continue;
    if (!existing.narrative) continue;

    const conflict = narrativesConflict(observation.narrative!, existing.narrative);
    if (conflict) {
      return {
        hasConflict: true,
        conflictingId: existing.id,
        conflictingTitle: existing.title,
        reason: conflict,
      };
    }
  }

  return { hasConflict: false };
}

/**
 * Heuristic check if two decision narratives suggest conflicting conclusions.
 *
 * Looks for opposing signal words that indicate different directions.
 * Returns a description of the conflict, or null if no conflict detected.
 */
function narrativesConflict(
  narrative1: string,
  narrative2: string
): string | null {
  const n1 = narrative1.toLowerCase();
  const n2 = narrative2.toLowerCase();

  // Check for opposing signals
  const opposingPairs: [string[], string[]][] = [
    [["should use", "decided to use", "chose", "prefer", "went with"], ["should not", "decided against", "avoid", "rejected", "don't use"]],
    [["enable", "turn on", "activate", "add"], ["disable", "turn off", "deactivate", "remove"]],
    [["increase", "more", "higher", "scale up"], ["decrease", "less", "lower", "scale down"]],
    [["keep", "maintain", "preserve"], ["replace", "migrate", "switch from", "deprecate"]],
  ];

  for (const [positive, negative] of opposingPairs) {
    const n1HasPositive = positive.some((w) => n1.includes(w));
    const n1HasNegative = negative.some((w) => n1.includes(w));
    const n2HasPositive = positive.some((w) => n2.includes(w));
    const n2HasNegative = negative.some((w) => n2.includes(w));

    if ((n1HasPositive && n2HasNegative) || (n1HasNegative && n2HasPositive)) {
      return "Narratives suggest opposing conclusions on a similar topic";
    }
  }

  return null;
}
