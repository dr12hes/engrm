import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import { runCompactionJob, generateDigest } from "./compaction.js";
import type { ObservationRow } from "../storage/sqlite.js";

let db: MemDatabase;
let tmpDir: string;
let projectId: number;

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

function insertObs(
  overrides: Partial<{
    lifecycle: string;
    created_at_epoch: number;
    title: string;
    session_id: string | null;
    type: string;
    facts: string | null;
    concepts: string | null;
    narrative: string | null;
    quality: number;
  }> = {}
): number {
  const epoch = overrides.created_at_epoch ?? NOW - 100 * DAY;
  // Use db.insertObservation so FTS5 index is properly maintained
  const obs = db.insertObservation({
    project_id: projectId,
    session_id: overrides.session_id ?? "session-1",
    type: overrides.type ?? "discovery",
    title: overrides.title ?? "Test observation",
    narrative: overrides.narrative ?? null,
    facts: overrides.facts ?? null,
    concepts: overrides.concepts ?? null,
    quality: overrides.quality ?? 0.5,
    lifecycle: overrides.lifecycle ?? "aging",
    sensitivity: "shared",
    user_id: "user1",
    device_id: "dev1",
    agent: "claude-code",
  });
  // Override created_at_epoch to test time-based logic
  db.db
    .query("UPDATE observations SET created_at_epoch = ? WHERE id = ?")
    .run(epoch, obs.id);
  return obs.id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "candengo-compaction-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  const project = db.upsertProject({
    canonical_id: "github.com/test/repo",
    name: "repo",
  });
  projectId = project.id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runCompactionJob", () => {
  test("compacts aging observations older than 90 days", () => {
    insertObs({ title: "Fix auth bug", created_at_epoch: NOW - 100 * DAY });
    insertObs({ title: "Add logging", created_at_epoch: NOW - 95 * DAY });

    const result = runCompactionJob(db, NOW);
    expect(result.sessionsCompacted).toBe(1);
    expect(result.observationsArchived).toBe(2);
    expect(result.digestsCreated).toBe(1);
  });

  test("creates digest with correct type and pinned lifecycle", () => {
    insertObs({ title: "Observation 1" });
    insertObs({ title: "Observation 2" });

    runCompactionJob(db, NOW);

    // Find the digest
    const digest = db.db
      .query<ObservationRow, [string]>(
        "SELECT * FROM observations WHERE type = ?"
      )
      .get("digest");

    expect(digest).not.toBeNull();
    expect(digest!.lifecycle).toBe("pinned");
    expect(digest!.type).toBe("digest");
  });

  test("digest gets max quality from source observations", () => {
    insertObs({ title: "Low quality", quality: 0.3 });
    insertObs({ title: "High quality", quality: 0.9 });

    runCompactionJob(db, NOW);

    const digest = db.db
      .query<ObservationRow, [string]>(
        "SELECT * FROM observations WHERE type = ?"
      )
      .get("digest");

    expect(digest!.quality).toBe(0.9);
  });

  test("archives source observations and sets compacted_into", () => {
    const id1 = insertObs({ title: "Obs 1" });
    const id2 = insertObs({ title: "Obs 2" });

    runCompactionJob(db, NOW);

    const obs1 = db.getObservationById(id1);
    const obs2 = db.getObservationById(id2);
    expect(obs1!.lifecycle).toBe("archived");
    expect(obs2!.lifecycle).toBe("archived");
    expect(obs1!.compacted_into).toBeGreaterThan(0);
    expect(obs1!.compacted_into).toBe(obs2!.compacted_into);
    expect(obs1!.archived_at_epoch).toBe(NOW);
  });

  test("does not compact pinned observations", () => {
    insertObs({ lifecycle: "pinned", title: "Pinned obs" });
    const result = runCompactionJob(db, NOW);
    expect(result.observationsArchived).toBe(0);
  });

  test("does not compact observations newer than 90 days", () => {
    insertObs({ created_at_epoch: NOW - 60 * DAY });
    const result = runCompactionJob(db, NOW);
    expect(result.observationsArchived).toBe(0);
  });

  test("groups by session_id", () => {
    insertObs({ session_id: "session-A", title: "A1" });
    insertObs({ session_id: "session-A", title: "A2" });
    insertObs({ session_id: "session-B", title: "B1" });

    const result = runCompactionJob(db, NOW);
    expect(result.sessionsCompacted).toBe(2);
    expect(result.digestsCreated).toBe(2);
    expect(result.observationsArchived).toBe(3);
  });

  test("handles observations with null session_id", () => {
    insertObs({ session_id: null, title: "No session 1" });
    insertObs({ session_id: null, title: "No session 2" });

    const result = runCompactionJob(db, NOW);
    expect(result.sessionsCompacted).toBe(1);
    expect(result.digestsCreated).toBe(1);
    expect(result.observationsArchived).toBe(2);
  });

  test("adds digest to sync outbox", () => {
    insertObs({ title: "Test obs" });
    runCompactionJob(db, NOW);

    const outbox = db.db
      .query<{ record_type: string; record_id: number }, []>(
        "SELECT record_type, record_id FROM sync_outbox WHERE record_type = 'observation'"
      )
      .all();

    expect(outbox.length).toBeGreaterThan(0);
  });

  test("handles empty database", () => {
    const result = runCompactionJob(db, NOW);
    expect(result.sessionsCompacted).toBe(0);
    expect(result.observationsArchived).toBe(0);
    expect(result.digestsCreated).toBe(0);
  });
});

describe("generateDigest", () => {
  function makeObs(overrides: Partial<ObservationRow> = {}): ObservationRow {
    return {
      id: 1,
      session_id: "s1",
      project_id: 1,
      type: overrides.type ?? "discovery",
      title: overrides.title ?? "Test",
      narrative: overrides.narrative ?? null,
      facts: overrides.facts ?? null,
      concepts: overrides.concepts ?? null,
      files_read: null,
      files_modified: null,
      quality: overrides.quality ?? 0.5,
      lifecycle: "aging",
      sensitivity: "shared",
      user_id: "user1",
      device_id: "dev1",
      agent: "claude-code",
      created_at: "2026-01-01T00:00:00Z",
      created_at_epoch: NOW,
      archived_at_epoch: null,
      compacted_into: null,
      superseded_by: null,
      remote_source_id: null,
    };
  }

  test("single observation returns its content directly", () => {
    const obs = makeObs({
      title: "Found a bug",
      narrative: "The auth was broken",
      facts: '["fact1", "fact2"]',
    });
    const digest = generateDigest([obs]);
    expect(digest.title).toBe("Found a bug");
    expect(digest.narrative).toBe("The auth was broken");
    expect(digest.facts).toEqual(["fact1", "fact2"]);
  });

  test("multiple observations are summarised", () => {
    const obs1 = makeObs({ title: "Fix auth", type: "bugfix" });
    const obs2 = makeObs({ id: 2, title: "Add tests", type: "feature" });
    const digest = generateDigest([obs1, obs2]);
    expect(digest.title).toContain("Fix auth");
    expect(digest.title).toContain("Add tests");
    expect(digest.narrative).toContain("[bugfix]");
    expect(digest.narrative).toContain("[feature]");
  });

  test("many observations use +N more format", () => {
    const observations = Array.from({ length: 5 }, (_, i) =>
      makeObs({ id: i + 1, title: `Obs ${i + 1}` })
    );
    const digest = generateDigest(observations);
    expect(digest.title).toContain("Obs 1");
    expect(digest.title).toContain("+4 more");
  });

  test("merges and deduplicates facts", () => {
    const obs1 = makeObs({ facts: '["fact1", "fact2"]' });
    const obs2 = makeObs({ id: 2, facts: '["fact2", "fact3"]' });
    const digest = generateDigest([obs1, obs2]);
    expect(digest.facts).toContain("fact1");
    expect(digest.facts).toContain("fact2");
    expect(digest.facts).toContain("fact3");
    expect(digest.facts.length).toBe(3); // no duplicates
  });

  test("unions concepts", () => {
    const obs1 = makeObs({ concepts: '["auth", "security"]' });
    const obs2 = makeObs({ id: 2, concepts: '["security", "testing"]' });
    const digest = generateDigest([obs1, obs2]);
    expect(digest.concepts).toContain("auth");
    expect(digest.concepts).toContain("security");
    expect(digest.concepts).toContain("testing");
    expect(digest.concepts.length).toBe(3);
  });

  test("handles empty input", () => {
    const digest = generateDigest([]);
    expect(digest.title).toBe("Empty digest");
  });
});
