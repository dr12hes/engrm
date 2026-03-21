#!/usr/bin/env bun
/**
 * PreCompact hook for Claude Code.
 *
 * Fires before conversation compaction. Re-injects project memory
 * so it survives the context window compression.
 *
 * Output goes to stdout and is included in the compacted context.
 */

import { configExists, loadConfig, getDbPath } from "../src/config.js";
import { MemDatabase } from "../src/storage/sqlite.js";
import type { ObservationRow } from "../src/storage/sqlite.js";
import {
  buildSessionContext,
  formatContextForInjection,
} from "../src/context/inject.js";

interface PreCompactEvent {
  session_id: string;
  hook_event_name: string;
  cwd: string;
  trigger: string;
}

/**
 * Format current session observations as a summary so the agent
 * remembers what it was working on after compaction.
 */
function formatCurrentSessionContext(observations: ObservationRow[]): string {
  if (observations.length === 0) return "";

  const lines: string[] = [
    "",
    "Current session progress (before compaction):",
  ];

  // Group by type for a structured summary
  const byType = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    if (obs.type === "change" && (!obs.narrative || obs.narrative.length < 80)) continue;
    const group = byType.get(obs.type) ?? [];
    group.push(obs);
    byType.set(obs.type, group);
  }

  for (const [type, obs] of byType) {
    for (const o of obs.slice(0, 3)) {
      lines.push(`- [${type}] ${o.title}`);
    }
    if (obs.length > 3) {
      lines.push(`  (+${obs.length - 3} more ${type}s)`);
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
  }
  const raw = chunks.join("");

  if (!raw.trim()) process.exit(0);

  let event: PreCompactEvent;
  try {
    event = JSON.parse(raw) as PreCompactEvent;
  } catch {
    process.exit(0);
  }

  if (!configExists()) process.exit(0);

  let config;
  let db;
  try {
    config = loadConfig();
    db = new MemDatabase(getDbPath());
  } catch {
    process.exit(0);
  }

  try {
    // Inject project-level memory (observations from all sessions)
    const context = buildSessionContext(db, event.cwd, {
      tokenBudget: 800,
      scope: config.search.scope,
      currentDeviceId: config.device_id,
    });
    if (context && context.observations.length > 0) {
      // stdout → injected into compacted context for Claude
      console.log(formatContextForInjection(context));

      // stderr → shown to user in terminal as a visible note
      const parts: string[] = [];
      parts.push(`${context.session_count} observation(s) loaded`);
      if (context.securityFindings && context.securityFindings.length > 0) {
        parts.push(`${context.securityFindings.length} security finding(s)`);
      }
      const remaining = context.total_active - context.session_count;
      if (remaining > 0) {
        parts.push(`${remaining} more available`);
      }
      console.error(`Engrm: ${parts.join(" · ")} — project memory preserved`);
    }

    // Also inject current session observations so the agent
    // remembers what it was working on before compaction
    let sessionCount = 0;
    if (event.session_id) {
      const sessionObs = db.getObservationsBySession(event.session_id);
      if (sessionObs.length > 0) {
        console.log(formatCurrentSessionContext(sessionObs));
        sessionCount = sessionObs.length;
      }
    }

    if (sessionCount > 0) {
      console.error(`Engrm: ${sessionCount} session observation(s) carried forward`);
    }
  } finally {
    db.close();
  }
}

main().catch(() => {
  process.exit(0);
});
