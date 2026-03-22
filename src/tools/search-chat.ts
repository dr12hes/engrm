import { detectProject } from "../storage/projects.js";
import { embedText } from "../embeddings/embedder.js";
import { composeChatEmbeddingText } from "../embeddings/embedder.js";
import type { ChatMessageRow, MemDatabase, VecChatMatchRow } from "../storage/sqlite.js";

export interface SearchChatInput {
  query: string;
  limit?: number;
  project_scoped?: boolean;
  cwd?: string;
  user_id?: string;
}

export interface SearchChatResult {
  messages: ChatMessageRow[];
  project?: string;
  session_count: number;
  source_summary: {
    transcript: number;
    hook: number;
  };
  transcript_backed: boolean;
  semantic_backed: boolean;
}

export async function searchChat(
  db: MemDatabase,
  input: SearchChatInput
): Promise<SearchChatResult> {
  const normalizedQuery = normalizeQuery(input.query);
  if (!normalizedQuery) {
    return {
      messages: [],
      session_count: 0,
      source_summary: { transcript: 0, hook: 0 },
      transcript_backed: false,
      semantic_backed: false,
    };
  }

  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const projectScoped = input.project_scoped !== false;
  let projectId: number | null = null;
  let projectName: string | undefined;

  if (projectScoped) {
    const cwd = input.cwd ?? process.cwd();
    const detected = detectProject(cwd);
    const project = db.getProjectByCanonicalId(detected.canonical_id);
    if (project) {
      projectId = project.id;
      projectName = project.name;
    }
  }

  const lexical = db.searchChatMessages(input.query, projectId, limit * 3, input.user_id);
  let semantic: VecChatMatchRow[] = [];
  const queryEmbedding = db.vecAvailable
    ? await embedText(composeChatEmbeddingText(queryForEmbedding(input.query)))
    : null;
  if (queryEmbedding && db.vecAvailable) {
    semantic = db.searchChatVec(queryEmbedding, projectId, limit * 3, input.user_id);
  }
  const messageIds = mergeChatResults(db, lexical, semantic, normalizedQuery, limit);
  const messages = messageIds.length > 0 ? db.getChatMessagesByIds(messageIds) : [];

  return {
    messages,
    project: projectName,
    session_count: countDistinctSessions(messages),
    source_summary: summarizeChatSources(messages),
    transcript_backed: messages.some((message) => message.source_kind === "transcript"),
    semantic_backed: semantic.length > 0,
  };
}

const RRF_K = 40;

function mergeChatResults(
  db: MemDatabase,
  lexical: ChatMessageRow[],
  semantic: VecChatMatchRow[],
  query: string,
  limit: number
): number[] {
  const scores = new Map<number, number>();
  const rows = new Map<number, ChatMessageRow>(lexical.map((message) => [message.id, message]));
  const semanticOnlyIds = semantic
    .map((match) => match.chat_message_id)
    .filter((id) => !rows.has(id));

  for (const row of db.getChatMessagesByIds(semanticOnlyIds)) {
    rows.set(row.id, row);
  }

  const nowEpoch = Math.floor(Date.now() / 1000);

  for (let rank = 0; rank < lexical.length; rank++) {
    const message = lexical[rank]!;
    scores.set(message.id, (scores.get(message.id) ?? 0) + 1 / (RRF_K + rank + 1));
  }

  for (let rank = 0; rank < semantic.length; rank++) {
    const match = semantic[rank]!;
    scores.set(match.chat_message_id, (scores.get(match.chat_message_id) ?? 0) + 1 / (RRF_K + rank + 1));
  }

  for (const [id, row] of rows) {
    scores.set(id, (scores.get(id) ?? 0) + computeChatQualityBoost(row, query, nowEpoch));
  }

  return Array.from(scores.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return (rows.get(b[0])?.created_at_epoch ?? 0) - (rows.get(a[0])?.created_at_epoch ?? 0);
    })
    .slice(0, limit)
    .map(([id]) => id);
}

function queryForEmbedding(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 400);
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function computeChatQualityBoost(
  message: ChatMessageRow,
  query: string,
  nowEpoch: number
): number {
  const normalizedContent = message.content.replace(/\s+/g, " ").trim().toLowerCase();
  const ageHours = Math.max(0, (nowEpoch - message.created_at_epoch) / 3600);
  const directPhraseBoost = normalizedContent.includes(query) ? 0.3 : 0;
  const termBoost = allQueryTermsPresent(normalizedContent, query) ? 0.12 : 0;
  const sourceBoost = message.source_kind === "transcript" ? 0.12 : 0.04;
  const recencyBoost =
    ageHours < 1 ? 0.35 :
    ageHours < 6 ? 0.22 :
    ageHours < 24 ? 0.12 :
    ageHours < 72 ? 0.04 : 0;

  return directPhraseBoost + termBoost + sourceBoost + recencyBoost;
}

function allQueryTermsPresent(content: string, query: string): boolean {
  const terms = query.split(/\s+/).filter((term) => term.length >= 3);
  return terms.length > 0 && terms.every((term) => content.includes(term));
}

function summarizeChatSources(messages: ChatMessageRow[]): { transcript: number; hook: number } {
  return messages.reduce(
    (summary, message) => {
      summary[message.source_kind] += 1;
      return summary;
    },
    { transcript: 0, hook: 0 }
  );
}

function countDistinctSessions(messages: ChatMessageRow[]): number {
  return new Set(messages.map((message) => message.session_id)).size;
}
