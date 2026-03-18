/**
 * Compaction job: group aging observations >90 days by session,
 * create digest observations, archive originals.
 *
 * Runs weekly (checked on MCP server startup via scheduler).
 *
 * Strategy:
 *   1. Find aging observations older than 90 days
 *   2. Group by (project_id, session_id)
 *   3. Generate a digest for each group
 *   4. Archive source observations (set compacted_into, remove from FTS5)
 *   5. Add digest to sync outbox
 */

import type { MemDatabase, ObservationRow } from "../storage/sqlite.js";

const COMPACTION_THRESHOLD_SECONDS = 90 * 86400; // 90 days

export interface CompactionResult {
  sessionsCompacted: number;
  observationsArchived: number;
  digestsCreated: number;
}

export interface DigestContent {
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
}

/**
 * Run the compaction job: group old aging observations, create digests, archive originals.
 */
export function runCompactionJob(
  db: MemDatabase,
  nowEpoch?: number
): CompactionResult {
  const now = nowEpoch ?? Math.floor(Date.now() / 1000);
  const cutoff = now - COMPACTION_THRESHOLD_SECONDS;

  // Fetch aging observations older than threshold
  const candidates = db.db
    .query<ObservationRow, [number]>(
      `SELECT * FROM observations
       WHERE lifecycle = 'aging'
       AND created_at_epoch < ?
       ORDER BY project_id, session_id, created_at_epoch`
    )
    .all(cutoff);

  if (candidates.length === 0) {
    return { sessionsCompacted: 0, observationsArchived: 0, digestsCreated: 0 };
  }

  // Group by (project_id, session_id)
  const groups = new Map<string, ObservationRow[]>();
  for (const obs of candidates) {
    const key = `${obs.project_id}:${obs.session_id ?? "__no_session__"}`;
    const group = groups.get(key);
    if (group) {
      group.push(obs);
    } else {
      groups.set(key, [obs]);
    }
  }

  let sessionsCompacted = 0;
  let observationsArchived = 0;
  let digestsCreated = 0;

  for (const [, group] of groups) {
    const first = group[0]!;
    const digest = generateDigest(group);
    const maxQuality = Math.max(...group.map((o) => o.quality));

    // Insert digest observation
    const digestObs = db.insertObservation({
      session_id: first.session_id,
      project_id: first.project_id,
      type: "digest",
      title: digest.title,
      narrative: digest.narrative,
      facts: digest.facts.length > 0 ? JSON.stringify(digest.facts) : null,
      concepts:
        digest.concepts.length > 0 ? JSON.stringify(digest.concepts) : null,
      quality: maxQuality,
      lifecycle: "pinned", // digests don't age out
      sensitivity: first.sensitivity,
      user_id: first.user_id,
      device_id: first.device_id,
      agent: first.agent,
    });

    // Add digest to sync outbox
    db.addToOutbox("observation", digestObs.id);
    digestsCreated++;

    // Archive source observations
    for (const obs of group) {
      db.db
        .query(
          `UPDATE observations
           SET lifecycle = 'archived', compacted_into = ?, archived_at_epoch = ?
           WHERE id = ?`
        )
        .run(digestObs.id, now, obs.id);

      // Remove from FTS5
      db.ftsDelete(obs);
      observationsArchived++;
    }

    sessionsCompacted++;
  }

  return { sessionsCompacted, observationsArchived, digestsCreated };
}

/**
 * Generate digest content from a group of observations.
 * Pure function — no database access.
 */
export function generateDigest(observations: ObservationRow[]): DigestContent {
  if (observations.length === 0) {
    return { title: "Empty digest", narrative: "", facts: [], concepts: [] };
  }

  if (observations.length === 1) {
    const obs = observations[0]!;
    return {
      title: obs.title,
      narrative: obs.narrative ?? "",
      facts: parseFacts(obs.facts),
      concepts: parseFacts(obs.concepts),
    };
  }

  // Title: summarise the group
  const first = observations[0]!;
  const title =
    observations.length <= 3
      ? observations.map((o) => o.title).join("; ")
      : `${first.title} (+${observations.length - 1} more)`;

  // Narrative: bullet points of all titles with their types
  const bullets = observations.map(
    (o) => `- [${o.type}] ${o.title}`
  );
  const narrative = `Session digest (${observations.length} observations):\n${bullets.join("\n")}`;

  // Facts: merge and deduplicate from all observations
  const allFacts = new Set<string>();
  for (const obs of observations) {
    for (const fact of parseFacts(obs.facts)) {
      allFacts.add(fact);
    }
  }

  // Concepts: union of all concepts
  const allConcepts = new Set<string>();
  for (const obs of observations) {
    for (const concept of parseFacts(obs.concepts)) {
      allConcepts.add(concept);
    }
  }

  return {
    title,
    narrative,
    facts: [...allFacts],
    concepts: [...allConcepts],
  };
}

/**
 * Parse a JSON array string, returning empty array on failure.
 */
function parseFacts(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((f) => typeof f === "string" && f.length > 0);
    }
  } catch {
    // Not valid JSON
  }
  return [];
}
