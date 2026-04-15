/**
 * Push engine: flush sync outbox to Candengo Vector.
 *
 * Reads pending entries from the outbox, builds Vector documents,
 * and pushes them via the REST client. Supports batch operations.
 */

import type {
  ChatMessageRow,
  MemDatabase,
  ObservationRow,
  SessionSummaryRow,
  ToolEventRow,
  UserPromptRow,
} from "../storage/sqlite.js";
import type { Config } from "../config.js";
import {
  getPendingEntries,
  markSyncing,
  markSynced,
  markFailed,
} from "../storage/outbox.js";
import { VectorClient, type VectorDocument } from "./client.js";
import { buildSourceId } from "./auth.js";
import { computeSessionValueSignals } from "../intelligence/value-signals.js";
import { extractSummaryItems } from "../intelligence/summary-sections.js";
import { buildSessionHandoffMetadata, type SessionHandoffMetadata } from "../capture/session-handoff.js";
import { scrubFleetIdentifiers } from "../capture/scrubber.js";
import { resolveSyncTarget, type SyncTarget } from "./targets.js";

export interface PushResult {
  pushed: number;
  failed: number;
  skipped: number;
}

export interface PushOutboxOptions {
  timeoutMs?: number;
}

export function buildChatVectorDocument(
  chat: ChatMessageRow,
  config: Config,
  project: { canonical_id: string; name: string },
  target: SyncTarget = resolveSyncTarget(config, project.name)
): VectorDocument {
  return {
    site_id: target.siteId,
    namespace: target.namespace,
    source_type: "chat",
    source_id: buildSourceId(config, chat.id, "chat"),
    content: chat.content,
    metadata: {
      project_canonical: project.canonical_id,
      project_name: project.name,
      user_id: chat.user_id,
      device_id: chat.device_id,
      device_name: require("node:os").hostname(),
      agent: chat.agent,
      type: "chat",
      role: chat.role,
      session_id: chat.session_id,
      created_at_epoch: chat.created_at_epoch,
      local_id: chat.id,
      source_kind: chat.source_kind,
      transcript_index: chat.transcript_index,
    },
  };
}

type SummaryCaptureContext = SessionHandoffMetadata;

/**
 * Build a Candengo Vector document from a local observation.
 */
export function buildVectorDocument(
  obs: ObservationRow,
  config: Config,
  project: { canonical_id: string; name: string },
  target: SyncTarget = resolveSyncTarget(config, project.name)
): VectorDocument {
  // Compose content: title + narrative + facts
  const parts = [obs.title];
  if (obs.narrative) parts.push(obs.narrative);
  if (obs.facts) {
    try {
      const facts = JSON.parse(obs.facts) as string[];
      if (Array.isArray(facts) && facts.length > 0) {
        parts.push("Facts:\n" + facts.map((f) => `- ${f}`).join("\n"));
      }
    } catch {
      // Not valid JSON — use as-is
      parts.push(obs.facts);
    }
  }

  return {
    site_id: target.siteId,
    namespace: target.namespace,
    source_type: obs.type,
    source_id: buildSourceId(config, obs.id),
    content: parts.join("\n\n"),
    metadata: {
      project_canonical: project.canonical_id,
      project_name: project.name,
      user_id: obs.user_id,
      device_id: obs.device_id,
      device_name: require("node:os").hostname(),
      agent: obs.agent,
      title: obs.title,
      narrative: obs.narrative,
      type: obs.type,
      quality: obs.quality,
      facts: obs.facts ? JSON.parse(obs.facts) : [],
      concepts: obs.concepts ? JSON.parse(obs.concepts) : [],
      files_read: obs.files_read ? JSON.parse(obs.files_read) : [],
      files_modified: obs.files_modified
        ? JSON.parse(obs.files_modified)
        : [],
      source_tool: obs.source_tool,
      source_prompt_number: obs.source_prompt_number,
      session_id: obs.session_id,
      created_at_epoch: obs.created_at_epoch,
      created_at: obs.created_at,
      sensitivity: obs.sensitivity,
      local_id: obs.id,
    },
  };
}

/**
 * Build a Candengo Vector document from a session summary.
 */
export function buildSummaryVectorDocument(
  summary: SessionSummaryRow,
  config: Config,
  project: { canonical_id: string; name: string },
  targetOrObservations: SyncTarget | ObservationRow[] = resolveSyncTarget(config, project.name),
  observationsOrCaptureContext: ObservationRow[] | SummaryCaptureContext = [],
  captureContext?: SummaryCaptureContext
): VectorDocument {
  const target = Array.isArray(targetOrObservations)
    ? resolveSyncTarget(config, project.name)
    : targetOrObservations;
  const observations = Array.isArray(targetOrObservations)
    ? targetOrObservations
    : Array.isArray(observationsOrCaptureContext)
      ? observationsOrCaptureContext
      : [];
  const resolvedCaptureContext = Array.isArray(observationsOrCaptureContext)
    ? captureContext
    : observationsOrCaptureContext;
  const parts: string[] = [];
  if (summary.request) parts.push(`Request: ${summary.request}`);
  if (summary.investigated) parts.push(`Investigated: ${summary.investigated}`);
  if (summary.learned) parts.push(`Learned: ${summary.learned}`);
  if (summary.completed) parts.push(`Completed: ${summary.completed}`);
  if (summary.next_steps) parts.push(`Next Steps: ${summary.next_steps}`);

  const valueSignals = computeSessionValueSignals(observations, []);
  const observationSourceTools = resolvedCaptureContext?.observation_source_tools
    ?? summarizeObservationSourceTools(observations);
  const latestObservationPromptNumber = resolvedCaptureContext?.latest_observation_prompt_number
    ?? observations.reduce<number | null>((latest, obs) => {
      if (typeof obs.source_prompt_number !== "number") return latest;
      if (latest === null || obs.source_prompt_number > latest) return obs.source_prompt_number;
      return latest;
    }, null);

  return {
    site_id: target.siteId,
    namespace: target.namespace,
    source_type: "summary",
    source_id: buildSourceId(config, summary.id, "summary"),
    content: parts.join("\n\n"),
    metadata: {
      project_canonical: project.canonical_id,
      project_name: project.name,
      user_id: summary.user_id,
      session_id: summary.session_id,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      current_thread: summary.current_thread,
      summary_sections_present: countPresentSections(summary),
      investigated_items: extractSectionItems(summary.investigated),
      learned_items: extractSectionItems(summary.learned),
      completed_items: extractSectionItems(summary.completed),
      next_step_items: extractSectionItems(summary.next_steps),
      prompt_count: resolvedCaptureContext?.prompt_count ?? 0,
      tool_event_count: resolvedCaptureContext?.tool_event_count ?? 0,
      capture_state: resolvedCaptureContext?.capture_state ?? "summary-only",
      recent_request_prompts: resolvedCaptureContext?.recent_request_prompts ?? [],
      latest_request: resolvedCaptureContext?.latest_request ?? null,
      current_thread: resolvedCaptureContext?.current_thread ?? null,
      recent_tool_names: resolvedCaptureContext?.recent_tool_names ?? [],
      recent_tool_commands: resolvedCaptureContext?.recent_tool_commands ?? [],
      hot_files: resolvedCaptureContext?.hot_files ?? [],
      recent_outcomes: resolvedCaptureContext?.recent_outcomes ?? [],
      observation_source_tools: observationSourceTools,
      latest_observation_prompt_number: latestObservationPromptNumber,
      decisions_count: valueSignals.decisions_count,
      lessons_count: valueSignals.lessons_count,
      discoveries_count: valueSignals.discoveries_count,
      features_count: valueSignals.features_count,
      refactors_count: valueSignals.refactors_count,
      repeated_patterns_count: valueSignals.repeated_patterns_count,
      delivery_review_ready: valueSignals.delivery_review_ready,
      vibe_guardian_active: valueSignals.vibe_guardian_active,
      created_at_epoch: summary.created_at_epoch,
      local_id: summary.id,
    },
  };
}

/**
 * Push pending outbox entries to Candengo Vector.
 */
export async function pushOutbox(
  db: MemDatabase,
  config: Config,
  batchSize: number = 50,
  options: PushOutboxOptions = {}
): Promise<PushResult> {
  const entries = getPendingEntries(db, batchSize);

  let pushed = 0;
  let failed = 0;
  let skipped = 0;

  // Collect documents for batch ingest
  const batch: { entryId: number; doc: VectorDocument; target: SyncTarget }[] = [];

  for (const entry of entries) {
    if (entry.record_type === "summary") {
      const summary = db.getSessionSummary(
        // record_id is the summary row id — look it up
        (() => {
          const row = db.db
            .query<{ session_id: string }, [number]>(
              "SELECT session_id FROM session_summaries WHERE id = ?"
            )
            .get(entry.record_id);
          return row?.session_id ?? "";
        })()
      );

      if (!summary || !summary.project_id) {
        markSynced(db, entry.id);
        skipped++;
        continue;
      }

      const project = db.getProjectById(summary.project_id);
      if (!project) {
        markSynced(db, entry.id);
        skipped++;
        continue;
      }

      markSyncing(db, entry.id);
      const summaryObservations = db.getObservationsBySession(summary.session_id);
      const sessionPrompts = db.getSessionUserPrompts(summary.session_id, 20);
      const sessionToolEvents = db.getSessionToolEvents(summary.session_id, 20);
      const target = resolveSyncTarget(config, project.name);
      const doc = buildSummaryVectorDocument(summary, config, {
        canonical_id: project.canonical_id,
        name: project.name,
      }, target, summaryObservations, buildSessionHandoffMetadata(sessionPrompts, sessionToolEvents, summaryObservations));
      batch.push({ entryId: entry.id, doc: maybeScrubFleetDocument(doc, target), target });
      continue;
    }

    if (entry.record_type === "chat_message") {
      const chat = db.getChatMessageById(entry.record_id);
      if (!chat || chat.remote_source_id) {
        markSynced(db, entry.id);
        skipped++;
        continue;
      }

      if (!chat.project_id) {
        markSynced(db, entry.id);
        skipped++;
        continue;
      }

      const project = db.getProjectById(chat.project_id);
      if (!project) {
        markSynced(db, entry.id);
        skipped++;
        continue;
      }

      markSyncing(db, entry.id);
      const target = resolveSyncTarget(config, project.name);
      const doc = buildChatVectorDocument(chat, config, {
        canonical_id: project.canonical_id,
        name: project.name,
      }, target);
      batch.push({ entryId: entry.id, doc: maybeScrubFleetDocument(doc, target), target });
      continue;
    }

    if (entry.record_type !== "observation") {
      skipped++;
      continue;
    }

    const obs = db.getObservationById(entry.record_id);
    if (!obs) {
      // Observation was deleted
      markSynced(db, entry.id);
      skipped++;
      continue;
    }

    // Don't sync secret observations
    if (obs.sensitivity === "secret") {
      markSynced(db, entry.id);
      skipped++;
      continue;
    }

    // Don't sync archived/purged observations (they get removed separately)
    if (obs.lifecycle === "archived" || obs.lifecycle === "purged") {
      markSynced(db, entry.id);
      skipped++;
      continue;
    }

    const project = db.getProjectById(obs.project_id);
    if (!project) {
      markSynced(db, entry.id);
      skipped++;
      continue;
    }

    markSyncing(db, entry.id);

    const target = resolveSyncTarget(config, project.name);
    const doc = buildVectorDocument(obs, config, {
      canonical_id: project.canonical_id,
      name: project.name,
    }, target);

    batch.push({ entryId: entry.id, doc: maybeScrubFleetDocument(doc, target), target });
  }

  if (batch.length === 0) return { pushed, failed, skipped };

  const grouped = new Map<string, { target: SyncTarget; items: typeof batch }>();
  for (const item of batch) {
    const existing = grouped.get(item.target.key);
    if (existing) {
      existing.items.push(item);
    } else {
      grouped.set(item.target.key, { target: item.target, items: [item] });
    }
  }

  for (const { target, items } of grouped.values()) {
    const client = new VectorClient(config, {
      apiKey: target.apiKey,
      namespace: target.namespace,
      siteId: target.siteId,
      timeoutMs: options.timeoutMs,
    });
    try {
      await client.batchIngest(items.map((b) => b.doc));
      for (const { entryId, doc } of items) {
        if (doc.source_type === "chat") {
          const localId = typeof doc.metadata?.local_id === "number" ? doc.metadata.local_id : null;
          if (localId !== null) {
            db.db
              .query("UPDATE chat_messages SET remote_source_id = ? WHERE id = ?")
              .run(doc.source_id, localId);
          }
        }
        markSynced(db, entryId);
        pushed++;
      }
    } catch {
      for (const { entryId, doc } of items) {
      try {
        await client.ingest(doc);
        if (doc.source_type === "chat") {
          const localId = typeof doc.metadata?.local_id === "number" ? doc.metadata.local_id : null;
          if (localId !== null) {
            db.db
              .query("UPDATE chat_messages SET remote_source_id = ? WHERE id = ?")
              .run(doc.source_id, localId);
          }
        }
        markSynced(db, entryId);
        pushed++;
      } catch (err) {
        markFailed(
          db,
          entryId,
          err instanceof Error ? err.message : String(err)
        );
        failed++;
      }
    }
  }
  }

  return { pushed, failed, skipped };
}

function maybeScrubFleetDocument(doc: VectorDocument, target: SyncTarget): VectorDocument {
  if (!target.isFleet) return doc;
  return {
    ...doc,
    content: scrubFleetIdentifiers(doc.content),
    metadata: scrubFleetMetadata(doc.metadata),
  };
}

function scrubFleetMetadata(value: unknown): unknown {
  if (typeof value === "string") return scrubFleetIdentifiers(value);
  if (Array.isArray(value)) return value.map((item) => scrubFleetMetadata(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubFleetMetadata(item)])
    );
  }
  return value;
}

function countPresentSections(summary: SessionSummaryRow): number {
  return [
    summary.request,
    summary.investigated,
    summary.learned,
    summary.completed,
    summary.next_steps,
  ].filter((value) => Boolean(value && value.trim())).length;
}

function extractSectionItems(section: string | null): string[] {
  return extractSummaryItems(section, 4);
}

function summarizeObservationSourceTools(
  observations: ObservationRow[]
): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const obs of observations) {
    const tool = obs.source_tool;
    if (!tool) continue;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.tool.localeCompare(b.tool);
    });
}
