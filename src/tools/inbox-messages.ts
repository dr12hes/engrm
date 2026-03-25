import type { MemDatabase } from "../storage/sqlite.js";

export interface InboxMessageRow {
  id: number;
  title: string;
  narrative: string | null;
  user_id: string;
  device_id: string;
  created_at: string;
}

const INBOX_MESSAGE_FILTER_SQL = `
  type = 'message'
  AND lifecycle IN ('active', 'pinned')
  AND (source_tool IS NULL OR source_tool NOT IN ('create_handoff', 'rolling_handoff'))
  AND (
    concepts IS NULL OR (
      concepts NOT LIKE '%"session-handoff"%'
      AND concepts NOT LIKE '%"draft-handoff"%'
    )
  )
`;

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
