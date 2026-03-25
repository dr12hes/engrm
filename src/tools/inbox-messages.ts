import type { MemDatabase, ObservationRow } from "../storage/sqlite.js";

export interface InboxMessageRow {
  id: number;
  title: string;
  narrative: string | null;
  user_id: string;
  device_id: string;
  created_at: string;
}

function buildHandoffMessageFilterSql(lifecycle: string): string {
  return `
  type = 'message'
  AND lifecycle IN (${lifecycle})
  AND (
    COALESCE(source_tool, '') IN ('create_handoff', 'rolling_handoff')
    OR title LIKE 'Handoff:%'
    OR title LIKE 'Handoff Draft:%'
    OR (
      concepts IS NOT NULL AND (
        concepts LIKE '%"handoff"%'
        OR concepts LIKE '%"session-handoff"%'
        OR concepts LIKE '%"draft-handoff"%'
      )
    )
  )
`;
}

const HANDOFF_MESSAGE_FILTER_SQL = buildHandoffMessageFilterSql("'active', 'pinned'");

const INBOX_MESSAGE_FILTER_SQL = `
  type = 'message'
  AND lifecycle IN ('active', 'pinned')
  AND NOT (${HANDOFF_MESSAGE_FILTER_SQL})
`;

export type MessageObservationKind = "handoff" | "draft-handoff" | "inbox-note";

export function getHandoffMessageFilterSql(options?: { include_aging?: boolean }): string {
  return buildHandoffMessageFilterSql(
    options?.include_aging ? "'active', 'aging', 'pinned'" : "'active', 'pinned'"
  );
}

export function getInboxMessageFilterSql(): string {
  return INBOX_MESSAGE_FILTER_SQL;
}

export function classifyMessageObservation(
  observation: Pick<ObservationRow, "type" | "title" | "concepts" | "source_tool">
): MessageObservationKind | null {
  if (observation.type !== "message") return null;

  const concepts = parseConcepts(observation.concepts);
  const isDraft =
    observation.title.startsWith("Handoff Draft:")
    || observation.source_tool === "rolling_handoff"
    || concepts.includes("draft-handoff")
    || concepts.includes("auto-handoff");
  if (isDraft) return "draft-handoff";

  const isHandoff =
    observation.title.startsWith("Handoff:")
    || observation.source_tool === "create_handoff"
    || concepts.includes("handoff")
    || concepts.includes("session-handoff");
  if (isHandoff) return "handoff";

  return "inbox-note";
}

function parseConcepts(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function getInboxMessageCount(db: MemDatabase): number {
  return db.db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) as c FROM observations
       WHERE ${INBOX_MESSAGE_FILTER_SQL}`
    )
    .get()?.c ?? 0;
}

export function getUnreadInboxMessageCount(
  db: MemDatabase,
  currentDeviceId: string,
  userId: string,
  lastReadId: number
): number {
  return db.db
    .query<{ c: number }, [number, string, string]>(
      `SELECT COUNT(*) as c FROM observations
       WHERE ${INBOX_MESSAGE_FILTER_SQL}
         AND id > ?
         AND device_id != ?
         AND (sensitivity != 'personal' OR user_id = ?)`
    )
    .get(lastReadId, currentDeviceId, userId)?.c ?? 0;
}

export function getUnreadInboxMessages(
  db: MemDatabase,
  currentDeviceId: string,
  userId: string,
  lastReadId: number,
  limit = 20
): InboxMessageRow[] {
  return db.db
    .query<InboxMessageRow, [number, string, string, number]>(
      `SELECT id, title, narrative, user_id, device_id, created_at FROM observations
       WHERE ${INBOX_MESSAGE_FILTER_SQL}
         AND id > ?
         AND device_id != ?
         AND (sensitivity != 'personal' OR user_id = ?)
       ORDER BY created_at_epoch DESC LIMIT ?`
    )
    .all(lastReadId, currentDeviceId, userId, limit);
}
