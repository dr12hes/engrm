import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "./sqlite.js";
import {
  getPendingEntries,
  markSyncing,
  markSynced,
  markFailed,
  purgeSynced,
  getOutboxStats,
} from "./outbox.js";

let db: MemDatabase;
let tmpDir: string;
let projectId: number;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-outbox-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
  const project = db.upsertProject({
    canonical_id: "github.com/org/repo",
    name: "repo",
  });
  projectId = project.id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function createObsAndOutboxEntry(): number {
  const obs = db.insertObservation({
    project_id: projectId,
    type: "bugfix",
    title: "Fix something",
    quality: 0.5,
    user_id: "david",
    device_id: "laptop-abc",
  });
  // insertObservation does NOT add to outbox — that's the save tool's job.
  // We add manually here for outbox-specific tests.
  db.addToOutbox("observation", obs.id);

  const entry = db.db
    .query<{ id: number }, [number]>(
      "SELECT id FROM sync_outbox WHERE record_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(obs.id);
  return entry!.id;
}

describe("getPendingEntries", () => {
  test("returns pending entries", () => {
    createObsAndOutboxEntry();
    const entries = getPendingEntries(db);
    expect(entries.length).toBe(1);
    expect(entries[0]!.status).toBe("pending");
  });

  test("returns empty when no pending entries", () => {
    expect(getPendingEntries(db)).toEqual([]);
  });

  test("respects limit", () => {
    createObsAndOutboxEntry();
    createObsAndOutboxEntry();
    createObsAndOutboxEntry();
    const entries = getPendingEntries(db, 2);
    expect(entries.length).toBe(2);
  });

  test("includes failed entries past retry time", () => {
    const entryId = createObsAndOutboxEntry();
    markFailed(db, entryId, "network error");

    // Set next_retry_epoch to the past
    db.db
      .query("UPDATE sync_outbox SET next_retry_epoch = 0 WHERE id = ?")
      .run(entryId);

    const entries = getPendingEntries(db);
    expect(entries.length).toBe(1);
  });

  test("excludes failed entries before retry time", () => {
    const entryId = createObsAndOutboxEntry();
    markFailed(db, entryId, "network error");
    // next_retry_epoch is in the future by default

    const entries = getPendingEntries(db);
    // Should only include failed entries whose retry time has passed
    // Since we just marked it failed, next_retry is in the future
    const failedEntries = entries.filter((e) => e.status === "failed");
    expect(failedEntries.length).toBe(0);
  });
});

describe("markSyncing", () => {
  test("sets status to syncing", () => {
    const entryId = createObsAndOutboxEntry();
    markSyncing(db, entryId);

    const entry = db.db
      .query<{ status: string }, [number]>(
        "SELECT status FROM sync_outbox WHERE id = ?"
      )
      .get(entryId);
    expect(entry!.status).toBe("syncing");
  });
});

describe("markSynced", () => {
  test("sets status to synced with timestamp", () => {
    const entryId = createObsAndOutboxEntry();
    markSynced(db, entryId);

    const entry = db.db
      .query<{ status: string; synced_at_epoch: number | null }, [number]>(
        "SELECT status, synced_at_epoch FROM sync_outbox WHERE id = ?"
      )
      .get(entryId);
    expect(entry!.status).toBe("synced");
    expect(entry!.synced_at_epoch).not.toBeNull();
  });
});

describe("markFailed", () => {
  test("increments retry count atomically", () => {
    const entryId = createObsAndOutboxEntry();

    markFailed(db, entryId, "error 1");
    let entry = db.db
      .query<{ retry_count: number }, [number]>(
        "SELECT retry_count FROM sync_outbox WHERE id = ?"
      )
      .get(entryId);
    expect(entry!.retry_count).toBe(1);

    markFailed(db, entryId, "error 2");
    entry = db.db
      .query<{ retry_count: number }, [number]>(
        "SELECT retry_count FROM sync_outbox WHERE id = ?"
      )
      .get(entryId);
    expect(entry!.retry_count).toBe(2);
  });

  test("sets last_error", () => {
    const entryId = createObsAndOutboxEntry();
    markFailed(db, entryId, "connection refused");

    const entry = db.db
      .query<{ last_error: string | null }, [number]>(
        "SELECT last_error FROM sync_outbox WHERE id = ?"
      )
      .get(entryId);
    expect(entry!.last_error).toBe("connection refused");
  });

  test("sets next_retry_epoch in the future", () => {
    const entryId = createObsAndOutboxEntry();
    const before = Math.floor(Date.now() / 1000);
    markFailed(db, entryId, "error");

    const entry = db.db
      .query<{ next_retry_epoch: number | null }, [number]>(
        "SELECT next_retry_epoch FROM sync_outbox WHERE id = ?"
      )
      .get(entryId);
    expect(entry!.next_retry_epoch).not.toBeNull();
    expect(entry!.next_retry_epoch!).toBeGreaterThan(before);
  });
});

describe("purgeSynced", () => {
  test("deletes old synced entries", () => {
    const entryId = createObsAndOutboxEntry();
    markSynced(db, entryId);

    // Set synced_at to far in the past
    db.db
      .query("UPDATE sync_outbox SET synced_at_epoch = 1000 WHERE id = ?")
      .run(entryId);

    const deleted = purgeSynced(db, 2000);
    expect(deleted).toBe(1);
  });

  test("does not delete recent synced entries", () => {
    const entryId = createObsAndOutboxEntry();
    markSynced(db, entryId);

    const deleted = purgeSynced(db, 1000); // cutoff before sync time
    expect(deleted).toBe(0);
  });

  test("does not delete pending entries", () => {
    createObsAndOutboxEntry();
    const deleted = purgeSynced(db, Math.floor(Date.now() / 1000) + 9999);
    expect(deleted).toBe(0);
  });
});

describe("getOutboxStats", () => {
  test("returns zeroes when empty", () => {
    const stats = getOutboxStats(db);
    expect(stats["pending"]).toBe(0);
    expect(stats["syncing"]).toBe(0);
    expect(stats["synced"]).toBe(0);
    expect(stats["failed"]).toBe(0);
  });

  test("counts by status", () => {
    const id1 = createObsAndOutboxEntry();
    const id2 = createObsAndOutboxEntry();
    createObsAndOutboxEntry(); // stays pending

    markSynced(db, id1);
    markFailed(db, id2, "err");

    const stats = getOutboxStats(db);
    expect(stats["pending"]).toBe(1);
    expect(stats["synced"]).toBe(1);
    expect(stats["failed"]).toBe(1);
  });
});
