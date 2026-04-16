/**
 * memory_stats MCP tool.
 *
 * Gives a compact operational view of the memory layer so users can
 * understand what has been captured and synced.
 */

import type { MemDatabase } from "../storage/sqlite.js";
import { classifyOutboxFailure, getOutboxFailureSummaries, getOutboxStats } from "../storage/outbox.js";
import { computeSessionValueSignals } from "../intelligence/value-signals.js";
import { computeSessionInsights } from "../intelligence/session-insights.js";
import { getHandoffMessageFilterSql, getInboxMessageCount } from "./inbox-messages.js";

export interface MemoryStatsResult {
  active_observations: number;
  user_prompts: number;
  tool_events: number;
  messages: number;
  inbox_messages: number;
  handoffs: number;
  session_summaries: number;
  decisions: number;
  lessons: number;
  discoveries: number;
  features: number;
  refactors: number;
  repeated_patterns: number;
  security_findings: number;
  critical_security_findings: number;
  delivery_review_ready: boolean;
  vibe_guardian_active: boolean;
  summaries_with_learned: number;
  summaries_with_completed: number;
  summaries_with_next_steps: number;
  total_summary_sections_present: number;
  recent_requests: string[];
  recent_lessons: string[];
  recent_completed: string[];
  next_steps: string[];
  installed_packs: string[];
  outbox: Record<string, number>;
  outbox_failure_summary: { category: string; error: string; count: number }[];
}

export function getMemoryStats(db: MemDatabase): MemoryStatsResult {
  const activeObservations = db.getActiveObservationCount();
  const handoffs = db.db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM observations
       WHERE ${getHandoffMessageFilterSql({ include_aging: true })}`
    )
    .get()?.count ?? 0;
  const inboxMessages = getInboxMessageCount(db);
  const userPrompts = db.db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM user_prompts")
    .get()?.count ?? 0;
  const toolEvents = db.db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM tool_events")
    .get()?.count ?? 0;

  const sessionSummaries = db.db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM session_summaries")
    .get()?.count ?? 0;

  const observations = db.db
    .query<any, []>(
      `SELECT * FROM observations
       WHERE lifecycle IN ('active', 'aging', 'pinned') AND superseded_by IS NULL`
    )
    .all();
  const securityFindings = db.db
    .query<any, []>("SELECT * FROM security_findings ORDER BY created_at_epoch DESC LIMIT 500")
    .all();
  const summaries = db.db
    .query<any, []>("SELECT * FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 50")
    .all();
  const signals = computeSessionValueSignals(observations, securityFindings);
  const insights = computeSessionInsights(summaries, observations);

  return {
    active_observations: activeObservations,
    user_prompts: userPrompts,
    tool_events: toolEvents,
    messages: inboxMessages,
    inbox_messages: inboxMessages,
    handoffs,
    session_summaries: sessionSummaries,
    decisions: signals.decisions_count,
    lessons: signals.lessons_count,
    discoveries: signals.discoveries_count,
    features: signals.features_count,
    refactors: signals.refactors_count,
    repeated_patterns: signals.repeated_patterns_count,
    security_findings: signals.security_findings_count,
    critical_security_findings: signals.critical_security_findings_count,
    delivery_review_ready: signals.delivery_review_ready,
    vibe_guardian_active: signals.vibe_guardian_active,
    summaries_with_learned: insights.summaries_with_learned,
    summaries_with_completed: insights.summaries_with_completed,
    summaries_with_next_steps: insights.summaries_with_next_steps,
    total_summary_sections_present: insights.total_summary_sections_present,
    recent_requests: insights.recent_requests,
    recent_lessons: insights.recent_lessons,
    recent_completed: insights.recent_completed,
    next_steps: insights.next_steps,
    installed_packs: db.getInstalledPacks(),
    outbox: getOutboxStats(db),
    outbox_failure_summary: getOutboxFailureSummaries(db).map((row) => ({
      category: classifyOutboxFailure(row.error),
      error: row.error,
      count: row.count,
    })),
  };
}
