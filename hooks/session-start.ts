#!/usr/bin/env bun
/**
 * SessionStart hook for Claude Code.
 *
 * Fires when a new session begins. Injects relevant project memory
 * into Claude's context so the agent has prior knowledge.
 *
 * Output goes to stdout and is added to Claude's context.
 * Exit 0 = allow session to proceed.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildSessionContext,
  formatContextForInjection,
} from "../src/context/inject.js";
import type { InjectedContext } from "../src/context/inject.js";
import { detectStacksFromProject } from "../src/telemetry/stack-detect.js";
import { computeAndSaveFingerprint } from "../src/telemetry/config-fingerprint.js";
import { recommendPacks } from "../src/packs/recommender.js";
import { pullFromVector, pullSettings } from "../src/sync/pull.js";
import { VectorClient } from "../src/sync/client.js";
import { parseStdinJson, bootstrapHook, runHook } from "../src/hooks/common.js";

interface SessionStartEvent {
  session_id: string;
  hook_event_name: string;
  cwd: string;
}

async function main(): Promise<void> {
  const event = await parseStdinJson<SessionStartEvent>();
  if (!event) process.exit(0);

  const boot = bootstrapHook("session-start");
  if (!boot) process.exit(0);

  const { config, db } = boot;

  let syncedCount = 0;
  try {
    // Eager pull: fetch latest observations from server before building context.
    // This ensures new devices and cross-project observations are available immediately.
    if (config.sync.enabled && config.candengo_api_key) {
      try {
        const client = new VectorClient(config);
        const pullResult = await pullFromVector(db, client, config, 50);
        syncedCount = pullResult.merged;
        await pullSettings(client, config);
      } catch {
        // Pull/settings failure must never block session start
      }
    }

    // Config fingerprinting — silent, fire-and-forget
    try {
      computeAndSaveFingerprint(event.cwd);
    } catch {
      // Fingerprinting must never block session start
    }

    const context = buildSessionContext(db, event.cwd, {
      tokenBudget: 800,
      scope: config.search.scope,
      userId: config.user_id,
    });
    // Persist context metrics for the beacon (stop hook reads this)
    if (context) {
      try {
        const dir = join(homedir(), ".engrm");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "hook-session-metrics.json"),
          JSON.stringify({
            contextObsInjected: context.observations.length,
            contextTotalAvailable: context.total_active,
          }),
          "utf-8"
        );
      } catch {
        // Metrics persistence is best-effort
      }
    }

    if (context && context.observations.length > 0) {
      // stderr → shown to user in terminal (splash screen)
      const remaining = context.total_active - context.session_count;

      // Check for unread messages
      let msgCount = 0;
      try {
        const readKey = `messages_read_${config.device_id}`;
        const lastReadId = parseInt(db.getSyncState(readKey) ?? "0", 10);
        msgCount = db.db
          .query<{ c: number }, [number, string, string]>(
            `SELECT COUNT(*) as c FROM observations
             WHERE type = 'message'
               AND id > ?
               AND lifecycle IN ('active', 'pinned')
               AND device_id != ?
               AND (sensitivity != 'personal' OR user_id = ?)`
          )
          .get(lastReadId, config.device_id, config.user_id)?.c ?? 0;
      } catch {
        // message count is optional
      }

      const splash = formatSplashScreen({
        projectName: context.project_name,
        loaded: context.session_count,
        available: remaining,
        securityFindings: context.securityFindings?.length ?? 0,
        unreadMessages: msgCount,
        synced: syncedCount,
        context,
      });

      // Pack recommendations appended to context
      let packLine = "";
      try {
        const { stacks } = detectStacksFromProject(event.cwd);
        if (stacks.length > 0) {
          const installed = db.getInstalledPacks();
          const recs = recommendPacks(stacks, installed);
          if (recs.length > 0) {
            const names = recs.map((r) => `\`${r.name}\``).join(", ");
            packLine = `\nHelp packs available for your stack: ${names}. ` +
              `Use the install_pack tool to load curated observations.`;
          }
        }
      } catch {
        // Pack recommendations are optional
      }

      // Output as JSON with systemMessage for terminal display
      // Claude Code renders systemMessage to the user's terminal
      // and additionalContext into the agent's context
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: formatContextForInjection(context) + packLine,
        },
        systemMessage: splash,
      }));
    }
  } finally {
    db.close();
  }
}

// ANSI color helpers
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
};

interface SplashData {
  projectName: string;
  loaded: number;
  available: number;
  securityFindings: number;
  unreadMessages: number;
  synced: number;
  context: InjectedContext;
}

function formatSplashScreen(data: SplashData): string {
  const lines: string[] = [];

  // Logo
  lines.push("");
  lines.push(`${c.cyan}${c.bold}  ______  ____   _  ______  _____   ____    __${c.reset}`);
  lines.push(`${c.cyan}${c.bold}  |   ___||    \\ | ||   ___||     | |    \\  /  |${c.reset}`);
  lines.push(`${c.cyan}${c.bold}  |   ___||     \\| ||   |  ||     \\ |     \\/   |${c.reset}`);
  lines.push(`${c.cyan}${c.bold}  |______||__/\\____||______||__|\\__\\|__/\\__/|__|${c.reset}`);
  lines.push(`${c.dim}  memory layer for AI agents${c.reset}`);
  lines.push("");

  // Stats
  const dot = `${c.dim} · ${c.reset}`;

  const statParts: string[] = [];
  statParts.push(`${c.green}${data.loaded}${c.reset} loaded`);
  if (data.available > 0) {
    statParts.push(`${c.dim}${data.available.toLocaleString()} searchable${c.reset}`);
  }
  if (data.context.recentSessions && data.context.recentSessions.length > 0) {
    statParts.push(`${c.white}${data.context.recentSessions.length} sessions${c.reset}`);
  }
  if (data.context.recentPrompts && data.context.recentPrompts.length > 0) {
    statParts.push(`${c.magenta}${data.context.recentPrompts.length} requests${c.reset}`);
  }
  if (data.context.recentToolEvents && data.context.recentToolEvents.length > 0) {
    statParts.push(`${c.yellow}${data.context.recentToolEvents.length} tools${c.reset}`);
  }
  if (data.synced > 0) {
    statParts.push(`${c.cyan}${data.synced} synced${c.reset}`);
  }

  lines.push(`  ${c.white}${c.bold}engrm${c.reset}${dot}${statParts.join(dot)}`);

  // Alerts line (security findings, unread messages)
  const alerts: string[] = [];
  if (data.securityFindings > 0) {
    alerts.push(`${c.yellow}${data.securityFindings} security finding${data.securityFindings !== 1 ? "s" : ""}${c.reset}`);
  }
  if (data.unreadMessages > 0) {
    alerts.push(`${c.magenta}${data.unreadMessages} unread message${data.unreadMessages !== 1 ? "s" : ""}${c.reset}`);
  }
  if (alerts.length > 0) {
    lines.push(`  ${alerts.join(dot)}`);
  }

  // Dashboard link
  lines.push("");
  lines.push(`  ${c.dim}Dashboard: https://engrm.dev/dashboard${c.reset}`);

  const brief = formatVisibleStartupBrief(data.context);
  if (brief.length > 0) {
    lines.push("");
    lines.push(`  ${c.bold}Startup context${c.reset}`);
    for (const line of brief) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("");

  return lines.join("\n");
}

function formatVisibleStartupBrief(context: InjectedContext): string[] {
  const lines: string[] = [];
  const latest = pickPrimarySummary(context);
  const observationFallbacks = buildObservationFallbacks(context);
  const promptFallback = buildPromptFallback(context);
  const promptLines = buildPromptLines(context);
  const latestPromptLine = promptLines[0] ?? null;
  const currentRequest = latest
    ? chooseRequest(
        latest.request,
        promptFallback ?? sessionFallbacksFromContext(context)[0] ?? observationFallbacks.request
      )
    : promptFallback;
  const toolFallbacks = buildToolFallbacks(context);
  const sessionFallbacks = sessionFallbacksFromContext(context);
  const recentOutcomeLines = buildRecentOutcomeLines(context, latest);
  const projectSignals = buildProjectSignalLine(context);

  if (promptLines.length > 0) {
    lines.push(`${c.cyan}Recent Requests:${c.reset}`);
    for (const item of promptLines) {
      lines.push(`  - ${truncateInline(item, 160)}`);
    }
  }

  if (latest) {
    const sections: Array<[string, string | null, number]> = [
      ["Request", currentRequest, 1],
      ["Investigated", chooseSection(latest.investigated, observationFallbacks.investigated, "Investigated"), 2],
      ["Learned", latest.learned, 2],
      ["Completed", chooseSection(latest.completed, observationFallbacks.completed, "Completed"), 2],
      ["Next Steps", latest.next_steps, 2],
    ];

    for (const [label, value, maxItems] of sections) {
      const formatted = toSplashLines(value, maxItems ?? 2);
      if (formatted.length > 0) {
        lines.push(`${c.cyan}${label}:${c.reset}`);
        for (const item of formatted) {
          lines.push(`  ${item}`);
        }
      }
    }
  } else if (currentRequest && !duplicatesPromptLine(currentRequest, latestPromptLine)) {
    lines.push(`${c.cyan}Current Request:${c.reset}`);
    lines.push(`  - ${truncateInline(currentRequest, 160)}`);
    if (toolFallbacks.length > 0) {
      lines.push(`${c.cyan}Recent Tools:${c.reset}`);
      for (const item of toolFallbacks) {
        lines.push(`  - ${truncateInline(item, 160)}`);
      }
    }
  }

  if (
    latest &&
    currentRequest &&
    !hasRequestSection(lines) &&
    !duplicatesPromptLine(currentRequest, latestPromptLine)
  ) {
    lines.push(`${c.cyan}Current Request:${c.reset}`);
    lines.push(`  - ${truncateInline(currentRequest, 160)}`);
  }

  if (recentOutcomeLines.length > 0) {
    lines.push(`${c.cyan}Recent Work:${c.reset}`);
    for (const item of recentOutcomeLines) {
      lines.push(`  - ${truncateInline(item, 160)}`);
    }
  }

  if (toolFallbacks.length > 0 && latest) {
    lines.push(`${c.cyan}Recent Tools:${c.reset}`);
    for (const item of toolFallbacks) {
      lines.push(`  - ${truncateInline(item, 160)}`);
    }
  }

  if (sessionFallbacks.length > 0) {
    lines.push(`${c.cyan}Recent Sessions:${c.reset}`);
    for (const item of sessionFallbacks) {
      lines.push(`  - ${truncateInline(item, 160)}`);
    }
  }

  if (projectSignals) {
    lines.push(`${c.cyan}Project Signals:${c.reset}`);
    lines.push(`  - ${truncateInline(projectSignals, 160)}`);
  }

  const stale = pickRelevantStaleDecision(context, latest);
  if (stale) {
    lines.push(
      `${c.yellow}Watch:${c.reset} ${truncateInline(
        `Decision still looks unfinished: ${stale.title}`,
        170
      )}`
    );
  }

  if (lines.length === 0 && context.observations.length > 0) {
    const top = context.observations
      .filter((obs) => obs.type !== "digest")
      .filter((obs) => obs.type !== "decision")
      .filter((obs) => !looksLikeFileOperationTitle(obs.title))
      .slice(0, 3);
    for (const obs of top) {
      lines.push(
        `${c.cyan}${capitalize(obs.type)}:${c.reset} ${truncateInline(obs.title, 170)}`
      );
    }
  }

  return lines.slice(0, 14);
}

function buildPromptFallback(context: InjectedContext): string | null {
  const latest = (context.recentPrompts ?? []).find((prompt) => isMeaningfulPrompt(prompt.prompt));
  if (!latest?.prompt) return null;
  return latest.prompt.replace(/\s+/g, " ").trim();
}

function buildPromptLines(context: InjectedContext): string[] {
  return (context.recentPrompts ?? [])
    .filter((prompt) => isMeaningfulPrompt(prompt.prompt))
    .slice(0, 2)
    .map((prompt) => {
      const prefix = prompt.prompt_number > 0 ? `#${prompt.prompt_number}` : "request";
      return `${prefix}: ${prompt.prompt.replace(/\s+/g, " ").trim()}`;
    })
    .filter((item) => item.length > 0);
}

function duplicatesPromptLine(request: string, promptLine: string | null): boolean {
  if (!request || !promptLine) return false;
  const promptBody = promptLine.replace(/^#?\d+:\s*/, "").trim();
  return normalizeStartupItem(request) === normalizeStartupItem(promptBody);
}

function buildToolFallbacks(context: InjectedContext): string[] {
  return (context.recentToolEvents ?? [])
    .slice(0, 3)
    .map((tool) => {
      const detail = tool.file_path ?? tool.command ?? tool.tool_response_preview ?? "";
      return `${tool.tool_name}${detail ? `: ${detail}` : ""}`.trim();
    })
    .filter((item) => item.length > 0);
}

function sessionFallbacksFromContext(context: InjectedContext): string[] {
  return (context.recentSessions ?? [])
    .slice(0, 2)
    .map((session) => {
      const summary = chooseMeaningfulSessionSummary(session.request, session.completed);
      if (!summary) return "";
      return `${session.session_id}: ${summary} (prompts ${session.prompt_count}, tools ${session.tool_event_count}, obs ${session.observation_count})`;
    })
    .filter((item) => item.length > 0);
}

function buildRecentOutcomeLines(
  context: InjectedContext,
  summary: NonNullable<InjectedContext["summaries"]>[number] | null
): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | null | undefined) => {
    for (const line of toSplashLines(value ?? null, 2)) {
      const normalized = normalizeStartupItem(line);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      picked.push(line.replace(/^-\s*/, ""));
      if (picked.length >= 2) return;
    }
  };

  push(summary?.completed);
  push(summary?.learned);

  if (picked.length < 2) {
    for (const obs of context.observations) {
      if (!["bugfix", "feature", "refactor", "change", "decision"].includes(obs.type)) continue;
      const title = stripInlineSectionLabel(obs.title);
      if (!title || looksLikeFileOperationTitle(title)) continue;
      const normalized = normalizeStartupItem(title);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      picked.push(title);
      if (picked.length >= 2) break;
    }
  }

  return picked;
}

function chooseMeaningfulSessionSummary(
  request: string | null | undefined,
  completed: string | null | undefined
): string | null {
  if (request && !looksLikeFileOperationTitle(request)) return request;
  if (completed) {
    const lines = completed
      .split("\n")
      .map((line) => line.trim().replace(/^[-*]\s*/, ""))
      .filter(Boolean)
      .map((line) => stripInlineSectionLabel(line))
      .filter((line) => !looksLikeFileOperationTitle(line));
    if (lines.length > 0) return lines[0] ?? null;
  }
  return request ?? completed ?? null;
}

function buildProjectSignalLine(context: InjectedContext): string | null {
  if (!context.projectTypeCounts) return null;
  const top = Object.entries(context.projectTypeCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([type, count]) => `${type} ${count}`)
    .join("; ");
  return top || null;
}

function toSplashLines(value: string | null, maxItems: number): string[] {
  if (!value) return [];
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, ""))
    .map((line) => stripInlineSectionLabel(line))
    .map((line) => dedupeFragments(line))
    .filter(Boolean)
    .sort((a, b) => scoreSplashLine(b) - scoreSplashLine(a))
    .slice(0, maxItems)
    .map((line) => `- ${truncateInline(line, 140)}`);
  return dedupeFragmentsInLines(lines);
}

function pickPrimarySummary(context: InjectedContext) {
  const summaries = context.summaries || [];
  if (!summaries.length) return null;
  const meaningfulRecent = summaries.find((summary) => {
    const request = summary.request?.trim();
    const learned = summary.learned?.trim();
    const completed = summary.completed?.trim();
    return Boolean(
      (request && !looksLikeFileOperationTitle(request)) ||
      learned ||
      hasMeaningfulCompleted(completed)
    );
  });
  return meaningfulRecent ?? summaries[0] ?? null;
}

function hasMeaningfulCompleted(value: string | null | undefined): boolean {
  if (!value) return false;
  return value
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean)
    .some((line) => !looksLikeFileOperationTitle(stripInlineSectionLabel(line)));
}

function sectionItemCount(value: string | null): number {
  if (!value) return 0;
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function dedupeFragments(text: string): string {
  const parts = text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(part);
  }
  return deduped.join("; ");
}

function dedupeFragmentsInLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const normalized = stripInlineSectionLabel(line)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(line);
  }
  return deduped;
}

function hasRequestSection(lines: string[]): boolean {
  return lines.some((line) => line.includes("Request:"));
}

function normalizeStartupItem(value: string): string {
  return stripInlineSectionLabel(value)
    .replace(/^#?\d+:\s*/, "")
    .replace(/^-\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulPrompt(value: string | null | undefined): boolean {
  if (!value) return false;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length < 8) return false;
  return /[a-z]{3,}/i.test(compact);
}

function chooseRequest(primary: string | null, fallback: string | null): string | null {
  if (primary && !looksLikeFileOperationTitle(primary)) return primary;
  return fallback;
}

function chooseSection(
  primary: string | null,
  fallback: string | null,
  label: "Investigated" | "Completed"
): string | null {
  if (!primary) return fallback;
  if (label === "Completed" && isWeakCompletedSection(primary)) return fallback || primary;
  if (label === "Investigated" && sectionItemCount(primary) === 0) return fallback;
  return primary;
}

function isWeakCompletedSection(value: string): boolean {
  const items = value
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  if (!items.length) return true;
  const weakCount = items.filter((item) => looksLikeFileOperationTitle(item)).length;
  return weakCount === items.length;
}

function looksLikeFileOperationTitle(value: string): boolean {
  return /^(modified|updated|edited|touched|changed|extended|refactored|redesigned)\s+[A-Za-z0-9_.\-\/]+(?:\s*\([^)]*\))?$/i.test(
    value.trim()
  );
}

function scoreSplashLine(value: string): number {
  let score = 0;
  if (!looksLikeFileOperationTitle(value)) score += 2;
  if (/[:;]/.test(value)) score += 1;
  if (value.length > 30) score += 0.5;
  return score;
}

function buildObservationFallbacks(context: InjectedContext): {
  request: string | null;
  investigated: string | null;
  completed: string | null;
} {
  const request = context.observations
    .find((obs) => obs.type !== "decision" && !looksLikeFileOperationTitle(obs.title))
    ?.title ?? null;

  const investigated = collectObservationTitles(
    context,
    (obs) => obs.type === "discovery",
    2
  );

  const completed = collectObservationTitles(
    context,
    (obs) =>
      ["bugfix", "feature", "refactor", "change"].includes(obs.type) &&
      !looksLikeFileOperationTitle(obs.title),
    2
  );

  return {
    request,
    investigated,
    completed,
  };
}

function collectObservationTitles(
  context: InjectedContext,
  predicate: (obs: InjectedContext["observations"][number]) => boolean,
  limit: number
): string | null {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const obs of context.observations) {
    if (!predicate(obs)) continue;
    const normalized = stripInlineSectionLabel(obs.title)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    picked.push(`- ${stripInlineSectionLabel(obs.title)}`);
    if (picked.length >= limit) break;
  }
  return picked.length ? picked.join("\n") : null;
}

function stripInlineSectionLabel(value: string): string {
  return value
    .replace(/^(request|investigated|learned|completed|next steps|digest|summary):\s*/i, "")
    .trim();
}

function pickRelevantStaleDecision(
  context: InjectedContext,
  summary: NonNullable<InjectedContext["summaries"]>[number] | null
) {
  const stale = context.staleDecisions || [];
  if (!stale.length) return null;
  const summaryText = [
    summary?.request,
    summary?.investigated,
    summary?.learned,
    summary?.completed,
    summary?.next_steps,
  ].filter(Boolean).join(" ");

  let best: typeof stale[number] | null = null;
  let bestScore = 0;
  for (const item of stale) {
    if ((item.days_ago ?? 999) > 21) continue;
    const overlap = keywordOverlap(item.title || "", summaryText);
    const similarity = item.best_match_similarity ?? 0;
    const score = overlap * 4 + similarity;
    if (score > bestScore && overlap > 0) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function keywordOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const stop = new Set([
    "the", "and", "for", "with", "from", "into", "this", "that", "was", "were",
    "have", "has", "had", "but", "not", "you", "your", "our", "their", "about",
    "added", "fixed", "created", "updated", "modified", "changed", "investigate",
    "next", "steps", "decision", "still", "looks", "unfinished"
  ]);
  const wordsA = new Set(
    a.toLowerCase().match(/[a-z0-9_+-]{4,}/g)?.filter((w) => !stop.has(w)) || []
  );
  const wordsB = new Set(
    b.toLowerCase().match(/[a-z0-9_+-]{4,}/g)?.filter((w) => !stop.has(w)) || []
  );
  if (!wordsA.size || !wordsB.size) return 0;
  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }
  return overlap / Math.max(1, Math.min(wordsA.size, wordsB.size));
}

function truncateInline(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1).trimEnd()}…`;
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const __testables = {
  formatVisibleStartupBrief,
};

runHook("session-start", main);
