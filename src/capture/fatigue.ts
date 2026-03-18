/**
 * Session fatigue detection.
 *
 * Monitors error rate acceleration and session duration to nudge
 * developers when they may be fatigued. Runs in the post-tool-use
 * hook on Bash errors, debounced to every 10 minutes.
 */

import type { MemDatabase } from "../storage/sqlite.js";

export interface FatigueResult {
  fatigued: boolean;
  message?: string;
  sessionMinutes: number;
  recentErrorRate: number;
}

interface UserStats {
  avgDurationMinutes: number;
  p90DurationMinutes: number;
}

const DEBOUNCE_MINUTES = 10;
const DEFAULT_AVG_SESSION_MINUTES = 90;
const DEFAULT_P90_SESSION_MINUTES = 180;
const ERROR_ACCELERATION_THRESHOLD = 2.0;
const RECENT_WINDOW_MINUTES = 30;

/**
 * Compute average and p90 session duration from completed sessions.
 * Exported for testing.
 */
export function computeUserStats(
  db: MemDatabase
): UserStats {
  const rows = db.db
    .query<
      { duration: number },
      []
    >(
      `SELECT (completed_at_epoch - started_at_epoch) / 60.0 AS duration
       FROM sessions
       WHERE status = 'completed'
         AND started_at_epoch IS NOT NULL
         AND completed_at_epoch IS NOT NULL
         AND completed_at_epoch > started_at_epoch
       ORDER BY duration ASC`
    )
    .all();

  if (rows.length < 3) {
    return {
      avgDurationMinutes: DEFAULT_AVG_SESSION_MINUTES,
      p90DurationMinutes: DEFAULT_P90_SESSION_MINUTES,
    };
  }

  const durations = rows.map((r) => r.duration);
  const sum = durations.reduce((a, b) => a + b, 0);
  const avg = sum / durations.length;

  // p90: index at 90th percentile
  const p90Index = Math.floor(durations.length * 0.9);
  const p90 = durations[Math.min(p90Index, durations.length - 1)];

  return {
    avgDurationMinutes: avg,
    p90DurationMinutes: p90,
  };
}

/**
 * Compute error rate acceleration for a session.
 *
 * Compares the bugfix observation rate in the last 30 minutes
 * against the session-wide average rate.
 *
 * Returns the ratio (recent / average). A ratio >= 2.0 means
 * the developer is hitting errors at 2x their session average.
 *
 * Exported for testing.
 */
export function computeErrorAcceleration(
  db: MemDatabase,
  sessionId: string,
  nowEpoch: number
): { ratio: number; recentCount: number; sessionCount: number } {
  const recentWindowStart = nowEpoch - RECENT_WINDOW_MINUTES * 60;

  // Session start time
  const sessionRow = db.db
    .query<{ started_at_epoch: number }, [string]>(
      "SELECT started_at_epoch FROM sessions WHERE session_id = ?"
    )
    .get(sessionId);

  if (!sessionRow || !sessionRow.started_at_epoch) {
    return { ratio: 0, recentCount: 0, sessionCount: 0 };
  }

  const sessionStartEpoch = sessionRow.started_at_epoch;
  const sessionMinutes = (nowEpoch - sessionStartEpoch) / 60;

  if (sessionMinutes < 5) {
    // Too early to judge
    return { ratio: 0, recentCount: 0, sessionCount: 0 };
  }

  // Count bugfix observations for this session (total)
  const totalRow = db.db
    .query<{ cnt: number }, [string]>(
      `SELECT COUNT(*) as cnt FROM observations
       WHERE session_id = ? AND type = 'bugfix'`
    )
    .get(sessionId);

  const sessionCount = totalRow?.cnt ?? 0;

  // Count bugfix observations in the recent window
  const recentRow = db.db
    .query<{ cnt: number }, [string, number]>(
      `SELECT COUNT(*) as cnt FROM observations
       WHERE session_id = ? AND type = 'bugfix' AND created_at_epoch >= ?`
    )
    .get(sessionId, recentWindowStart);

  const recentCount = recentRow?.cnt ?? 0;

  if (sessionCount === 0) {
    return { ratio: 0, recentCount: 0, sessionCount: 0 };
  }

  // Rate per 30 minutes
  const sessionRate = (sessionCount / sessionMinutes) * RECENT_WINDOW_MINUTES;
  const recentRate = recentCount; // already in a 30-min window

  if (sessionRate === 0) {
    return { ratio: 0, recentCount, sessionCount };
  }

  return {
    ratio: recentRate / sessionRate,
    recentCount,
    sessionCount,
  };
}

/**
 * Check whether the current session shows signs of developer fatigue.
 *
 * Called from the post-tool-use hook on Bash errors. Debounced to
 * run at most once every 10 minutes per session.
 */
export function checkSessionFatigue(
  db: MemDatabase,
  sessionId: string
): FatigueResult {
  const nowEpoch = Math.floor(Date.now() / 1000);

  // --- Debounce: only check every 10 minutes ---
  const debounceKey = `fatigue_last_check:${sessionId}`;
  const lastCheck = db.db
    .query<{ value: string }, [string]>(
      "SELECT value FROM sync_state WHERE key = ?"
    )
    .get(debounceKey);

  if (lastCheck) {
    const lastCheckEpoch = parseInt(lastCheck.value, 10);
    if (nowEpoch - lastCheckEpoch < DEBOUNCE_MINUTES * 60) {
      return { fatigued: false, sessionMinutes: 0, recentErrorRate: 0 };
    }
  }

  // Update debounce timestamp
  db.db
    .query("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)")
    .run(debounceKey, String(nowEpoch));

  // --- Session duration ---
  const sessionRow = db.db
    .query<{ started_at_epoch: number }, [string]>(
      "SELECT started_at_epoch FROM sessions WHERE session_id = ?"
    )
    .get(sessionId);

  if (!sessionRow || !sessionRow.started_at_epoch) {
    return { fatigued: false, sessionMinutes: 0, recentErrorRate: 0 };
  }

  const sessionMinutes = (nowEpoch - sessionRow.started_at_epoch) / 60;

  // --- Error rate acceleration ---
  const acceleration = computeErrorAcceleration(db, sessionId, nowEpoch);

  // --- User historical stats ---
  const stats = computeUserStats(db);

  // --- Evaluate signals ---
  const reasons: string[] = [];

  if (acceleration.ratio >= ERROR_ACCELERATION_THRESHOLD && acceleration.recentCount >= 2) {
    reasons.push(
      `your error rate in the last 30 min is ${acceleration.ratio.toFixed(1)}x your session average`
    );
  }

  if (sessionMinutes > stats.p90DurationMinutes) {
    const hours = Math.floor(sessionMinutes / 60);
    const mins = Math.round(sessionMinutes % 60);
    reasons.push(
      `this session (${hours}h${mins}m) is longer than 90% of your past sessions`
    );
  }

  if (reasons.length === 0) {
    return {
      fatigued: false,
      sessionMinutes,
      recentErrorRate: acceleration.recentCount,
    };
  }

  const message = `Consider taking a break — ${reasons.join(", and ")}.`;

  return {
    fatigued: true,
    message,
    sessionMinutes,
    recentErrorRate: acceleration.recentCount,
  };
}
