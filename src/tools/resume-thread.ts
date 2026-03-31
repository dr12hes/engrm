import type { Config } from "../config.js";
import { detectProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { getRecentHandoffs, loadHandoff, type HandoffRow } from "./handoffs.js";
import { getRecentChat, type ChatCoverageState } from "./recent-chat.js";
import { searchRecall, type SearchRecallEntry } from "./search-recall.js";
import { getSessionContext } from "./session-context.js";
import { getRecentSessions } from "./recent-sessions.js";
import { repairRecall, type RepairRecallResult } from "./repair-recall.js";
import { listRecallItems } from "./list-recall-items.js";
import { pickPreferredAgent } from "./project-memory-index.js";

export interface ResumeThreadInput {
  cwd?: string;
  user_id?: string;
  current_device_id?: string;
  limit?: number;
  repair_if_needed?: boolean;
  agent?: string;
}

export interface ResumeThreadResult {
  project_name: string | null;
  target_agent: string | null;
  continuity_state: "fresh" | "thin" | "cold";
  continuity_summary: string;
  resume_freshness: "live" | "recent" | "stale";
  resume_source_session_id: string | null;
  resume_source_device_id: string | null;
  resume_confidence: "strong" | "usable" | "thin";
  resume_basis: string[];
  best_recall_key: string | null;
  best_recall_title: string | null;
  best_recall_kind: "handoff" | "thread" | "chat" | "memory" | null;
  repair_attempted: boolean;
  repair_result: {
    imported_chat_messages: number;
    sessions_with_imports: number;
  } | null;
  latest_request: string | null;
  current_thread: string | null;
  handoff: {
    id: number;
    title: string;
    source: string | null;
  } | null;
  tool_trail: string[];
  hot_files: Array<{ path: string; count: number }>;
  next_actions: string[];
  recent_outcomes: string[];
  chat_coverage_state: ChatCoverageState;
  recent_chat: Array<{
    role: "user" | "assistant";
    source: "transcript" | "history" | "hook";
    content: string;
    created_at_epoch: number;
  }>;
  recall_hits: SearchRecallEntry[];
  suggested_tools: string[];
}

export async function resumeThread(
  db: MemDatabase,
  config: Config,
  input: ResumeThreadInput = {}
): Promise<ResumeThreadResult> {
  const cwd = input.cwd ?? process.cwd();
  const limit = Math.max(2, Math.min(input.limit ?? 5, 8));
  const repairIfNeeded = input.repair_if_needed !== false;
  const detected = detectProject(cwd);
  const project = db.getProjectByCanonicalId(detected.canonical_id);

  let snapshot = await buildResumeSnapshot(db, cwd, input.user_id, input.current_device_id, limit);
  const activeAgents = Array.from(new Set(snapshot.recentSessions.map((session) => session.agent).filter((agent): agent is string => Boolean(agent))));
  const effectiveAgent = input.agent ?? pickPreferredAgent(activeAgents, snapshot.recentSessions[0]?.agent ?? null) ?? undefined;
  if (effectiveAgent) {
    snapshot = filterResumeSnapshotByAgent(snapshot, effectiveAgent, input.current_device_id);
  }
  let repairResult: RepairRecallResult | null = null;
  const shouldRepair =
    repairIfNeeded &&
    snapshot.recentChat.coverage_state !== "transcript-backed" &&
    (snapshot.recentChat.messages.length > 0 || snapshot.recentSessions.length > 0 || snapshot.context?.continuity_state !== "cold");

  if (shouldRepair) {
    repairResult = await repairRecall(db, config, {
      cwd,
      user_id: input.user_id,
      limit: Math.max(limit, 4),
    });
    if (repairResult.imported_chat_messages > 0) {
      snapshot = await buildResumeSnapshot(db, cwd, input.user_id, input.current_device_id, limit);
      if (effectiveAgent) {
        snapshot = filterResumeSnapshotByAgent(snapshot, effectiveAgent, input.current_device_id);
      }
    }
  }

  const { context, handoff, recentChat, recentSessions, recall } = snapshot;
  const bestRecallItem = pickBestRecallItem(snapshot.recallIndex.items, effectiveAgent);

  const latestSession = recentSessions[0] ?? null;
  const latestSummary = latestSession ? db.getSessionSummary(latestSession.session_id) : null;
  const inferredRequest =
    latestSession?.request?.trim()
    || null;

  const currentThread =
    extractCurrentThread(handoff)
    || latestSession?.current_thread?.trim()
    || inferredRequest
    || context?.recent_outcomes[0]
    || recentChat.messages[recentChat.messages.length - 1]?.content.replace(/\s+/g, " ").trim().slice(0, 180)
    || null;
  const toolTrail = collectToolTrail(latestSession);
  const hotFiles = collectHotFiles(latestSession, context?.hot_files ?? []);
  const nextActions = collectNextActions(latestSummary?.next_steps);
  const sourceTimestamp = pickSourceTimestamp(latestSession, recentChat.messages);

  const resumeBasis = buildResumeBasis({
    handoff,
    continuityState: context?.continuity_state ?? "cold",
    chatCoverageState: recentChat.coverage_state,
    latestRequest: inferredRequest,
    currentThread,
    recallHits: recall.results,
    recentOutcomes: context?.recent_outcomes ?? [],
    toolTrail,
    hotFiles,
    nextActions,
  });
  const resumeConfidence = classifyResumeConfidence({
    handoff,
    continuityState: context?.continuity_state ?? "cold",
    chatCoverageState: recentChat.coverage_state,
    recallHits: recall.results,
    currentThread,
  });

  const suggestedTools = Array.from(new Set([
    ...(bestRecallItem ? ["load_recall_item"] : []),
    "search_recall",
    ...(recentChat.coverage_state !== "transcript-backed" && recentChat.messages.length > 0
      ? ["repair_recall", "refresh_chat_recall"]
      : []),
    ...(handoff ? ["load_handoff"] : []),
    ...(recentChat.messages.length > 0 ? ["recent_chat"] : []),
  ])).slice(0, 4);

  return {
    project_name: project?.name ?? context?.project_name ?? null,
    target_agent: effectiveAgent ?? null,
    continuity_state: context?.continuity_state ?? "cold",
    continuity_summary: context?.continuity_summary ?? "No fresh repo-local continuity yet; older memory should be treated cautiously.",
    resume_freshness: classifyResumeFreshness(sourceTimestamp),
    resume_source_session_id: latestSession?.session_id ?? null,
    resume_source_device_id: handoff?.device_id ?? latestSession?.device_id ?? null,
    resume_confidence: resumeConfidence,
    resume_basis: resumeBasis,
    best_recall_key: bestRecallItem?.key ?? null,
    best_recall_title: bestRecallItem?.title ?? null,
    best_recall_kind: bestRecallItem?.kind ?? null,
    repair_attempted: shouldRepair,
    repair_result: repairResult
      ? {
          imported_chat_messages: repairResult.imported_chat_messages,
          sessions_with_imports: repairResult.sessions_with_imports,
        }
      : null,
    latest_request: inferredRequest,
    current_thread: currentThread,
    handoff: handoff
      ? {
          id: handoff.id,
          title: handoff.title,
          source: extractHandoffSource(handoff),
        }
      : null,
    tool_trail: toolTrail,
    hot_files: hotFiles,
    next_actions: nextActions,
    recent_outcomes: context?.recent_outcomes ?? [],
    chat_coverage_state: recentChat.coverage_state,
    recent_chat: recentChat.messages
      .slice(-4)
      .map((message) => ({
        role: message.role,
        source: message.source_kind === "transcript"
          ? "transcript"
          : (typeof message.remote_source_id === "string" && message.remote_source_id.startsWith("history:"))
            ? "history"
            : "hook",
        content: message.content.replace(/\s+/g, " ").trim(),
        created_at_epoch: message.created_at_epoch,
      })),
    recall_hits: recall.results.slice(0, limit),
    suggested_tools: suggestedTools,
  };
}

async function buildResumeSnapshot(
  db: MemDatabase,
  cwd: string,
  userId: string | undefined,
  currentDeviceId: string | undefined,
  limit: number
): Promise<{
  context: ReturnType<typeof getSessionContext>;
  handoff: HandoffRow | null;
  recentHandoffs: ReturnType<typeof getRecentHandoffs>["handoffs"];
  recentChat: ReturnType<typeof getRecentChat>;
  recentSessions: ReturnType<typeof getRecentSessions>["sessions"];
  recall: Awaited<ReturnType<typeof searchRecall>>;
  recallIndex: ReturnType<typeof listRecallItems>;
}> {
  const context = getSessionContext(db, {
    cwd,
    user_id: userId,
    current_device_id: currentDeviceId,
  });
  const handoffResult = loadHandoff(db, {
    cwd,
    project_scoped: true,
    user_id: userId,
    current_device_id: currentDeviceId,
  });
  const recentHandoffs = getRecentHandoffs(db, {
    cwd,
    project_scoped: true,
    user_id: userId,
    current_device_id: currentDeviceId,
    limit: Math.max(limit, 4),
  }).handoffs;
  const recentChat = getRecentChat(db, {
    cwd,
    project_scoped: true,
    user_id: userId,
    limit: Math.max(limit, 4),
  });
  const recentSessions = getRecentSessions(db, {
    cwd,
    project_scoped: true,
    user_id: userId,
    limit: 3,
  }).sessions;
  const recall = await searchRecall(db, {
    query: "what were we just talking about",
    cwd,
    project_scoped: true,
    user_id: userId,
    limit,
  });
  const recallIndex = listRecallItems(db, {
    cwd,
    project_scoped: true,
    user_id: userId,
    current_device_id: currentDeviceId,
    limit,
  });

  return {
    context,
    handoff: handoffResult.handoff,
    recentHandoffs,
    recentChat,
    recentSessions,
    recall,
    recallIndex,
  };
}

function filterResumeSnapshotByAgent(
  snapshot: {
    context: ReturnType<typeof getSessionContext>;
    handoff: HandoffRow | null;
    recentHandoffs: ReturnType<typeof getRecentHandoffs>["handoffs"];
    recentChat: ReturnType<typeof getRecentChat>;
    recentSessions: ReturnType<typeof getRecentSessions>["sessions"];
    recall: Awaited<ReturnType<typeof searchRecall>>;
    recallIndex: ReturnType<typeof listRecallItems>;
  },
  agent: string,
  currentDeviceId?: string
) {
  const recentSessions = snapshot.recentSessions.filter((session) => session.agent === agent);
  const sessionIds = new Set(recentSessions.map((session) => session.session_id));
  const recentChatMessages = snapshot.recentChat.messages.filter((message) => message.agent === agent);
  const handoff = snapshot.recentHandoffs
    .filter((item) => item.session_id && sessionIds.has(item.session_id))
    .sort((a, b) => compareRecallCandidates(a.created_at_epoch, b.created_at_epoch, a.device_id ?? null, b.device_id ?? null, currentDeviceId))[0] ?? null;
  const recallIndex = {
    ...snapshot.recallIndex,
    items: snapshot.recallIndex.items.filter((item) => item.source_agent === agent),
  };
  const recall = {
    ...snapshot.recall,
    results: snapshot.recall.results.filter((entry) => entry.session_id ? sessionIds.has(entry.session_id) : false),
  };

  return {
    ...snapshot,
    handoff,
    recentHandoffs: snapshot.recentHandoffs.filter((item) => item.session_id && sessionIds.has(item.session_id)),
    recentSessions,
    recentChat: {
      ...snapshot.recentChat,
      messages: recentChatMessages,
      session_count: new Set(recentChatMessages.map((message) => message.session_id)).size,
    },
    recall,
    recallIndex,
  };
}

function pickBestRecallItem(
  items: ReturnType<typeof listRecallItems>["items"],
  preferredAgent?: string
) {
  if (preferredAgent) {
    const preferred = items.find((item) => item.source_agent === preferredAgent && item.kind !== "memory")
      ?? items.find((item) => item.source_agent === preferredAgent);
    if (preferred) return preferred;
  }
  return items.find((item) => item.kind !== "memory") ?? items[0] ?? null;
}

function compareRecallCandidates(
  epochA: number,
  epochB: number,
  deviceA: string | null,
  deviceB: string | null,
  currentDeviceId?: string
): number {
  const remoteBoostA = currentDeviceId && deviceA && deviceA !== currentDeviceId ? 1 : 0;
  const remoteBoostB = currentDeviceId && deviceB && deviceB !== currentDeviceId ? 1 : 0;
  if (remoteBoostA !== remoteBoostB) return remoteBoostB - remoteBoostA;
  return epochB - epochA;
}

function extractCurrentThread(handoff: HandoffRow | null): string | null {
  const narrative = handoff?.narrative ?? "";
  const match = narrative.match(/Current thread:\s*(.+)/i);
  return match?.[1]?.trim() ?? null;
}

function extractHandoffSource(handoff: HandoffRow): string | null {
  return handoff.device_id ?? null;
}

function pickSourceTimestamp(
  latestSession: ReturnType<typeof getRecentSessions>["sessions"][number] | null,
  messages: ReturnType<typeof getRecentChat>["messages"]
): number | null {
  const latestChatEpoch = messages.length > 0
    ? messages[messages.length - 1]?.created_at_epoch ?? null
    : null;
  return latestChatEpoch
    ?? latestSession?.completed_at_epoch
    ?? latestSession?.started_at_epoch
    ?? null;
}

function classifyResumeFreshness(sourceTimestamp: number | null): ResumeThreadResult["resume_freshness"] {
  if (!sourceTimestamp) return "stale";
  const ageMs = Date.now() - sourceTimestamp * 1000;
  if (ageMs <= 15 * 60 * 1000) return "live";
  if (ageMs <= 3 * 24 * 60 * 60 * 1000) return "recent";
  return "stale";
}

function classifyResumeConfidence(input: {
  handoff: HandoffRow | null;
  continuityState: "fresh" | "thin" | "cold";
  chatCoverageState: ChatCoverageState;
  recallHits: SearchRecallEntry[];
  currentThread: string | null;
}): ResumeThreadResult["resume_confidence"] {
  const hasStrongChat = input.chatCoverageState === "transcript-backed" || input.chatCoverageState === "history-backed";
  const hasRecall = input.recallHits.length > 0;
  if (input.handoff && input.currentThread && (input.continuityState === "fresh" || hasStrongChat || hasRecall)) {
    return "strong";
  }
  if (input.currentThread && (input.continuityState !== "cold" || hasStrongChat || hasRecall)) {
    return "usable";
  }
  return "thin";
}

function buildResumeBasis(input: {
  handoff: HandoffRow | null;
  continuityState: "fresh" | "thin" | "cold";
  chatCoverageState: ChatCoverageState;
  latestRequest: string | null;
  currentThread: string | null;
  recallHits: SearchRecallEntry[];
  recentOutcomes: string[];
  toolTrail: string[];
  hotFiles: Array<{ path: string; count: number }>;
  nextActions: string[];
}): string[] {
  const basis: string[] = [];
  if (input.handoff) basis.push("explicit handoff available");
  if (input.currentThread) basis.push("current thread recovered");
  if (input.latestRequest) basis.push("latest request recovered");
  if (input.recentOutcomes.length > 0) basis.push("recent outcomes available");
  if (input.nextActions.length > 0) basis.push("next actions available");
  if (input.toolTrail.length > 0) basis.push("recent tool trail available");
  if (input.hotFiles.length > 0) basis.push("hot files available");
  if (input.recallHits.some((item) => item.kind === "chat")) basis.push("live chat recall available");
  if (input.chatCoverageState === "transcript-backed") basis.push("transcript-backed chat continuity");
  if (input.chatCoverageState === "history-backed") basis.push("history-backed chat continuity");
  if (input.continuityState === "fresh") basis.push("fresh repo-local continuity");
  if (basis.length === 0) basis.push("thin fallback only");
  return basis.slice(0, 6);
}

function collectToolTrail(
  session: { recent_tool_names?: string | null } | null
): string[] {
  const parsed = parseJsonArray(session?.recent_tool_names);
  return parsed.slice(0, 5);
}

function collectHotFiles(
  session: { hot_files?: string | null } | null,
  fallback: Array<{ path: string; count: number }>
): Array<{ path: string; count: number }> {
  const parsed = parseJsonArray(session?.hot_files).map((path) => ({ path, count: 1 }));
  if (parsed.length > 0) return parsed.slice(0, 5);
  return fallback.slice(0, 5);
}

function collectNextActions(value: string | null | undefined): string[] {
  if (!value) return [];
  const normalized = value
    .split(/\n+/)
    .map((line) => line.replace(/^[\s*-]+/, "").trim())
    .filter((line) => line.length > 0);
  if (normalized.length > 1) return normalized.slice(0, 5);
  return value
    .split(/[.;](?:\s+|$)/)
    .map((item) => item.replace(/^[\s*-]+/, "").trim())
    .filter((item) => item.length > 0)
    .slice(0, 5);
}

function parseJsonArray(value: string | null | undefined): string[] {
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
