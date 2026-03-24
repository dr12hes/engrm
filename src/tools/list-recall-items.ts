import { detectProject } from "../storage/projects.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { getRecentActivity } from "./recent.js";
import { getRecentChat, getChatCaptureOrigin } from "./recent-chat.js";
import { getRecentHandoffs, isDraftHandoff } from "./handoffs.js";
import { getRecentSessions } from "./recent-sessions.js";

export interface ListRecallItemsInput {
  cwd?: string;
  project_scoped?: boolean;
  user_id?: string;
  current_device_id?: string;
  limit?: number;
}

export interface RecallIndexItem {
  key: string;
  kind: "handoff" | "thread" | "chat" | "memory";
  title: string;
  detail: string;
  created_at_epoch: number;
  freshness: "live" | "recent" | "stale";
  session_id: string | null;
  source_device_id: string | null;
  source_agent: string | null;
}

export interface ListRecallItemsResult {
  project?: string;
  continuity_mode: "direct" | "indexed";
  items: RecallIndexItem[];
}

export function listRecallItems(
  db: MemDatabase,
  input: ListRecallItemsInput
): ListRecallItemsResult {
  const limit = Math.max(3, Math.min(input.limit ?? 12, 30));
  const projectScoped = input.project_scoped !== false;

  let projectName: string | undefined;
  if (projectScoped) {
    const cwd = input.cwd ?? process.cwd();
    const detected = detectProject(cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);
    projectName = project?.name;
  }

  const handoffs = getRecentHandoffs(db, {
    cwd: input.cwd,
    project_scoped: projectScoped,
    user_id: input.user_id,
    current_device_id: input.current_device_id,
    limit,
  }).handoffs;
  const sessions = getRecentSessions(db, {
    cwd: input.cwd,
    project_scoped: projectScoped,
    user_id: input.user_id,
    limit: Math.min(limit, 8),
  }).sessions;
  const chat = getRecentChat(db, {
    cwd: input.cwd,
    project_scoped: projectScoped,
    user_id: input.user_id,
    limit: Math.min(limit * 2, 20),
  }).messages;
  const observations = getRecentActivity(db, {
    cwd: input.cwd,
    project_scoped: projectScoped,
    user_id: input.user_id,
    limit: Math.min(limit * 2, 24),
  }).observations;
  const sessionAgentById = new Map(
    sessions
      .filter((session) => Boolean(session.session_id))
      .map((session) => [session.session_id, session.agent ?? null] as const)
  );

  const items: RecallIndexItem[] = [
    ...handoffs.map((handoff) => ({
      key: `handoff:${handoff.id}`,
      kind: "handoff" as const,
      title: stripHandoffPrefix(handoff.title),
      detail: summarizeHandoffDetail(handoff.narrative),
      created_at_epoch: handoff.created_at_epoch,
      freshness: classifyFreshness(handoff.created_at_epoch),
      session_id: handoff.session_id,
      source_device_id: handoff.device_id ?? null,
      source_agent: handoff.session_id ? sessionAgentById.get(handoff.session_id) ?? null : null,
    })),
    ...sessions
      .filter((session) => Boolean(session.request || session.completed || session.current_thread))
      .map((session) => ({
        key: `session:${session.session_id}`,
        kind: "thread" as const,
        title: session.current_thread ?? session.request ?? session.completed ?? session.session_id,
        detail: buildSessionDetail(session),
        created_at_epoch: session.completed_at_epoch ?? session.started_at_epoch ?? 0,
        freshness: classifyFreshness(session.completed_at_epoch ?? session.started_at_epoch ?? null),
        session_id: session.session_id,
        source_device_id: session.device_id ?? null,
        source_agent: session.agent ?? null,
      })),
    ...dedupeChatIndex(chat).map((message) => {
      const origin = getChatCaptureOrigin(message);
      return {
        key: `chat:${message.id}`,
        kind: "chat" as const,
        title: `${message.role} [${origin}]`,
        detail: truncateInline(message.content.replace(/\s+/g, " ").trim(), 180),
        created_at_epoch: message.created_at_epoch,
        freshness: classifyFreshness(message.created_at_epoch),
        session_id: message.session_id,
        source_device_id: message.device_id ?? null,
        source_agent: message.agent ?? null,
      };
    }),
    ...observations
      .filter((obs) => obs.type !== "message")
      .filter((obs) => !looksLikeFileOperationTitle(obs.title))
      .map((obs) => ({
        key: `obs:${obs.id}`,
        kind: "memory" as const,
        title: `[${obs.type}] ${obs.title}`,
        detail: truncateInline(firstNonEmpty(obs.narrative, previewFacts(obs.facts), obs.project_name ?? "") ?? obs.type, 180),
        created_at_epoch: obs.created_at_epoch,
        freshness: classifyFreshness(obs.created_at_epoch),
        session_id: obs.session_id ?? null,
        source_device_id: obs.device_id ?? null,
        source_agent: null,
      })),
  ];

  const deduped = dedupeRecallItems(items)
    .sort((a, b) => compareRecallItems(a, b, input.current_device_id))
    .slice(0, limit);

  return {
    project: projectName,
    continuity_mode: deduped.some((item) => item.kind === "handoff" || item.kind === "thread")
      ? "direct"
      : "indexed",
    items: deduped,
  };
}

function compareRecallItems(a: RecallIndexItem, b: RecallIndexItem, currentDeviceId?: string): number {
  const priority = (item: RecallIndexItem): number => {
    const freshness =
      item.freshness === "live" ? 0 :
      item.freshness === "recent" ? 1 : 2;
    const kind =
      item.kind === "handoff" ? 0 :
      item.kind === "thread" ? 1 :
      item.kind === "chat" ? 2 : 3;
    const remoteBoost = currentDeviceId && item.source_device_id && item.source_device_id !== currentDeviceId ? -0.5 : 0;
    const draftPenalty = item.kind === "handoff" && /draft/i.test(item.title) ? 0.25 : 0;
    return freshness * 10 + kind + remoteBoost + draftPenalty;
  };

  const priorityDiff = priority(a) - priority(b);
  if (priorityDiff !== 0) return priorityDiff;
  return b.created_at_epoch - a.created_at_epoch;
}

function dedupeRecallItems(items: RecallIndexItem[]): RecallIndexItem[] {
  const best = new Map<string, RecallIndexItem>();
  for (const item of items) {
    const key = `${item.kind}::${normalize(item.title)}::${normalize(item.detail)}`;
    const existing = best.get(key);
    if (!existing || compareRecallItems(item, existing) < 0) {
      best.set(key, item);
    }
  }
  return Array.from(best.values());
}

function dedupeChatIndex(messages: ReturnType<typeof getRecentChat>["messages"]) {
  const byKey = new Map<string, (typeof messages)[number]>();
  for (const message of messages) {
    const key = `${message.session_id}::${message.role}::${normalize(message.content)}`;
    const existing = byKey.get(key);
    if (!existing || message.created_at_epoch > existing.created_at_epoch) {
      byKey.set(key, message);
    }
  }
  return Array.from(byKey.values());
}

function summarizeHandoffDetail(narrative: string | null): string {
  if (!narrative) return "";
  const line = narrative
    .split(/\n+/)
    .map((item) => item.trim())
    .find((item) => /^Current thread:|^Completed:|^Next Steps:/i.test(item));
  return line
    ? truncateInline(line.replace(/^(Current thread:|Completed:|Next Steps:)\s*/i, ""), 180)
    : truncateInline(narrative.replace(/\s+/g, " ").trim(), 180);
}

function buildSessionDetail(session: ReturnType<typeof getRecentSessions>["sessions"][number]): string {
  const pieces = [
    session.request,
    session.completed,
    session.current_thread,
  ]
    .filter((item): item is string => Boolean(item && item.trim()))
    .map((item) => item.replace(/\s+/g, " ").trim());
  return truncateInline(pieces[0] ?? `prompts ${session.prompt_count}, tools ${session.tool_event_count}`, 180);
}

function stripHandoffPrefix(value: string): string {
  return value
    .replace(/^Handoff(?: Draft)?:\s*/i, "")
    .replace(/\s+·\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}Z$/, "")
    .trim();
}

function classifyFreshness(createdAtEpoch: number | null): RecallIndexItem["freshness"] {
  if (!createdAtEpoch) return "stale";
  const ageMs = Date.now() - createdAtEpoch * 1000;
  if (ageMs <= 15 * 60 * 1000) return "live";
  if (ageMs <= 3 * 24 * 60 * 60 * 1000) return "recent";
  return "stale";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function truncateInline(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trimEnd()}…`;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function previewFacts(facts: string | null): string | null {
  if (!facts) return null;
  try {
    const parsed = JSON.parse(facts);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 2).join(" | ");
  } catch {
    return facts;
  }
}

function looksLikeFileOperationTitle(value: string): boolean {
  return /^(modified|updated|edited|touched|changed|extended|refactored|redesigned)\s+[A-Za-z0-9_.\-\/]+(?:\s*\([^)]*\))?$/i.test(
    value.trim()
  );
}
