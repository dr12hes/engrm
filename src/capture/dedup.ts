/**
 * Near-duplicate detection using Jaccard similarity on word tokens.
 *
 * From SPEC §2: Before saving a new observation, check title similarity
 * against last 24h for the same project. If > 0.8, merge into existing.
 */

/**
 * Tokenise a string into lowercase word tokens.
 * Strips punctuation, splits on whitespace.
 */
function tokenise(text: string): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Compute Jaccard similarity between two strings.
 * Returns a value between 0.0 (completely different) and 1.0 (identical).
 *
 * Jaccard = |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = tokenise(a);
  const tokensB = tokenise(b);

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize++;
  }

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  if (unionSize === 0) return 0.0;

  return intersectionSize / unionSize;
}

/**
 * Similarity threshold for considering two observations as duplicates.
 * From SPEC §2: title similarity > 0.8 → merge.
 */
export const DEDUP_THRESHOLD = 0.8;

export interface DedupCandidate {
  id: number;
  title: string;
}

/**
 * Find the best matching duplicate from a list of candidates.
 * Returns the candidate with the highest similarity above threshold, or null.
 */
export function findDuplicate(
  newTitle: string,
  candidates: DedupCandidate[]
): DedupCandidate | null {
  let bestMatch: DedupCandidate | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const similarity = jaccardSimilarity(newTitle, candidate.title);
    if (similarity > DEDUP_THRESHOLD && similarity > bestScore) {
      bestScore = similarity;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}
