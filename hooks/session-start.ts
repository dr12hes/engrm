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
  estimateTokens,
  formatContextForInjection,
} from "../src/context/inject.js";
import type { InjectedContext } from "../src/context/inject.js";
import { formatHandoffSource } from "../src/tools/handoffs.js";
import {
  classifyContinuityState,
  describeContinuityState,
} from "../src/tools/project-memory-index.js";
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
      currentDeviceId: config.device_id,
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
        estimatedReadTokens: estimateTokens(formatContextForInjection(context)),
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
  estimatedReadTokens: number;
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
  const handoffShownItems = new Set<string>();
  if (brief.length > 0) {
    lines.push("");
    lines.push(`  ${c.bold}Handoff${c.reset}`);
    for (const line of brief) {
      lines.push(`  ${line}`);
      rememberShownItem(handoffShownItems, line);
    }
  }

  const economics = formatContextEconomics(data);
  if (economics.length > 0) {
    lines.push("");
    for (const line of economics) {
      lines.push(`  ${line}`);
    }
  }

  const legend = formatLegend();
  if (legend.length > 0) {
    lines.push("");
    for (const line of legend) {
      lines.push(`  ${line}`);
    }
  }

  const contextIndex = formatContextIndex(data.context, handoffShownItems);
  if (contextIndex.lines.length > 0) {
    lines.push("");
    for (const line of contextIndex.lines) {
      lines.push(`  ${line}`);
    }
  }

  const inspectHints = formatInspectHints(data.context, contextIndex.observationIds);
  if (inspectHints.length > 0) {
    lines.push("");
    for (const line of inspectHints) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("");

  return lines.join("\n");
}

function formatVisibleStartupBrief(context: InjectedContext): string[] {
  const lines: string[] = [];
  const continuityState = getStartupContinuityState(context);
  const latest = pickPrimarySummary(context);
  const observationFallbacks = buildObservationFallbacks(context);
  const promptFallback = buildPromptFallback(context);
  const promptLines = buildPromptLines(context);
  const recentChatLines = buildRecentChatLines(context);
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
  const currentThread = buildCurrentThreadLine(context, latest);
  const projectSignals = buildProjectSignalLine(context);
  const shownItems = new Set<string>();
  const latestHandoffLines = buildLatestHandoffLines(context);
  const freshContinuity = hasFreshContinuitySignal(context);

  if (latestHandoffLines.length > 0) {
    lines.push(`${c.cyan}Latest handoff:${c.reset}`);
    for (const item of latestHandoffLines) {
      lines.push(`  - ${truncateInline(item, 160)}`);
      rememberShownItem(shownItems, item);
    }
  }

  lines.push(
    `${c.cyan}Continuity:${c.reset} ${continuityState} — ${truncateInline(describeContinuityState(continuityState), 160)}`
  );

  if (promptLines.length > 0) {
    lines.push(`${c.cyan}Asked recently:${c.reset}`);
    for (const item of promptLines) {
      lines.push(`  - ${truncateInline(item, 160)}`);
      rememberShownItem(shownItems, item);
    }
  }

  if (promptLines.length === 0 && recentChatLines.length > 0) {
    lines.push(`${c.cyan}Chat trail:${c.reset}`);
    for (const item of recentChatLines) {
      lines.push(`  - ${truncateInline(item, 160)}`);
      rememberShownItem(shownItems, item);
    }
  }

  if (latest) {
    const sanitizedNextSteps = sanitizeNextSteps(latest.next_steps, {
      request: currentRequest,
      investigated: chooseSection(latest.investigated, observationFallbacks.investigated, "Investigated"),
      learned: latest.learned,
      completed: chooseSection(latest.completed, observationFallbacks.completed, "Completed"),
      recentOutcomes: recentOutcomeLines,
    });
    const sections: Array<[string, string | null, number]> = [
      ["Request", currentRequest, 1],
      ["Investigated", chooseSection(latest.investigated, observationFallbacks.investigated, "Investigated"), 2],
      ["Learned", latest.learned, 2],
      ["Completed", chooseSection(latest.completed, observationFallbacks.completed, "Completed"), 2],
      ["Next Steps", sanitizedNextSteps, 2],
    ];

    for (const [label, value, maxItems] of sections) {
      const formatted = toSplashLines(value, maxItems ?? 2);
      if (formatted.length > 0) {
        lines.push(`${c.cyan}${label}:${c.reset}`);
        for (const item of formatted) {
          lines.push(`  ${item}`);
          rememberShownItem(shownItems, item);
        }
      }
    }
  } else if (currentRequest && !duplicatesPromptLine(currentRequest, latestPromptLine)) {
    lines.push(`${c.cyan}What you're on:${c.reset}`);
    lines.push(`  - ${truncateInline(currentRequest, 160)}`);
    rememberShownItem(shownItems, currentRequest);
    if (toolFallbacks.length > 0) {
      const additiveTools = filterAdditiveToolFallbacks(toolFallbacks, shownItems);
      if (additiveTools.length > 0) {
        lines.push(`${c.cyan}Tool trail:${c.reset}`);
        for (const item of additiveTools) {
          lines.push(`  - ${truncateInline(item, 160)}`);
          rememberShownItem(shownItems, item);
        }
      }
    }
  }

  if (currentThread && !shownItems.has(normalizeStartupItem(currentThread))) {
    lines.push(`${c.cyan}Current thread:${c.reset}`);
    lines.push(`  - ${truncateInline(currentThread, 160)}`);
    rememberShownItem(shownItems, currentThread);
  }

  if (
    latest &&
    currentRequest &&
    !hasRequestSection(lines) &&
    !duplicatesPromptLine(currentRequest, latestPromptLine)
  ) {
    lines.push(`${c.cyan}What you're on:${c.reset}`);
    lines.push(`  - ${truncateInline(currentRequest, 160)}`);
    rememberShownItem(shownItems, currentRequest);
  }

  if (recentOutcomeLines.length > 0) {
    lines.push(`${c.cyan}What's moved:${c.reset}`);
    for (const item of recentOutcomeLines) {
      lines.push(`  - ${truncateInline(item, 160)}`);
      rememberShownItem(shownItems, item);
    }
  }

  if (toolFallbacks.length > 0 && latest) {
    const additiveTools = filterAdditiveToolFallbacks(toolFallbacks, shownItems);
    if (additiveTools.length > 0) {
      lines.push(`${c.cyan}Tool trail:${c.reset}`);
      for (const item of additiveTools) {
        lines.push(`  - ${truncateInline(item, 160)}`);
        rememberShownItem(shownItems, item);
      }
    }
  }

  if (sessionFallbacks.length > 0) {
    lines.push(`${c.cyan}Recent threads:${c.reset}`);
    for (const item of sessionFallbacks) {
      lines.push(`  - ${truncateInline(item, 160)}`);
    }
  }

  if (projectSignals) {
    lines.push(`${c.cyan}Signal mix:${c.reset}`);
    lines.push(`  - ${truncateInline(projectSignals, 160)}`);
  }

  if (
    !freshContinuity &&
    lines.length > 0 &&
    (promptLines.length > 0 || recentChatLines.length > 0)
  ) {
    lines.push(`${c.dim}Fresh repo-local handoff is still thin; recent prompts/chat are more trustworthy than older memory here.${c.reset}`);
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

function buildLatestHandoffLines(context: InjectedContext): string[] {
  const latest = context.recentHandoffs?.[0];
  if (!latest) return [];

  const lines: string[] = [];
  const title = latest.title
    .replace(/^Handoff(?: Draft)?:\s*/i, "")
    .replace(/\s+·\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}Z$/, "")
    .trim();
  if (title) lines.push(`${title} (${formatHandoffSource(latest)})`);

  const narrative = latest.narrative
    ?.split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => /^(Current thread:|Completed:|Next Steps:)/i.test(part));
  if (narrative) {
    lines.push(narrative.replace(/^(Current thread:|Completed:|Next Steps:)\s*/i, ""));
  }

  return Array.from(new Set(lines.filter(Boolean))).slice(0, 2);
}

function formatContextEconomics(data: SplashData): string[] {
  const totalMemories = Math.max(0, data.loaded + data.available);
  const parts: string[] = [];
  if (totalMemories > 0) {
    parts.push(`${totalMemories.toLocaleString()} total memories`);
  }
  if (data.estimatedReadTokens > 0) {
    parts.push(`read now ~${data.estimatedReadTokens.toLocaleString()}t`);
  }
  if (data.context.observations.length > 0) {
    parts.push(`${data.context.observations.length} observations loaded`);
  }
  if (parts.length === 0) return [];
  return [`${c.dim}Context economics:${c.reset} ${parts.join(" · ")}`];
}

function formatLegend(): string[] {
  return [
    `${c.dim}Legend:${c.reset} #id | ■ bugfix | ▲ feature | ≈ refactor | ● change | □ discovery | ◇ decision`,
  ];
}

function formatContextIndex(
  context: InjectedContext,
  shownItems?: Set<string>
): { lines: string[]; observationIds: number[] } {
  const selected = pickContextIndexObservations(context, shownItems);
  if (!hasFreshContinuitySignal(context)) {
    return { lines: [], observationIds: [] };
  }
  const rows = selected
    .map((obs) => {
      const icon = observationIcon(obs.type);
      const fileHint = extractPrimaryFileHint(obs);
      return `${icon} #${obs.id} ${truncateInline(obs.title, 110)}${fileHint ? ` ${c.dim}(${fileHint})${c.reset}` : ""}`;
    });

  if (rows.length === 0) return { lines: [], observationIds: [] };
  return {
    lines: [
      `${c.dim}Handoff index:${c.reset} use IDs when you want the deeper thread`,
      ...rows,
    ],
    observationIds: selected.map((obs) => obs.id),
  };
}

function formatInspectHints(context: InjectedContext, visibleObservationIds: number[] = []): string[] {
  const hints: string[] = [];
  const continuityState = getStartupContinuityState(context);

  if ((context.recentSessions?.length ?? 0) > 0) {
    hints.push("recent_sessions");
    hints.push("session_story");
    hints.push("create_handoff");
  }
  if (
    (context.recentPrompts?.length ?? 0) > 0 ||
    (context.recentToolEvents?.length ?? 0) > 0 ||
    (context.recentChatMessages?.length ?? 0) > 0
  ) {
    hints.push("activity_feed");
  }
  if (
    (context.recentPrompts?.length ?? 0) > 0 ||
    (context.recentChatMessages?.length ?? 0) > 0 ||
    context.observations.length > 0
  ) {
    hints.push("search_recall");
  }
  if (context.observations.length > 0) {
    hints.push("memory_console");
  }
  if ((context.recentHandoffs?.length ?? 0) > 0) {
    hints.push("load_handoff");
    hints.push("recent_handoffs");
  }
  if ((context.recentChatMessages?.length ?? 0) > 0) {
    hints.push("recent_chat");
  }
  if (hasNonTranscriptRecentChat(context)) {
    hints.push("refresh_chat_recall");
    hints.push("repair_recall");
  }
  if (continuityState !== "fresh") {
    hints.push("recent_chat");
    hints.push("recent_handoffs");
  }

  const unique = Array.from(new Set(hints)).slice(0, 4);
  if (unique.length === 0) return [];
  const ids = visibleObservationIds.slice(0, 5);
  const fetchHint = ids.length > 0 ? `get_observations([${ids.join(", ")}])` : null;
  return [
    `${c.dim}Next look:${c.reset} ${unique.join(" · ")}`,
    ...(fetchHint ? [`${c.dim}Pull detail:${c.reset} ${fetchHint}`] : []),
  ];
}

function rememberShownItem(shown: Set<string>, value: string | null | undefined): void {
  if (!value) return;
  for (const item of value.split("\n")) {
    const normalized = normalizeStartupItem(item);
    if (normalized) shown.add(normalized);
  }
}

function extractNormalizedSplashItems(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => normalizeStartupItem(line))
    .filter(Boolean);
}

function sanitizeNextSteps(
  nextSteps: string | null | undefined,
  context: {
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    recentOutcomes: string[];
  }
): string | null {
  if (!nextSteps) return null;
  const covered = new Set<string>([
    normalizeStartupItem(context.request ?? ""),
    ...extractNormalizedSplashItems(context.investigated),
    ...extractNormalizedSplashItems(context.learned),
    ...extractNormalizedSplashItems(context.completed),
    ...context.recentOutcomes.map((item) => normalizeStartupItem(item)),
  ].filter(Boolean));

  const kept = nextSteps
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, ""))
    .filter((line) => {
      const normalized = normalizeStartupItem(line.replace(/^(investigate|follow through):\s*/i, ""));
      return normalized && !covered.has(normalized);
    });

  return kept.length > 0 ? kept.map((line) => `- ${line}`).join("\n") : null;
}

function filterAdditiveToolFallbacks(toolFallbacks: string[], shownItems: Set<string>): string[] {
  return toolFallbacks.filter((item) => {
    const normalized = normalizeStartupItem(item);
    return normalized && !shownItems.has(normalized);
  });
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

function buildRecentChatLines(context: InjectedContext): string[] {
  return (context.recentChatMessages ?? [])
    .slice(0, 2)
    .map((message) => {
      const content = message.content.replace(/\s+/g, " ").trim();
      if (!content) return null;
      return `[${message.role}] ${content}`;
    })
    .filter((item): item is string => Boolean(item));
}

function duplicatesPromptLine(request: string, promptLine: string | null): boolean {
  if (!request || !promptLine) return false;
  const promptBody = promptLine.replace(/^#?\d+:\s*/, "").trim();
  return normalizeStartupItem(request) === normalizeStartupItem(promptBody);
}

function buildToolFallbacks(context: InjectedContext): string[] {
  const fromEvents = (context.recentToolEvents ?? [])
    .slice(0, 3)
    .map((tool) => {
      const detail = tool.file_path ?? tool.command ?? tool.tool_response_preview ?? "";
      return `${tool.tool_name}${detail ? `: ${detail}` : ""}`.trim();
    })
    .filter((item) => item.length > 0);

  if (fromEvents.length > 0) return fromEvents;

  return (context.recentSessions ?? [])
    .flatMap((session) => parseSessionJsonList(session.recent_tool_names))
    .slice(0, 3)
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
    for (const session of context.recentSessions ?? []) {
      for (const item of parseSessionJsonList(session.recent_outcomes)) {
        const normalized = normalizeStartupItem(item);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        picked.push(item);
        if (picked.length >= 2) return picked;
      }
    }
  }

  if (picked.length < 2) {
    for (const obs of getFreshStartupObservations(context)) {
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

function buildCurrentThreadLine(
  context: InjectedContext,
  summary: NonNullable<InjectedContext["summaries"]>[number] | null
): string | null {
  const explicit = summary?.current_thread ?? null;
  if (explicit && !looksLikeFileOperationTitle(explicit)) return explicit;

  for (const session of context.recentSessions ?? []) {
    if (session.current_thread && !looksLikeFileOperationTitle(session.current_thread)) {
      return session.current_thread;
    }
  }

  const request = buildPromptFallback(context);
  const outcome = buildRecentOutcomeLines(context, summary)[0] ?? null;
  const tool = buildToolFallbacks(context)[0] ?? null;
  const hasContinuity = hasFreshContinuitySignal(context);

  if (outcome && tool) return `${outcome} · ${tool}`;
  if (!hasContinuity && !outcome) return request;
  return outcome ?? request ?? null;
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

function parseSessionJsonList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function buildProjectSignalLine(context: InjectedContext): string | null {
  if (!context.projectTypeCounts) return null;
  const top = Object.entries(context.projectTypeCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([type, count]) => `${signalGlyph(type)} ${type} ${count}`)
    .join("; ");
  return top || null;
}

function signalGlyph(type: string): string {
  switch (type) {
    case "bugfix":
      return "■";
    case "feature":
      return "▲";
    case "refactor":
      return "≈";
    case "change":
      return "●";
    case "discovery":
      return "□";
    case "decision":
      return "◇";
    default:
      return "·";
  }
}

function observationIcon(type: string): string {
  switch (type) {
    case "bugfix":
      return "■";
    case "feature":
      return "▲";
    case "refactor":
      return "≈";
    case "change":
      return "●";
    case "discovery":
      return "□";
    case "decision":
      return "◇";
    default:
      return "•";
  }
}

function extractPrimaryFileHint(obs: InjectedContext["observations"][number]): string | null {
  const firstRead = parseJsonArraySafe(obs.files_read)[0];
  const firstModified = parseJsonArraySafe(obs.files_modified)[0];
  return firstModified ?? firstRead ?? null;
}

function pickContextIndexObservations(
  context: InjectedContext,
  shownItems?: Set<string>
): InjectedContext["observations"] {
  const now = Date.now();
  const hidden = shownItems ?? new Set<string>();
  const picked: InjectedContext["observations"] = [];

  const scoreObservation = (obs: InjectedContext["observations"][number]): number => {
    let score = 0;
    const ageMs = Math.max(0, now - new Date(obs.created_at).getTime());
    const ageDays = ageMs / 86400000;

    score += Math.max(0, 30 - ageDays) * 0.2;
    score += obs.quality * 2;

    switch (obs.type) {
      case "bugfix":
        score += 2.4;
        break;
      case "feature":
        score += 2.2;
        break;
      case "change":
        score += 1.6;
        break;
      case "discovery":
        score += 1.4;
        break;
      case "refactor":
        score += 1.2;
        break;
      case "decision":
        if (ageDays <= 7) score += 1.1;
        else if (ageDays <= 21) score += 0.2;
        else if (ageDays <= 45) score -= 1.2;
        else score -= 2.8;
        break;
      default:
        score += 0.4;
        break;
    }

    if (extractPrimaryFileHint(obs)) score += 0.4;
    if (context.recentOutcomes?.some((item) => titlesRoughlyMatch(item, obs.title))) score += 2.5;
    return score;
  };

  for (const obs of getFreshStartupObservations(context)
    .filter((obs) => obs.type !== "digest")
    .filter((obs) => {
      const normalized = normalizeStartupItem(obs.title);
      return normalized && !hidden.has(normalized);
    })
    .sort((a, b) => {
      const scoreDiff = scoreObservation(b) - scoreObservation(a);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })
  ) {
    if (picked.some((existing) => titlesRoughlyMatch(existing.title, obs.title))) continue;
    picked.push(obs);
    if (picked.length >= 6) break;
  }

  return picked;
}

function parseJsonArraySafe(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
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
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function titlesRoughlyMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeStartupItem(left ?? "");
  const b = normalizeStartupItem(right ?? "");
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const aTokens = a.split(" ").filter((token) => token.length >= 4);
  const bTokens = b.split(" ").filter((token) => token.length >= 4);
  if (!aTokens.length || !bTokens.length) return false;

  const shared = aTokens.filter((token) => bTokens.includes(token));
  const minSize = Math.min(aTokens.length, bTokens.length);
  return shared.length >= Math.max(3, Math.ceil(minSize * 0.6));
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
  const trimmed = value.trim();
  if (/^(modified|updated|edited|touched|changed|extended|refactored|redesigned)\s+[A-Za-z0-9_.\-\/]+(?:\s*\([^)]*\))?$/i.test(trimmed)) {
    return true;
  }
  return looksLikeGenericSummaryWrapper(trimmed);
}

function looksLikeGenericSummaryWrapper(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized.startsWith("all clean. here's a summary of what was fixed") ||
    normalized.startsWith("all clean, here's a summary of what was fixed") ||
    normalized.startsWith("now i have enough to give a clear, accurate assessment") ||
    normalized.startsWith("here's the real picture") ||
    normalized === "event log → existing events feed" ||
    normalized.startsWith("event log -> existing events feed") ||
    normalized.startsWith("tl;dr:")
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
  const request = getFreshStartupObservations(context)
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
  for (const obs of getFreshStartupObservations(context)) {
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

function getFreshStartupObservations(
  context: InjectedContext
): InjectedContext["observations"] {
  if (hasFreshContinuitySignal(context)) return context.observations;
  return context.observations.filter((obs) => observationAgeDays(obs) <= 3);
}

function hasFreshContinuitySignal(context: InjectedContext): boolean {
  return getStartupContinuityState(context) === "fresh";
}

function getStartupContinuityState(
  context: InjectedContext
): "fresh" | "thin" | "cold" {
  return classifyContinuityState(
    context.recentPrompts?.length ?? 0,
    context.recentToolEvents?.length ?? 0,
    context.recentHandoffs?.length ?? 0,
    context.recentChatMessages?.length ?? 0,
    context.recentSessions ?? [],
    context.recentOutcomes?.length ?? 0
  );
}

function hasNonTranscriptRecentChat(context: InjectedContext): boolean {
  const recentChat = context.recentChatMessages ?? [];
  return recentChat.length > 0 && !recentChat.some((message) => message.source_kind === "transcript");
}

function observationAgeDays(obs: InjectedContext["observations"][number]): number {
  const createdAt = new Date(obs.created_at).getTime();
  if (!Number.isFinite(createdAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - createdAt) / 86400000);
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
  formatSplashScreen,
  formatVisibleStartupBrief,
  getStartupContinuityState,
};

runHook("session-start", main);
