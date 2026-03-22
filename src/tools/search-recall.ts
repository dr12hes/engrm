import type { MemDatabase } from "../storage/sqlite.js";
import { searchObservations, type SearchInput as ObservationSearchInput } from "./search.js";
import { searchChat } from "./search-chat.js";

export interface SearchRecallInput extends ObservationSearchInput {}

export interface SearchRecallResult {
  query: string;
  project?: string;
  results: SearchRecallEntry[];
  totals: {
    memory: number;
    chat: number;
  };
}

export interface SearchRecallEntry {
  kind: "memory" | "chat";
  rank: number;
  created_at?: string;
  created_at_epoch?: number;
  project_name?: string;
  session_id?: string | null;
  id?: number;
  observation_id?: number;
  type?: string;
  title: string;
  detail: string;
  role?: "user" | "assistant";
  source_kind?: "hook" | "transcript";
}

export async function searchRecall(
  db: MemDatabase,
  input: SearchRecallInput
): Promise<SearchRecallResult> {
  const query = input.query.trim();
  if (!query) {
    return {
      query,
      results: [],
      totals: { memory: 0, chat: 0 },
    };
  }

  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const [memory, chat] = await Promise.all([
    searchObservations(db, input),
    Promise.resolve(
      searchChat(db, {
        query,
        limit: limit * 2,
        project_scoped: input.project_scoped,
        cwd: input.cwd,
        user_id: input.user_id,
      })
    ),
  ]);

  const merged = mergeRecallResults(memory.observations, chat.messages, limit);

  return {
    query,
    project: memory.project ?? chat.project,
    results: merged,
    totals: {
      memory: memory.total,
      chat: chat.messages.length,
    },
  };
}

function mergeRecallResults(
  memory: Awaited<ReturnType<typeof searchObservations>>["observations"],
  chat: Awaited<ReturnType<typeof searchChat>>["messages"],
  limit: number
): SearchRecallEntry[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const scored: SearchRecallEntry[] = [];

  for (let index = 0; index < memory.length; index++) {
    const item = memory[index]!;
    const base = 1 / (60 + index + 1);
    const score = base + Math.max(0, item.rank) * 0.08;
    scored.push({
      kind: "memory",
      rank: score,
      created_at: item.created_at,
      created_at_epoch: Math.floor(new Date(item.created_at).getTime() / 1000) || undefined,
      project_name: item.project_name,
      observation_id: item.id,
      id: item.id,
      session_id: null,
      type: item.type,
      title: item.title,
      detail: firstNonEmpty(
        item.narrative,
        parseFactsPreview(item.facts),
        item.files_modified ? `Files: ${item.files_modified}` : null,
        item.type
      ) ?? item.type,
    });
  }

  for (let index = 0; index < chat.length; index++) {
    const item = chat[index]!;
    const base = 1 / (60 + index + 1);
    const ageHours = Math.max(0, (nowEpoch - item.created_at_epoch) / 3600);
    const immediacyBoost = ageHours < 1 ? 1.0 : 0;
    const recencyBoost = ageHours < 24 ? 0.12 : ageHours < 72 ? 0.05 : 0.02;
    const sourceBoost = item.source_kind === "transcript" ? 0.06 : 0.03;
    scored.push({
      kind: "chat",
      rank: base + immediacyBoost + recencyBoost + sourceBoost,
      created_at_epoch: item.created_at_epoch,
      session_id: item.session_id,
      id: item.id,
      role: item.role,
      source_kind: item.source_kind,
      title: `${item.role} [${item.source_kind}]`,
      detail: item.content.replace(/\s+/g, " ").trim(),
    });
  }

  return scored
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0);
    })
    .slice(0, limit);
}

function parseFactsPreview(facts: string | null): string | null {
  if (!facts) return null;
  try {
    const parsed = JSON.parse(facts);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const lines = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return lines.length > 0 ? lines.slice(0, 2).join(" | ") : null;
  } catch {
    return facts;
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}
