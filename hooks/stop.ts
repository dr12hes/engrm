#!/usr/bin/env bun
/**
 * Stop hook for Claude Code.
 *
 * Fires when Claude finishes responding. We:
 *   1. Check stop_hook_active to prevent infinite loops
 *   2. Complete the session in the database
 *   3. Generate a retrospective summary from session observations
 *   4. Exit 0 to allow Claude to stop
 */

import { extractRetrospective } from "../src/capture/retrospective.js";
import { parseStdinJson, bootstrapHook, runHook } from "../src/hooks/common.js";
import { computeRiskScore, formatRiskTrafficLight } from "../src/capture/risk-score.js";
import { pushOnce } from "../src/sync/push-once.js";
import { buildBeacon, sendBeacon } from "../src/telemetry/beacon.js";
import { detectProject } from "../src/storage/projects.js";
import {
  readTranscript,
  truncateTranscript,
  analyzeTranscript,
  saveTranscriptResults,
} from "../src/capture/transcript.js";

import type { InsertSessionSummary, ObservationRow, UserPromptRow } from "../src/storage/sqlite.js";

function printRetrospective(summary: InsertSessionSummary): void {
  const lines: string[] = [];
  lines.push("");
  lines.push("━━━ Engrm Session Summary ━━━");
  lines.push("");

  if (summary.request) {
    lines.push(`📋 Request: ${summary.request}`);
    lines.push("");
  }
  if (summary.investigated) {
    lines.push("🔍 Investigated:");
    lines.push(summary.investigated);
    lines.push("");
  }
  if (summary.learned) {
    lines.push("💡 Learned:");
    lines.push(summary.learned);
    lines.push("");
  }
  if (summary.completed) {
    lines.push("✅ Completed:");
    lines.push(summary.completed);
    lines.push("");
  }
  if (summary.next_steps) {
    lines.push("➡️  Next Steps:");
    lines.push(summary.next_steps);
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(lines.join("\n"));
}

interface StopEvent {
  session_id: string;
  hook_event_name: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
  cwd: string;
  transcript_path?: string;
}

async function main(): Promise<void> {
  const event = await parseStdinJson<StopEvent>();
  if (!event) process.exit(0);

  // Prevent infinite loops — if we're already in a stop hook, just exit
  if (event.stop_hook_active) process.exit(0);

  const boot = bootstrapHook("stop");
  if (!boot) process.exit(0);

  const { config, db } = boot;

  try {
    // Complete the session
    if (event.session_id) {
      db.completeSession(event.session_id);

      if (event.last_assistant_message) {
        try {
          createAssistantCheckpoint(db, event.session_id, event.cwd, event.last_assistant_message);
        } catch {
          // Assistant checkpoint is optional — don't block shutdown
        }
      }

      // Generate retrospective — only if we haven't already for this session
      const existing = db.getSessionSummary(event.session_id);
      if (!existing) {
        const observations = db.getObservationsBySession(event.session_id);
        const session = db.getSessionMetrics(event.session_id);
        const summary =
          extractRetrospective(
            observations,
            event.session_id,
            session?.project_id ?? null,
            config.user_id
          ) ??
          buildFallbackSessionSummary(
            db,
            event.session_id,
            session?.project_id ?? null,
            config.user_id,
            event.last_assistant_message
          );

        if (summary) {
          const row = db.insertSessionSummary(summary);
          db.addToOutbox("summary", row.id);

          // Compute risk score
          let securityFindings: import("../src/storage/sqlite.js").SecurityFindingRow[] = [];
          try {
            if (session?.project_id) {
              securityFindings = db.getSecurityFindings(session.project_id, { limit: 100 })
                .filter((f) => f.session_id === event.session_id);
            }
          } catch {
            // security_findings table may not exist
          }

          const riskResult = computeRiskScore({
            observations,
            securityFindings,
            filesTouchedCount: session?.files_touched_count ?? 0,
            toolCallsCount: session?.tool_calls_count ?? 0,
          });

          // Store risk score
          try {
            db.setSessionRiskScore(event.session_id, riskResult.score);
          } catch {
            // risk_score column may not exist on old schema
          }

          // Display session retrospective to the user
          printRetrospective(summary);
          console.log(formatRiskTrafficLight(riskResult));
        }
      }
    }
    // Detect unsaved plans/decisions in the final assistant message
    if (event.last_assistant_message) {
      const unsaved = detectUnsavedPlans(event.last_assistant_message);
      if (unsaved.length > 0) {
        console.error("");
        console.error("💡 Engrm: This session contained output that wasn't saved to a file:");
        for (const hint of unsaved) {
          console.error(`   • ${hint}`);
        }
        console.error("   Tip: Ask Claude to write plans/decisions to a file so they're captured.");
      }
    }

    // Create a session digest observation — this is the key "memory" that
    // future sessions will see as "lessons from previous sessions".
    if (event.session_id) {
      try {
        createSessionDigest(db, event.session_id, event.cwd);
      } catch {
        // Digest creation is optional — don't block shutdown
      }
    }

    // --- Transcript analysis (opt-in) ---
    if (config.transcript_analysis?.enabled && event.session_id) {
      try {
        const messages = readTranscript(
          event.session_id,
          event.cwd,
          event.transcript_path
        );
        if (messages.length > 10) {
          const transcript = truncateTranscript(messages);
          const results = await analyzeTranscript(config, transcript, event.session_id);
          if (results) {
            const saved = await saveTranscriptResults(
              db, config, results, event.session_id, event.cwd
            );
            if (saved > 0) {
              console.error(`\n💡 Engrm: Extracted ${saved} insight(s) from session transcript.`);
            }
          }
        }
      } catch {
        // Transcript analysis is optional — don't block shutdown
      }
    }

    // Push all pending observations to Candengo Vector before exiting.
    // This is the last chance — the MCP server's sync timer may not fire again.
    await pushOnce(db, config);

    // Send telemetry beacon — fire-and-forget, metadata only
    try {
      if (event.session_id) {
        // Read all session metrics from state files
        const metrics = readSessionMetrics(event.session_id);
        const beacon = buildBeacon(db, config, event.session_id, metrics);
        if (beacon) {
          await sendBeacon(config, beacon);
        }
      }
    } catch {
      // Telemetry must never block shutdown
    }
  } finally {
    db.close();
  }

  // Exit 0 — allow Claude to stop
  process.exit(0);
}

function buildFallbackSessionSummary(
  db: MemDatabase,
  sessionId: string,
  projectId: number | null,
  userId: string,
  lastAssistantMessage: string
): InsertSessionSummary | null {
  const prompts = db
    .getSessionUserPrompts(sessionId, 10)
    .filter((prompt) => isMeaningfulSummaryPrompt(prompt));
  const checkpoint = lastAssistantMessage
    ? extractAssistantCheckpoint(lastAssistantMessage)
    : null;

  const request = selectFallbackRequest(prompts);
  const completed = checkpoint ? buildCheckpointCompleted(checkpoint) : null;

  if (!request && !completed) return null;

  return {
    session_id: sessionId,
    project_id: projectId,
    user_id: userId,
    request,
    investigated: null,
    learned: null,
    completed,
    next_steps: null,
  };
}

function selectFallbackRequest(prompts: UserPromptRow[]): string | null {
  const preferred = [...prompts]
    .reverse()
    .find((prompt) => !/^\[;ease$/i.test(prompt.prompt.trim()));
  return preferred?.prompt?.replace(/\s+/g, " ").trim() ?? null;
}

function isMeaningfulSummaryPrompt(prompt: UserPromptRow): boolean {
  const compact = prompt.prompt.replace(/\s+/g, " ").trim();
  if (compact.length < 8) return false;
  if (/^\[;ease$/i.test(compact)) return false;
  return /[a-z]{3,}/i.test(compact);
}

function buildCheckpointCompleted(checkpoint: {
  title: string;
  facts: string[];
}): string {
  const lines = [`- ${checkpoint.title}`];
  for (const fact of checkpoint.facts.slice(0, 2)) {
    lines.push(`  - ${fact}`);
  }
  return lines.join("\n");
}

/**
 * Create a digest observation summarising the session.
 * This digest becomes a high-quality observation that future sessions
 * will see in their context injection — the "lessons learned" effect.
 */
function createSessionDigest(
  db: MemDatabase,
  sessionId: string,
  cwd: string
): void {
  const observations = db.getObservationsBySession(sessionId);
  if (observations.length < 2) return; // Not enough to digest

  // Don't create duplicate digests
  const existing = observations.find(
    (o) => o.type === "digest" && o.session_id === sessionId
  );
  if (existing) return;

  // Resolve project
  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);
  if (!project) return;

  // Build narrative from meaningful observations (skip noise)
  const meaningful = observations.filter(
    (o) => o.type !== "change" || (o.narrative && o.narrative.length > 100)
  );
  if (meaningful.length === 0) return;

  // Group by type for structured narrative
  const byType = new Map<string, ObservationRow[]>();
  for (const obs of meaningful) {
    const group = byType.get(obs.type) ?? [];
    group.push(obs);
    byType.set(obs.type, group);
  }

  const sections: string[] = [];
  const TYPE_LABELS: Record<string, string> = {
    discovery: "Investigated",
    bugfix: "Fixed",
    decision: "Decided",
    pattern: "Patterns found",
    feature: "Built",
    refactor: "Refactored",
    change: "Changed",
  };

  for (const [type, obs] of byType) {
    if (type === "digest") continue; // Skip existing digests
    const label = TYPE_LABELS[type] ?? type;
    const bullets = obs
      .slice(0, 5)
      .map((o) => `- ${o.title}`)
      .join("\n");
    sections.push(`${label}:\n${bullets}`);
  }

  if (sections.length === 0) return;

  // Collect all facts from observations
  const allFacts = new Set<string>();
  for (const obs of meaningful) {
    if (obs.facts) {
      try {
        const parsed = JSON.parse(obs.facts);
        if (Array.isArray(parsed)) {
          for (const f of parsed) {
            if (typeof f === "string" && f.length > 0) allFacts.add(f);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Collect concepts
  const allConcepts = new Set<string>();
  for (const obs of meaningful) {
    if (obs.concepts) {
      try {
        const parsed = JSON.parse(obs.concepts);
        if (Array.isArray(parsed)) {
          for (const c of parsed) {
            if (typeof c === "string" && c.length > 0) allConcepts.add(c);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Build title from most significant observations
  const significant = meaningful.filter(
    (o) => o.type !== "change" && o.quality >= 0.5
  );
  const title =
    significant.length > 0
      ? significant.length <= 2
        ? significant.map((o) => o.title).join("; ")
        : `${significant[0]!.title} (+${significant.length - 1} more)`
      : `Session: ${meaningful.length} observations`;

  const maxQuality = Math.max(...meaningful.map((o) => o.quality), 0.5);

  const digestObs = db.insertObservation({
    session_id: sessionId,
    project_id: project.id,
    type: "digest",
    title,
    narrative: `Session digest (${observations.length} observations):\n\n${sections.join("\n\n")}`,
    facts: allFacts.size > 0 ? JSON.stringify([...allFacts].slice(0, 20)) : null,
    concepts:
      allConcepts.size > 0
        ? JSON.stringify([...allConcepts].slice(0, 15))
        : null,
    quality: Math.min(1, maxQuality + 0.1), // Slight boost so digests surface
    lifecycle: "active",
    sensitivity: "shared",
    user_id: observations[0]!.user_id,
    device_id: observations[0]!.device_id,
    agent: observations[0]!.agent,
  });

  db.addToOutbox("observation", digestObs.id);
}

function createAssistantCheckpoint(
  db: MemDatabase,
  sessionId: string,
  cwd: string,
  message: string
): void {
  const checkpoint = extractAssistantCheckpoint(message);
  if (!checkpoint) return;

  const existing = db
    .getObservationsBySession(sessionId)
    .find((obs) => obs.source_tool === "assistant-stop" && obs.title === checkpoint.title);
  if (existing) return;

  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);
  if (!project) return;

  const promptNumber = db.getLatestSessionPromptNumber(sessionId);
  const row = db.insertObservation({
    session_id: sessionId,
    project_id: project.id,
    type: checkpoint.type,
    title: checkpoint.title,
    narrative: checkpoint.narrative,
    facts: checkpoint.facts.length > 0 ? JSON.stringify(checkpoint.facts.slice(0, 8)) : null,
    quality: checkpoint.quality,
    lifecycle: "active",
    sensitivity: "shared",
    user_id: db.getSessionById(sessionId)?.user_id ?? "unknown",
    device_id: db.getSessionById(sessionId)?.device_id ?? "unknown",
    agent: db.getSessionById(sessionId)?.agent ?? "claude-code",
    source_tool: "assistant-stop",
    source_prompt_number: promptNumber,
  });
  db.addToOutbox("observation", row.id);
}

function extractAssistantCheckpoint(message: string): {
  type: "decision" | "change" | "feature";
  title: string;
  narrative: string;
  facts: string[];
  quality: number;
} | null {
  const compact = message.replace(/\r/g, "").trim();
  if (compact.length < 180) return null;

  const normalizedLines = compact
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletLines = compact
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 20)
    .slice(0, 8);

  const substantiveLines = compact
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#+\s*/.test(line))
    .filter((line) => !/^[-*]\s*$/.test(line));

  const title = pickAssistantCheckpointTitle(substantiveLines, bulletLines);
  if (!title) return null;

  const lowered = compact.toLowerCase();
  const headingText = normalizedLines
    .filter((line) => /^[A-Za-z][A-Za-z /_-]{2,}:$/.test(line))
    .join(" ")
    .toLowerCase();
  const hasNextSteps = normalizedLines.some((line) => /^Next Steps?:/i.test(line));
  const deploymentSignals =
    /\bdeploy|deployment|ansible|rolled out|released to staging|pushed commit|shipped to staging|launched\b/.test(lowered) ||
    /\bdeployment\b/.test(headingText);
  const decisionSignals =
    /\bdecid|recommend|strategy|pricing|trade.?off|agreed|approach|direction\b/.test(lowered) ||
    /\bdecision\b/.test(headingText);
  const featureSignals =
    /\bimplemented|introduced|exposed|added|built|created|enabled|wired\b/.test(lowered) ||
    /\bfeature\b/.test(headingText);

  const type =
    decisionSignals && !deploymentSignals
      ? "decision"
      : deploymentSignals || featureSignals
        ? "feature"
        : hasNextSteps
          ? "decision"
          : "change";

  const facts = bulletLines.filter((line) => line !== title);
  const narrative = substantiveLines.slice(0, 6).join("\n");
  return {
    type,
    title,
    narrative,
    facts,
    quality: 0.72,
  };
}

function pickAssistantCheckpointTitle(
  substantiveLines: string[],
  bulletLines: string[]
): string | null {
  const candidates = [...bulletLines, ...substantiveLines]
    .map((line) => line.replace(/^Completed:\s*/i, "").trim())
    .filter((line) => line.length > 20)
    .filter((line) => !/^Next Steps?:/i.test(line))
    .filter((line) => !/^Investigated:/i.test(line))
    .filter((line) => !/^Learned:/i.test(line));
  return candidates[0] ?? null;
}

/**
 * Detect plans, decisions, or strategies in the last assistant message
 * that weren't written to a file. Returns hint strings for each detected type.
 */
function detectUnsavedPlans(message: string): string[] {
  const hints: string[] = [];
  const lower = message.toLowerCase();
  const len = message.length;

  // Only flag substantial messages (plans tend to be long)
  if (len < 500) return hints;

  // Delivery plans / phased plans / roadmaps
  if (
    /phase\s+\d|delivery\s+plan|roadmap|timeline/i.test(message) &&
    /\|\s*task\b|\|\s*effort\b|week\s+\d/i.test(message)
  ) {
    hints.push("Delivery plan or roadmap with phases/tasks");
  }

  // Architecture decisions
  if (
    /architecture|design\s+decision|technical\s+approach/i.test(message) &&
    /option\s+[a-c]|alternative|trade.?off|recommend/i.test(message)
  ) {
    hints.push("Architecture or design decision with alternatives");
  }

  // Pricing / business strategy
  if (
    /pricing|tier|plan.*\$\d|revenue|business\s+model/i.test(message) &&
    len > 800
  ) {
    hints.push("Pricing or business strategy");
  }

  // Implementation proposals with tables
  if (
    lower.includes("proposed") &&
    message.includes("|") &&
    /implement|build|create|add/i.test(message)
  ) {
    hints.push("Implementation proposal");
  }

  return hints;
}

/**
 * Read session metrics from state files.
 * Recall metrics come from observer-sessions/{sessionId}.json (written by post-tool-use hook).
 * Context/search metrics come from mcp-session-metrics.json (written by MCP server).
 */
function readSessionMetrics(sessionId: string): {
  recallAttempts?: number;
  recallHits?: number;
  contextObsInjected?: number;
  contextTotalAvailable?: number;
  searchCount?: number;
  searchResultsTotal?: number;
} {
  const { existsSync, readFileSync, unlinkSync } = require("node:fs");
  const { join } = require("node:path");
  const { homedir } = require("node:os");

  const result: Record<string, number | undefined> = {};

  // Read recall metrics from observer-sessions state
  try {
    const obsPath = join(homedir(), ".engrm", "observer-sessions", `${sessionId}.json`);
    if (existsSync(obsPath)) {
      const state = JSON.parse(readFileSync(obsPath, "utf-8"));
      if (typeof state.recallAttempts === "number") result.recallAttempts = state.recallAttempts;
      if (typeof state.recallHits === "number") result.recallHits = state.recallHits;
    }
  } catch {
    // ignore
  }

  // Read context injection metrics from session-start hook
  try {
    const hookPath = join(homedir(), ".engrm", "hook-session-metrics.json");
    if (existsSync(hookPath)) {
      const hookMetrics = JSON.parse(readFileSync(hookPath, "utf-8"));
      if (typeof hookMetrics.contextObsInjected === "number") result.contextObsInjected = hookMetrics.contextObsInjected;
      if (typeof hookMetrics.contextTotalAvailable === "number") result.contextTotalAvailable = hookMetrics.contextTotalAvailable;
      try { unlinkSync(hookPath); } catch { /* ignore */ }
    }
  } catch {
    // ignore
  }

  // Read MCP server metrics (search, and context if MCP tool was used instead of hook)
  try {
    const mcpPath = join(homedir(), ".engrm", "mcp-session-metrics.json");
    if (existsSync(mcpPath)) {
      const metrics = JSON.parse(readFileSync(mcpPath, "utf-8"));
      // Only override context metrics if MCP tool actually injected (non-zero)
      if (typeof metrics.contextObsInjected === "number" && metrics.contextObsInjected > 0) {
        result.contextObsInjected = metrics.contextObsInjected;
      }
      if (typeof metrics.contextTotalAvailable === "number" && metrics.contextTotalAvailable > 0) {
        result.contextTotalAvailable = metrics.contextTotalAvailable;
      }
      if (typeof metrics.searchCount === "number") result.searchCount = metrics.searchCount;
      if (typeof metrics.searchResultsTotal === "number") result.searchResultsTotal = metrics.searchResultsTotal;
      // Clean up — this file is per-session
      try { unlinkSync(mcpPath); } catch { /* ignore */ }
    }
  } catch {
    // ignore
  }

  return result;
}

export const __testables = {
  extractAssistantCheckpoint,
};

runHook("stop", main);
