import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemDatabase } from "../storage/sqlite.js";
import { findStaleDecisions, findStaleDecisionsGlobal } from "./followthrough.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/test-followthrough.db";

function freshDb(): MemDatabase {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new MemDatabase(TEST_DB);
}

function addProject(db: MemDatabase, name: string, canonicalId: string): number {
  db.db.run(
    `INSERT INTO projects (canonical_id, name, local_path, first_seen_epoch, last_active_epoch)
     VALUES (?, ?, '/tmp/test', ?, ?)`,
    [canonicalId, name, epoch(0), epoch(0)]
  );
  return db.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
}

const NOW = Math.floor(Date.now() / 1000);
function epoch(daysAgo: number): number {
  return NOW - daysAgo * 86400;
}

function isoDate(daysAgo: number): string {
  return new Date(epoch(daysAgo) * 1000).toISOString();
}

function addObs(
  db: MemDatabase,
  projectId: number,
  type: string,
  title: string,
  daysAgo: number,
  opts?: { concepts?: string[]; narrative?: string }
): number {
  db.db.run(
    `INSERT INTO observations (
       session_id, project_id, type, title, narrative, facts, concepts,
       files_read, files_modified, quality, lifecycle, sensitivity,
       user_id, device_id, agent, created_at, created_at_epoch
     ) VALUES (
       'test-session', ?, ?, ?, ?, NULL, ?,
       NULL, NULL, 0.7, 'active', 'shared',
       'test-user', 'test-device', 'claude', ?, ?
     )`,
    [
      projectId, type, title, opts?.narrative ?? null,
      opts?.concepts ? JSON.stringify(opts.concepts) : null,
      isoDate(daysAgo), epoch(daysAgo),
    ]
  );
  return db.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
}

describe("findStaleDecisions", () => {
  let db: MemDatabase;
  let projectId: number;

  beforeEach(() => {
    db = freshDb();
    projectId = addProject(db, "test-project", "github.com/test/project");
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  test("returns empty for no decisions", () => {
    addObs(db, projectId, "feature", "Some feature", 5);
    const stale = findStaleDecisions(db, projectId);
    expect(stale).toEqual([]);
  });

  test("does not flag recent decisions (< 3 days old)", () => {
    addObs(db, projectId, "decision", "Add rate limiting", 1);
    const stale = findStaleDecisions(db, projectId);
    expect(stale).toEqual([]);
  });

  test("flags old decision with no matching implementation", () => {
    addObs(db, projectId, "decision", "Add rate limiting to API endpoints", 5);
    const stale = findStaleDecisions(db, projectId);
    expect(stale.length).toBe(1);
    expect(stale[0]!.title).toBe("Add rate limiting to API endpoints");
    expect(stale[0]!.days_ago).toBe(5);
  });

  test("does not flag decision that has matching implementation", () => {
    addObs(db, projectId, "decision", "Add rate limiting to API endpoints", 5);
    addObs(db, projectId, "feature", "Implemented rate limiting for API endpoints", 2);
    const stale = findStaleDecisions(db, projectId);
    expect(stale).toEqual([]);
  });

  test("does not match implementation that came BEFORE the decision", () => {
    addObs(db, projectId, "feature", "Implemented rate limiting for API endpoints", 10);
    addObs(db, projectId, "decision", "Add rate limiting to API endpoints", 5);
    const stale = findStaleDecisions(db, projectId);
    expect(stale.length).toBe(1);
  });

  test("matches via concept overlap + partial title match", () => {
    addObs(db, projectId, "decision", "Add authentication rate limiting", 5, {
      concepts: ["authentication", "security", "rate-limiting"],
    });
    addObs(db, projectId, "feature", "Implemented authentication brute-force rate limiter", 2, {
      concepts: ["authentication", "security", "brute-force"],
    });
    const stale = findStaleDecisions(db, projectId);
    // Title shares "authentication" + "rate" words, concepts share 2/3
    expect(stale.length).toBe(0);
  });

  test("pure concept overlap alone is not enough (prevents false matches)", () => {
    addObs(db, projectId, "decision", "Harden the authentication system", 5, {
      concepts: ["authentication", "security"],
    });
    addObs(db, projectId, "feature", "Added brute-force protection to login", 2, {
      concepts: ["authentication", "security"],
    });
    const stale = findStaleDecisions(db, projectId);
    // No title word overlap — concept boost alone shouldn't clear threshold
    expect(stale.length).toBe(1);
  });

  test("caps results at 5", () => {
    for (let i = 0; i < 8; i++) {
      addObs(db, projectId, "decision", `Decision number ${i}`, 5 + i);
    }
    const stale = findStaleDecisions(db, projectId);
    expect(stale.length).toBe(5);
  });

  test("sorts by age (oldest first)", () => {
    addObs(db, projectId, "decision", "Old decision", 10);
    addObs(db, projectId, "decision", "Newer decision", 4);
    const stale = findStaleDecisions(db, projectId);
    expect(stale.length).toBe(2);
    expect(stale[0]!.title).toBe("Old decision");
    expect(stale[1]!.title).toBe("Newer decision");
  });

  test("ignores superseded decisions", () => {
    const id = addObs(db, projectId, "decision", "Old approach", 5);
    addObs(db, projectId, "decision", "New approach", 4);
    db.db.run("UPDATE observations SET superseded_by = ? WHERE id = ?", [id + 1, id]);
    const stale = findStaleDecisions(db, projectId);
    expect(stale.length).toBe(1);
    expect(stale[0]!.title).toBe("New approach");
  });

  test("cross-project implementation clears decision", () => {
    const otherProject = addProject(db, "other-project", "github.com/test/other");
    addObs(db, projectId, "decision", "Add rate limiting to API endpoints", 5);
    addObs(db, otherProject, "feature", "Implemented rate limiting middleware for API", 2);
    const stale = findStaleDecisions(db, projectId);
    expect(stale).toEqual([]);
  });
});

describe("findStaleDecisionsGlobal", () => {
  let db: MemDatabase;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  test("finds stale decisions across all projects", () => {
    const p1 = addProject(db, "project-a", "github.com/test/a");
    const p2 = addProject(db, "project-b", "github.com/test/b");
    addObs(db, p1, "decision", "Refactor the auth module", 6);
    addObs(db, p2, "decision", "Add caching layer", 5);
    // Only implement one
    addObs(db, p2, "feature", "Implemented caching layer with Redis", 2);
    const stale = findStaleDecisionsGlobal(db);
    expect(stale.length).toBe(1);
    expect(stale[0]!.title).toBe("Refactor the auth module");
  });
});
