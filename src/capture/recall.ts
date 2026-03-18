/**
 * "You Solved This Before" — proactive error recall.
 *
 * When a Bash tool returns an error, searches stored observations
 * for past bugfixes matching that error and surfaces them immediately.
 *
 * Read-only: recall doesn't create observations, just surfaces existing ones.
 */

import type { MemDatabase, ObservationRow, VecMatchRow } from "../storage/sqlite.js";
import { embedText } from "../embeddings/embedder.js";

/** Cosine distance threshold — looser than recurrence (0.15) because error text ≠ fix narrative */
const VEC_DISTANCE_THRESHOLD = 0.25;

export interface RecallResult {
  found: boolean;
  title?: string;
  narrative?: string;
  observationId?: number;
  projectName?: string;
  similarity?: number;
}

/**
 * Extract a concise error signature from tool output.
 * Returns null if no clear error is detected (avoids false positives).
 */
export function extractErrorSignature(output: string): string | null {
  if (!output || output.length < 10) return null;

  const lines = output.split("\n");

  // Python tracebacks — get the last "Error: ..." line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    // Python: "ModuleNotFoundError: No module named 'foo'"
    if (/^[A-Z]\w*(Error|Exception):\s/.test(line)) {
      return line.slice(0, 200);
    }
  }

  // Node/JS errors: "TypeError: Cannot read properties of undefined"
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(TypeError|ReferenceError|SyntaxError|RangeError|Error):\s/.test(trimmed)) {
      return trimmed.slice(0, 200);
    }
  }

  // Rust panics: "thread 'main' panicked at ..."
  for (const line of lines) {
    const match = line.match(/panicked at '(.+?)'/);
    if (match) return `panic: ${match[1]!.slice(0, 180)}`;
  }

  // Go panics: "panic: runtime error: ..."
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("panic:")) return trimmed.slice(0, 200);
  }

  // Generic "Error:" or "error:" — take the first occurrence
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(error|Error|ERROR)\b[:\[]/.test(trimmed) && trimmed.length > 10) {
      return trimmed.slice(0, 200);
    }
  }

  // ENOENT, EACCES, etc. (Node.js system errors)
  for (const line of lines) {
    const match = line.match(/(E[A-Z]{2,}): (.+)/);
    if (match && /^E[A-Z]+$/.test(match[1]!)) {
      return `${match[1]}: ${match[2]!.slice(0, 180)}`;
    }
  }

  // "fatal:" (git errors, etc.)
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^fatal:\s/.test(trimmed)) return trimmed.slice(0, 200);
  }

  return null;
}

/**
 * Search stored observations for a past bugfix matching the given error.
 *
 * Tries vec search first (semantic), falls back to FTS5 (keyword).
 * Cold start guard: if embedding model not already loaded, uses FTS only.
 */
export async function recallPastFix(
  db: MemDatabase,
  errorSignature: string,
  projectId?: number | null
): Promise<RecallResult> {
  // Try vec search if available (model already loaded)
  if (db.vecAvailable) {
    const embedding = await embedText(errorSignature);
    if (embedding) {
      const vecResults: VecMatchRow[] = db.searchVec(
        embedding,
        null, // cross-project by default
        ["active", "aging", "pinned"],
        10
      );

      for (const match of vecResults) {
        if (match.distance > VEC_DISTANCE_THRESHOLD) continue;

        const obs = db.getObservationById(match.observation_id);
        if (!obs) continue;
        if (obs.type !== "bugfix") continue;

        // Resolve project name for cross-project context
        let projectName: string | undefined;
        if (projectId != null && obs.project_id !== projectId) {
          const proj = db.getProjectById(obs.project_id);
          if (proj) projectName = proj.name;
        }

        return {
          found: true,
          title: obs.title,
          narrative: truncateNarrative(obs.narrative, 200),
          observationId: obs.id,
          projectName,
          similarity: 1 - match.distance,
        };
      }
    }
  }

  // FTS fallback — extract keywords from error signature
  const ftsQuery = buildFtsQueryFromError(errorSignature);
  if (!ftsQuery) return { found: false };

  const ftsResults = db.searchFts(ftsQuery, null, ["active", "aging", "pinned"], 10);

  for (const match of ftsResults) {
    const obs = db.getObservationById(match.id);
    if (!obs) continue;
    if (obs.type !== "bugfix") continue;

    let projectName: string | undefined;
    if (projectId != null && obs.project_id !== projectId) {
      const proj = db.getProjectById(obs.project_id);
      if (proj) projectName = proj.name;
    }

    return {
      found: true,
      title: obs.title,
      narrative: truncateNarrative(obs.narrative, 200),
      observationId: obs.id,
      projectName,
    };
  }

  return { found: false };
}

/**
 * Build an FTS5 query from an error signature.
 * Extracts meaningful keywords, skipping noise words.
 */
function buildFtsQueryFromError(error: string): string | null {
  // Strip common noise from error messages
  const cleaned = error
    .replace(/[{}()[\]^~*:'"`,.<>\/\\|]/g, " ")
    .replace(/\b(at|in|of|the|is|to|from|for|with|a|an|and|or|not|no|on)\b/gi, " ")
    .replace(/\b\d+\b/g, " ") // strip bare numbers
    .replace(/\s+/g, " ")
    .trim();

  // Take the most meaningful tokens (3-5 words)
  const tokens = cleaned.split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;

  return tokens.slice(0, 5).join(" ");
}

/**
 * Truncate a narrative to a max length for display.
 */
function truncateNarrative(narrative: string | null, maxLen: number): string | undefined {
  if (!narrative) return undefined;
  if (narrative.length <= maxLen) return narrative;
  return narrative.slice(0, maxLen - 3) + "...";
}
