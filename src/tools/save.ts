/**
 * save_observation MCP tool.
 *
 * Pipeline: detect project → scrub secrets → score quality →
 *           check dedup → insert → add to outbox
 */

import { relative, isAbsolute } from "node:path";
import type { Config } from "../config.js";
import { scrubSecrets, containsSecrets } from "../capture/scrubber.js";
import { scoreQuality, meetsQualityThreshold } from "../capture/quality.js";
import { findDuplicate, type DedupCandidate } from "../capture/dedup.js";
import { buildStructuredFacts } from "../capture/facts.js";
import { detectProject, detectProjectFromTouchedPaths } from "../storage/projects.js";
import type { MemDatabase, ObservationRow } from "../storage/sqlite.js";
import { composeEmbeddingText, embedText } from "../embeddings/embedder.js";
import { detectRecurrence } from "../capture/recurrence.js";
import { detectDecisionConflict } from "../capture/conflict.js";

const VALID_TYPES = [
  "bugfix",
  "discovery",
  "decision",
  "pattern",
  "change",
  "feature",
  "refactor",
  "digest",
  "standard",
  "message",
] as const;

type ObservationType = (typeof VALID_TYPES)[number];

export interface SaveObservationInput {
  type: string;
  title: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
  files_read?: string[];
  files_modified?: string[];
  sensitivity?: "shared" | "personal" | "secret";
  session_id?: string;
  cwd?: string;
  agent?: string;
}

export interface SaveObservationResult {
  success: boolean;
  observation_id?: number;
  quality_score?: number;
  merged_into?: number;
  reason?: string;
  /** Cross-project recall hint when a similar bugfix was found */
  recall_hint?: string;
  /** Warning when a conflicting decision was detected */
  conflict_warning?: string;
}

/**
 * Save an observation through the full capture pipeline.
 */
export async function saveObservation(
  db: MemDatabase,
  config: Config,
  input: SaveObservationInput
): Promise<SaveObservationResult> {
  // Validate type
  if (!VALID_TYPES.includes(input.type as ObservationType)) {
    return {
      success: false,
      reason: `Invalid type '${input.type}'. Must be one of: ${VALID_TYPES.join(", ")}`,
    };
  }

  // Validate title
  if (!input.title || input.title.trim().length === 0) {
    return { success: false, reason: "Title is required" };
  }

  // Detect project from cwd
  const cwd = input.cwd ?? process.cwd();
  const touchedPaths = [...(input.files_read ?? []), ...(input.files_modified ?? [])];
  const detected = touchedPaths.length > 0
    ? detectProjectFromTouchedPaths(touchedPaths, cwd)
    : detectProject(cwd);
  const project = db.upsertProject({
    canonical_id: detected.canonical_id,
    name: detected.name,
    local_path: detected.local_path,
    remote_url: detected.remote_url,
  });

  // Scrub secrets from all text fields
  const customPatterns = config.scrubbing.enabled
    ? config.scrubbing.custom_patterns
    : [];

  const title = config.scrubbing.enabled
    ? scrubSecrets(input.title, customPatterns)
    : input.title;

  const narrative = input.narrative
    ? config.scrubbing.enabled
      ? scrubSecrets(input.narrative, customPatterns)
      : input.narrative
    : null;

  const conceptsJson = input.concepts
    ? JSON.stringify(input.concepts)
    : null;

  // Convert absolute paths to project-relative for cross-machine portability
  const filesRead = input.files_read
    ? input.files_read.map((f) => toRelativePath(f, cwd))
    : null;

  const filesModified = input.files_modified
    ? input.files_modified.map((f) => toRelativePath(f, cwd))
    : null;

  const structuredFacts = buildStructuredFacts({
    type: input.type,
    title: input.title,
    narrative: input.narrative,
    facts: input.facts,
    filesModified,
  });

  const factsJson = structuredFacts.length > 0
    ? config.scrubbing.enabled
      ? scrubSecrets(JSON.stringify(structuredFacts), customPatterns)
      : JSON.stringify(structuredFacts)
    : null;

  const filesReadJson = filesRead ? JSON.stringify(filesRead) : null;
  const filesModifiedJson = filesModified ? JSON.stringify(filesModified) : null;

  // Determine sensitivity
  let sensitivity = input.sensitivity ?? config.scrubbing.default_sensitivity;
  if (
    config.scrubbing.enabled &&
    containsSecrets(
      [input.title, input.narrative, JSON.stringify(input.facts)]
        .filter(Boolean)
        .join(" "),
      customPatterns
    )
  ) {
    // Upgrade to 'personal' if secrets detected (even after scrubbing, flag it)
    if (sensitivity === "shared") {
      sensitivity = "personal";
    }
  }

  // Check deduplication against last 24h
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  const recentObs = db.getRecentObservations(project.id, oneDayAgo);
  const candidates: DedupCandidate[] = recentObs.map((o) => ({
    id: o.id,
    title: o.title,
  }));
  const duplicate = findDuplicate(title, candidates);

  // Score quality
  const qualityInput = {
    type: input.type,
    title,
    narrative,
    facts: factsJson,
    concepts: conceptsJson,
    filesRead: filesRead,
    filesModified: filesModified,
    isDuplicate: duplicate !== null,
  };

  const qualityScore = scoreQuality(qualityInput);

  if (!meetsQualityThreshold(qualityInput)) {
    return {
      success: false,
      quality_score: qualityScore,
      reason: `Quality score ${qualityScore.toFixed(2)} below threshold`,
    };
  }

  // If duplicate found, report merge (future: update existing observation)
  if (duplicate) {
    return {
      success: true,
      merged_into: duplicate.id,
      quality_score: qualityScore,
      reason: `Merged into existing observation #${duplicate.id}`,
    };
  }

  // Insert observation
  const obs = db.insertObservation({
    session_id: input.session_id ?? null,
    project_id: project.id,
    type: input.type,
    title,
    narrative,
    facts: factsJson,
    concepts: conceptsJson,
    files_read: filesReadJson,
    files_modified: filesModifiedJson,
    quality: qualityScore,
    lifecycle: "active",
    sensitivity,
    user_id: config.user_id,
    device_id: config.device_id,
    agent: input.agent ?? "claude-code",
  });

  // Add to sync outbox
  db.addToOutbox("observation", obs.id);

  // Embed for local vector search (best-effort, non-blocking on failure)
  if (db.vecAvailable) {
    try {
      const text = composeEmbeddingText(obs);
      const embedding = await embedText(text);
      if (embedding) {
        db.vecInsert(obs.id, embedding);
      }
    } catch {
      // Embedding failure is non-fatal — FTS5 still works
    }
  }

  // Detect recurring patterns for bugfixes (best-effort, non-blocking)
  let recallHint: string | undefined;
  if (input.type === "bugfix") {
    try {
      const recurrence = await detectRecurrence(db, config, obs);
      if (recurrence.patternCreated && recurrence.matchedTitle) {
        const projectLabel = recurrence.matchedProjectName
          ? ` in ${recurrence.matchedProjectName}`
          : "";
        recallHint = `You solved a similar issue${projectLabel}: "${recurrence.matchedTitle}"`;
      }
    } catch {
      // Pattern detection failure is non-fatal
    }
  }

  // Detect decision conflicts (best-effort)
  let conflictWarning: string | undefined;
  if (input.type === "decision") {
    try {
      const conflict = await detectDecisionConflict(db, obs);
      if (conflict.hasConflict && conflict.conflictingTitle) {
        conflictWarning = `Potential conflict with existing decision: "${conflict.conflictingTitle}" — ${conflict.reason}`;
      }
    } catch {
      // Conflict detection failure is non-fatal
    }
  }

  return {
    success: true,
    observation_id: obs.id,
    quality_score: qualityScore,
    recall_hint: recallHint,
    conflict_warning: conflictWarning,
  };
}

/**
 * Convert an absolute file path to a project-relative path.
 * Already-relative paths are returned as-is.
 * Paths outside the project root are returned as-is (no way to make relative).
 */
function toRelativePath(filePath: string, projectRoot: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const rel = relative(projectRoot, filePath);
  // If relative() returns a path starting with "..", the file is outside project root
  if (rel.startsWith("..")) return filePath;
  return rel;
}
