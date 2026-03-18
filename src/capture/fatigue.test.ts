import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import {
  checkSessionFatigue,
  computeUserStats,
  computeErrorAcceleration,
} from "./fatigue.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-fatigue-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));

  // Ensure a default project exists for observation foreign key
  const now = Math.floor(Date.now() / 1000);
  db.db.exec(
    `INSERT OR IGNORE INTO projects (id, canonical_id, name, first_seen_epoch, last_active_epoch) VALUES (1, 'test-project', 'Test', ${now}, ${now})`
  );
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeUserStats", () => {
  test("returns defaults when fewer than 3 completed sessions", () => {
    const stats = computeUserStats(db);
    expect(stats.avgDurationMinutes).toBe(90);
    expect(stats.p90DurationMinutes).toBe(180);
  });

  test("computes avg and p90 from completed sessions", () => {
    const now = Math.floor(Date.now() / 1000);

    // Insert 5 completed sessions with durations: 30, 60, 90, 120, 150 minutes
    const durations = [30, 60, 90, 120, 150];
    for (let i = 0; i < durations.length; i++) {
      db.db
        .query(
          `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch, completed_at_epoch)
           VALUES (?, 'user', 'dev', 'completed', ?, ?)`
        )
        .run(`sess-${i}`, now - durations[i] * 60, now);
    }

    const stats = computeUserStats(db);

    // Average of [30, 60, 90, 120, 150] = 90
    expect(stats.avgDurationMinutes).toBe(90);

    // p90 of 5 items: index = floor(5 * 0.9) = 4 => 150
    // (sorted ascending: 30, 60, 90, 120, 150)
    expect(stats.p90DurationMinutes).toBe(150);
  });

  test("ignores active (incomplete) sessions", () => {
    const now = Math.floor(Date.now() / 1000);

    // 3 completed sessions
    for (let i = 0; i < 3; i++) {
      db.db
        .query(
          `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch, completed_at_epoch)
           VALUES (?, 'user', 'dev', 'completed', ?, ?)`
        )
        .run(`done-${i}`, now - 60 * 60, now);
    }

    // 1 active session (should be ignored)
    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("active-1", now - 300 * 60);

    const stats = computeUserStats(db);
    // All 3 completed sessions are 60 minutes
    expect(stats.avgDurationMinutes).toBe(60);
  });
});

describe("computeErrorAcceleration", () => {
  test("returns zero when session not found", () => {
    const result = computeErrorAcceleration(db, "nonexistent", Date.now() / 1000);
    expect(result.ratio).toBe(0);
  });

  test("returns zero when session is too short", () => {
    const now = Math.floor(Date.now() / 1000);

    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("short-sess", now - 120); // 2 minutes ago

    const result = computeErrorAcceleration(db, "short-sess", now);
    expect(result.ratio).toBe(0);
  });

  test("returns zero when no bugfix observations", () => {
    const now = Math.floor(Date.now() / 1000);

    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("no-errors", now - 3600); // 1 hour ago

    const result = computeErrorAcceleration(db, "no-errors", now);
    expect(result.ratio).toBe(0);
    expect(result.sessionCount).toBe(0);
  });

  test("detects acceleration when recent errors spike", () => {
    const now = Math.floor(Date.now() / 1000);
    const sessionStart = now - 120 * 60; // 2 hours ago

    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("accel-sess", sessionStart);

    // 2 bugfixes early in session (90 min ago)
    for (let i = 0; i < 2; i++) {
      db.db
        .query(
          `INSERT INTO observations (session_id, project_id, type, title, user_id, device_id, created_at, created_at_epoch)
           VALUES (?, 1, 'bugfix', 'old fix', 'user', 'dev', datetime('now'), ?)`
        )
        .run("accel-sess", now - 90 * 60 + i);
    }

    // 6 bugfixes in the last 30 minutes
    for (let i = 0; i < 6; i++) {
      db.db
        .query(
          `INSERT INTO observations (session_id, project_id, type, title, user_id, device_id, created_at, created_at_epoch)
           VALUES (?, 1, 'bugfix', 'recent fix', 'user', 'dev', datetime('now'), ?)`
        )
        .run("accel-sess", now - 20 * 60 + i);
    }

    const result = computeErrorAcceleration(db, "accel-sess", now);
    // 8 total in 120 min => session rate = (8/120)*30 = 2.0 per 30 min
    // 6 recent in last 30 min => recent rate = 6
    // ratio = 6 / 2.0 = 3.0
    expect(result.ratio).toBe(3);
    expect(result.recentCount).toBe(6);
    expect(result.sessionCount).toBe(8);
  });
});

describe("checkSessionFatigue", () => {
  test("returns not fatigued for short session with no errors", () => {
    const now = Math.floor(Date.now() / 1000);

    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("calm-sess", now - 30 * 60); // 30 minutes

    const result = checkSessionFatigue(db, "calm-sess");
    expect(result.fatigued).toBe(false);
  });

  test("returns fatigued when error rate accelerates", () => {
    const now = Math.floor(Date.now() / 1000);
    const sessionStart = now - 120 * 60;

    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("err-sess", sessionStart);

    // 1 bugfix early
    db.db
      .query(
        `INSERT INTO observations (session_id, project_id, type, title, user_id, device_id, created_at, created_at_epoch)
         VALUES (?, 1, 'bugfix', 'old fix', 'user', 'dev', datetime('now'), ?)`
      )
      .run("err-sess", now - 90 * 60);

    // 4 bugfixes in last 30 min
    for (let i = 0; i < 4; i++) {
      db.db
        .query(
          `INSERT INTO observations (session_id, project_id, type, title, user_id, device_id, created_at, created_at_epoch)
           VALUES (?, 1, 'bugfix', 'recent fix', 'user', 'dev', datetime('now'), ?)`
        )
        .run("err-sess", now - 15 * 60 + i);
    }

    const result = checkSessionFatigue(db, "err-sess");
    expect(result.fatigued).toBe(true);
    expect(result.message).toContain("error rate");
  });

  test("returns fatigued when session exceeds p90 duration", () => {
    const now = Math.floor(Date.now() / 1000);

    // Insert historical sessions (3 short ones to set p90)
    for (let i = 0; i < 5; i++) {
      db.db
        .query(
          `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch, completed_at_epoch)
           VALUES (?, 'user', 'dev', 'completed', ?, ?)`
        )
        .run(`hist-${i}`, now - 3600 * 24, now - 3600 * 24 + 30 * 60); // 30 min each
    }

    // Current session: 60 min (well past p90 of 30 min)
    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("long-sess", now - 60 * 60);

    const result = checkSessionFatigue(db, "long-sess");
    expect(result.fatigued).toBe(true);
    expect(result.message).toContain("longer than 90%");
  });

  test("respects debounce interval", () => {
    const now = Math.floor(Date.now() / 1000);

    db.db
      .query(
        `INSERT INTO sessions (session_id, user_id, device_id, status, started_at_epoch)
         VALUES (?, 'user', 'dev', 'active', ?)`
      )
      .run("debounce-sess", now - 30 * 60);

    // First call should proceed
    const first = checkSessionFatigue(db, "debounce-sess");
    expect(first.fatigued).toBe(false);

    // Second call within 10 min should be debounced
    const second = checkSessionFatigue(db, "debounce-sess");
    expect(second.fatigued).toBe(false);
    expect(second.sessionMinutes).toBe(0); // debounced returns 0
  });

  test("handles no session gracefully", () => {
    const result = checkSessionFatigue(db, "nonexistent");
    expect(result.fatigued).toBe(false);
  });
});
