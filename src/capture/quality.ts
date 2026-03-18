/**
 * Observation quality scoring (0.0 — 1.0).
 *
 * Phase 1: Scoring based on available fields (type, content richness, files).
 * Phase 2: Extended with hook context (error→fix sequences, test results, etc.)
 *
 * Observations scoring below QUALITY_THRESHOLD are not saved.
 * See SPEC §2 for the scoring table.
 */

export const QUALITY_THRESHOLD = 0.1;

export interface QualityInput {
  type: string;
  title: string;
  narrative?: string | null;
  facts?: string | null;
  concepts?: string | null;
  filesRead?: string[] | null;
  filesModified?: string[] | null;
  isDuplicate?: boolean;
}

/**
 * Score an observation's quality based on available signals.
 * Returns a value between 0.0 and 1.0.
 */
export function scoreQuality(input: QualityInput): number {
  let score = 0.0;

  // Type-based scoring
  switch (input.type) {
    case "bugfix":
      score += 0.3;
      break;
    case "decision":
      score += 0.3;
      break;
    case "discovery":
      score += 0.2;
      break;
    case "pattern":
      score += 0.2;
      break;
    case "feature":
      score += 0.15;
      break;
    case "refactor":
      score += 0.15;
      break;
    case "change":
      score += 0.05;
      break;
    case "digest":
      // Digests inherit quality from source observations, not scored here
      score += 0.3;
      break;
    case "standard":
      score += 0.25;
      break;
    case "message":
      score += 0.1;
      break;
  }

  // Content richness signals
  if (input.narrative && input.narrative.length > 50) {
    score += 0.15;
  }

  if (input.facts) {
    try {
      const factsArray = JSON.parse(input.facts) as unknown[];
      if (factsArray.length >= 2) score += 0.15;
      else if (factsArray.length === 1) score += 0.05;
    } catch {
      // facts is a string, not JSON array — still has some value
      if (input.facts.length > 20) score += 0.05;
    }
  }

  if (input.concepts) {
    try {
      const conceptsArray = JSON.parse(input.concepts) as unknown[];
      if (conceptsArray.length >= 1) score += 0.1;
    } catch {
      if (input.concepts.length > 10) score += 0.05;
    }
  }

  // Files modified indicates non-trivial work
  const modifiedCount = input.filesModified?.length ?? 0;
  if (modifiedCount >= 3) score += 0.2;
  else if (modifiedCount >= 1) score += 0.1;

  // Deduplication penalty
  if (input.isDuplicate) {
    score -= 0.3;
  }

  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, score));
}

/**
 * Check if an observation meets the minimum quality threshold.
 */
export function meetsQualityThreshold(input: QualityInput): boolean {
  return scoreQuality(input) >= QUALITY_THRESHOLD;
}
