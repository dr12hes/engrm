/**
 * Telemetry beacon — session-end metadata payload.
 *
 * GDPR-safe: metadata only, never content. Sent fire-and-forget
 * at session end to give visibility into agent distribution,
 * stacks, and engagement.
 */

import type { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { detectStacks } from "./stack-detect.js";
import { computeSessionValueSignals } from "../intelligence/value-signals.js";
import { computeSessionInsights } from "../intelligence/session-insights.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TelemetryBeacon {
  device_id: string;
  agent: string;
  session_duration_s: number;
  observation_count: number;
  observations_by_type: Record<string, number>;
  tool_calls_count: number;
  files_touched_count: number;
  searches_performed: number;
  observer_events: number;
  observer_observations: number;
  observer_skips: number;
  sentinel_used: boolean;
  risk_score: number;
  stacks_detected: string[];
  client_version: string;
  // Memory performance metrics
  context_observations_injected: number;
  context_total_available: number;
  recall_attempts: number;
  recall_hits: number;
  search_count: number;
  search_results_total: number;
  // Session value signals
  decisions_count: number;
  lessons_count: number;
  discoveries_count: number;
  features_count: number;
  refactors_count: number;
  repeated_patterns_count: number;
  security_findings_count: number;
  critical_security_findings_count: number;
  delivery_review_ready: boolean;
  vibe_guardian_active: boolean;
  summaries_with_learned: number;
  summaries_with_completed: number;
  summaries_with_next_steps: number;
  total_summary_sections_present: number;
  // Config fingerprint (optional — missing on old clients)
  config_hash?: string;
  config_changed?: boolean;
  config_fingerprint_detail?: string;
}

/**
 * Read observer state from session state file.
 */
function readObserverState(sessionId: string): { eventCount: number; saveCount: number } {
  try {
    const statePath = join(homedir(), ".engrm", "observer-sessions", `${sessionId}.json`);
    if (!existsSync(statePath)) return { eventCount: 0, saveCount: 0 };
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    return {
      eventCount: typeof state.eventCount === "number" ? state.eventCount : 0,
      saveCount: typeof state.saveCount === "number" ? state.saveCount : 0,
    };
  } catch {
    return { eventCount: 0, saveCount: 0 };
  }
}

/**
 * Build a telemetry beacon from session data.
 * Returns null if session not found.
 * @param metrics - SessionMetrics from the MCP server (optional, for hooks that don't have it)
 */
export function buildBeacon(
  db: MemDatabase,
  config: Config,
  sessionId: string,
  metrics?: {
    contextObsInjected?: number;
    contextTotalAvailable?: number;
    recallAttempts?: number;
    recallHits?: number;
    searchCount?: number;
    searchResultsTotal?: number;
  }
): TelemetryBeacon | null {
  const session = db.getSessionMetrics(sessionId);
  if (!session) return null;

  // Compute session duration
  const startedAt = session.started_at_epoch ?? 0;
  const completedAt = session.completed_at_epoch ?? Math.floor(Date.now() / 1000);
  const durationS = Math.max(0, completedAt - startedAt);

  // Count observations by type
  const observations = db.getObservationsBySession(sessionId);
  const byType: Record<string, number> = {};
  for (const obs of observations) {
    byType[obs.type] = (byType[obs.type] ?? 0) + 1;
  }

  let securityFindings = [];
  try {
    if (session.project_id) {
      securityFindings = db
        .getSecurityFindings(session.project_id, { limit: 200 })
        .filter((f) => f.session_id === sessionId);
    }
  } catch {
    securityFindings = [];
  }

  const valueSignals = computeSessionValueSignals(observations, securityFindings);
  const summaries = session.project_id
    ? db.getRecentSummaries(session.project_id, 20).filter((summary) => summary.session_id === sessionId)
    : [];
  const sessionInsights = computeSessionInsights(summaries, observations);

  // Collect file paths for stack detection
  const filePaths: string[] = [];
  for (const obs of observations) {
    if (obs.files_modified) {
      filePaths.push(...obs.files_modified.split(",").map((f) => f.trim()));
    }
    if (obs.files_read) {
      filePaths.push(...obs.files_read.split(",").map((f) => f.trim()));
    }
  }

  const stacks = detectStacks(filePaths);

  // Risk score (from session if available)
  let riskScore = 0;
  try {
    const row = db.getSessionMetrics(sessionId) as Record<string, unknown>;
    riskScore = typeof row?.risk_score === "number" ? row.risk_score : 0;
  } catch {
    // risk_score column may not exist
  }

  // Config fingerprint from state file
  let configHash: string | undefined;
  let configChanged: boolean | undefined;
  let configFingerprintDetail: string | undefined;
  try {
    const fpPath = join(homedir(), ".engrm", "config-fingerprint.json");
    if (existsSync(fpPath)) {
      const fp = JSON.parse(readFileSync(fpPath, "utf-8"));
      configHash = fp.config_hash;
      configChanged = fp.config_changed;
      configFingerprintDetail = JSON.stringify({
        claude_md_hash: fp.claude_md_hash,
        memory_md_hash: fp.memory_md_hash,
        engrm_json_hash: fp.engrm_json_hash,
        memory_file_count: fp.memory_file_count,
        client_version: fp.client_version,
      });
    }
  } catch {
    // Fingerprint is optional
  }

  // Observer counters from session state file
  const observerState = readObserverState(sessionId);
  const observerEvents = observerState.eventCount;
  const observerObservations = observerState.saveCount;
  const observerSkips = Math.max(0, observerEvents - observerObservations);

  return {
    device_id: config.device_id,
    agent: session.agent ?? "claude-code",
    session_duration_s: durationS,
    observation_count: observations.length,
    observations_by_type: byType,
    tool_calls_count: session.tool_calls_count ?? 0,
    files_touched_count: session.files_touched_count ?? 0,
    searches_performed: session.searches_performed ?? 0,
    observer_events: observerEvents,
    observer_observations: observerObservations,
    observer_skips: observerSkips,
    sentinel_used: valueSignals.security_findings_count > 0,
    risk_score: riskScore,
    stacks_detected: stacks,
    client_version: "0.4.20",
    // Memory performance metrics
    context_observations_injected: metrics?.contextObsInjected ?? 0,
    context_total_available: metrics?.contextTotalAvailable ?? 0,
    recall_attempts: metrics?.recallAttempts ?? 0,
    recall_hits: metrics?.recallHits ?? 0,
    search_count: metrics?.searchCount ?? 0,
    search_results_total: metrics?.searchResultsTotal ?? 0,
    decisions_count: valueSignals.decisions_count,
    lessons_count: valueSignals.lessons_count,
    discoveries_count: valueSignals.discoveries_count,
    features_count: valueSignals.features_count,
    refactors_count: valueSignals.refactors_count,
    repeated_patterns_count: valueSignals.repeated_patterns_count,
    security_findings_count: valueSignals.security_findings_count,
    critical_security_findings_count: valueSignals.critical_security_findings_count,
    delivery_review_ready: valueSignals.delivery_review_ready,
    vibe_guardian_active: valueSignals.vibe_guardian_active,
    summaries_with_learned: sessionInsights.summaries_with_learned,
    summaries_with_completed: sessionInsights.summaries_with_completed,
    summaries_with_next_steps: sessionInsights.summaries_with_next_steps,
    total_summary_sections_present: sessionInsights.total_summary_sections_present,
    // Config fingerprint
    config_hash: configHash,
    config_changed: configChanged,
    config_fingerprint_detail: configFingerprintDetail,
  };
}

/**
 * Send a telemetry beacon to the server. Fire-and-forget with 3s timeout.
 * Never throws.
 */
export async function sendBeacon(
  config: Config,
  beacon: TelemetryBeacon
): Promise<void> {
  if (!config.candengo_url || !config.candengo_api_key) return;

  const url = `${config.candengo_url.replace(/\/$/, "")}/v1/mem/telemetry`;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.candengo_api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(beacon),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Fire-and-forget — never crash
  }
}
