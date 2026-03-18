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
  lines.push("");

  return lines.join("\n");
}

runHook("session-start", main);
