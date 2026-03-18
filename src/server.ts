#!/usr/bin/env bun
/**
 * Engrm — MCP Server entry point.
 *
 * Registers MCP tools and runs over stdio transport.
 * Creates a single MemDatabase instance shared across all tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig, getDbPath, configExists } from "./config.js";
import { MemDatabase } from "./storage/sqlite.js";
import { saveObservation } from "./tools/save.js";
import { searchObservations } from "./tools/search.js";
import { getObservations } from "./tools/get.js";
import { getTimeline } from "./tools/timeline.js";
import { pinObservation } from "./tools/pin.js";
import { getRecentActivity } from "./tools/recent.js";
import { sendMessage } from "./tools/send-message.js";
import { getMemoryStats } from "./tools/stats.js";
import {
  buildSessionContext,
  formatContextForInjection,
} from "./context/inject.js";
import { runDueJobs } from "./lifecycle/scheduler.js";
import { SyncEngine } from "./sync/engine.js";
import { backfillEmbeddings } from "./embeddings/backfill.js";
import { loadPack, recommendPacks } from "./packs/recommender.js";
import { detectStacksFromProject } from "./telemetry/stack-detect.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Bootstrap ---

if (!configExists()) {
  console.error(
    "Engrm is not configured. Run: engrm init --manual"
  );
  process.exit(1);
}

const config = loadConfig();
const db = new MemDatabase(getDbPath());

// Double-injection guard: track whether context has been served this session.
// Stdio transport = 1 process per session, so module-level flag is safe.
let contextServed = false;

// Search-quality tracking: detect fetch-after-search pattern.
let _lastSearchSessionId: string | null = null;

// Session-level metrics for the telemetry beacon.
// Mutated by tool handlers, read at beacon-build time.
export interface SessionMetrics {
  contextObsInjected: number;
  contextTotalAvailable: number;
  recallAttempts: number;
  recallHits: number;
  searchCount: number;
  searchResultsTotal: number;
}

export const sessionMetrics: SessionMetrics = {
  contextObsInjected: 0,
  contextTotalAvailable: 0,
  recallAttempts: 0,
  recallHits: 0,
  searchCount: 0,
  searchResultsTotal: 0,
};

const MCP_METRICS_PATH = join(homedir(), ".engrm", "mcp-session-metrics.json");

/**
 * Persist session metrics to a well-known file so the stop hook
 * can read them when building the telemetry beacon.
 * One MCP server per session (stdio transport), so no race.
 */
function persistSessionMetrics(): void {
  try {
    const dir = join(homedir(), ".engrm");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(MCP_METRICS_PATH, JSON.stringify(sessionMetrics), "utf-8");
  } catch {
    // Best-effort
  }
}

// Agent auto-detection: resolved lazily from MCP clientInfo on first tool call.
let _detectedAgent: string | null = null;

/**
 * Get the detected agent name. Reads from MCP clientInfo (set during initialize).
 * Resolved lazily because initialize happens after connect().
 */
function getDetectedAgent(): string {
  if (_detectedAgent) return _detectedAgent;
  try {
    const clientInfo = server.server.getClientVersion();
    if (clientInfo?.name) {
      _detectedAgent = resolveAgentName(clientInfo.name);
      return _detectedAgent;
    }
  } catch {
    // Not yet initialized — use default
  }
  return "claude-code";
}

/**
 * Map MCP clientInfo.name to our agent identifiers.
 */
function resolveAgentName(clientName: string): string {
  const name = clientName.toLowerCase();
  if (name.includes("codex")) return "codex-cli";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("windsurf")) return "windsurf";
  if (name.includes("cline")) return "cline";
  if (name.includes("copilot")) return "vscode-copilot";
  if (name.includes("zed")) return "zed";
  if (name.includes("claude")) return "claude-code";
  return clientName;
}

// Sync engine (started in main, needs module-level ref for shutdown)
let syncEngine: SyncEngine | null = null;

// Graceful shutdown
process.on("SIGINT", () => {
  syncEngine?.stop();
  db.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  syncEngine?.stop();
  db.close();
  process.exit(0);
});

// --- MCP Server ---

const server = new McpServer({
  name: "engrm",
  version: "0.1.0",
});

// Tool: save_observation
server.tool(
  "save_observation",
  "Save an observation to memory",
  {
    type: z.enum([
      "bugfix",
      "discovery",
      "decision",
      "pattern",
      "change",
      "feature",
      "refactor",
      "digest",
      "message",
    ]),
    title: z.string().describe("Brief title"),
    narrative: z.string().optional().describe("What happened and why"),
    facts: z.array(z.string()).optional().describe("Key facts"),
    concepts: z.array(z.string()).optional().describe("Tags"),
    files_read: z
      .array(z.string())
      .optional()
      .describe("Files read (project-relative)"),
    files_modified: z
      .array(z.string())
      .optional()
      .describe("Files modified (project-relative)"),
    sensitivity: z.enum(["shared", "personal", "secret"]).optional(),
    session_id: z.string().optional(),
    supersedes: z.number().optional().describe("ID of observation this replaces"),
  },
  async (params) => {
    const result = await saveObservation(db, config, { ...params, agent: getDetectedAgent() });

    if (!result.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Not saved: ${result.reason}`,
          },
        ],
      };
    }

    if (result.merged_into) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Merged into observation #${result.merged_into} (quality: ${result.quality_score?.toFixed(2)})`,
          },
        ],
      };
    }

    // Handle supersession: archive the old observation
    let supersessionNote = "";
    if (params.supersedes && result.observation_id) {
      const superseded = db.supersedeObservation(
        params.supersedes,
        result.observation_id
      );
      if (superseded) {
        supersessionNote = `, supersedes #${params.supersedes}`;
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Saved observation #${result.observation_id} (quality: ${result.quality_score?.toFixed(2)}${supersessionNote})`,
        },
      ],
    };
  }
);

// Tool: search
server.tool(
  "search",
  "Search memory for observations",
  {
    query: z.string().describe("Search query"),
    project_scoped: z.boolean().optional().describe("Scope to project (default: true)"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  },
  async (params) => {
    const result = await searchObservations(db, {
      ...params,
      user_id: config.user_id,
    });

    // Track searches_performed for telemetry beacon
    _lastSearchSessionId = "active";
    sessionMetrics.searchCount++;
    sessionMetrics.searchResultsTotal += result.total;
    persistSessionMetrics();

    if (result.total === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: result.project
              ? `No observations found for "${params.query}" in project ${result.project}`
              : `No observations found for "${params.query}"`,
          },
        ],
      };
    }

    // Format as compact table
    const header = "| ID | Type | Q | Title | Created |";
    const separator = "|---|---|---|---|---|";
    const rows = result.observations.map((obs) => {
      const qualityDots = qualityIndicator(obs.quality);
      const date = obs.created_at.split("T")[0];
      return `| ${obs.id} | ${obs.type} | ${qualityDots} | ${obs.title} | ${date} |`;
    });

    const projectLine = result.project
      ? `Project: ${result.project}\n`
      : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Found ${result.total} result(s):\n\n${header}\n${separator}\n${rows.join("\n")}`,
        },
      ],
    };
  }
);

// Tool: get_observations
server.tool(
  "get_observations",
  "Get observations by ID",
  {
    ids: z.array(z.number()).describe("Observation IDs"),
  },
  async (params) => {
    const result = getObservations(db, {
      ...params,
      user_id: config.user_id,
    });

    if (result.observations.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No observations found for IDs: ${params.ids.join(", ")}`,
          },
        ],
      };
    }

    const formatted = result.observations.map((obs) => {
      const parts = [
        `## Observation #${obs.id}`,
        `**Type**: ${obs.type} | **Quality**: ${obs.quality.toFixed(2)} | **Lifecycle**: ${obs.lifecycle}`,
        `**Title**: ${obs.title}`,
      ];
      if (obs.narrative) parts.push(`**Narrative**: ${obs.narrative}`);
      if (obs.facts) parts.push(`**Facts**: ${obs.facts}`);
      if (obs.concepts) parts.push(`**Concepts**: ${obs.concepts}`);
      if (obs.files_modified)
        parts.push(`**Files modified**: ${obs.files_modified}`);
      if (obs.files_read) parts.push(`**Files read**: ${obs.files_read}`);
      parts.push(`**Created**: ${obs.created_at}`);
      return parts.join("\n");
    });

    let text = formatted.join("\n\n---\n\n");
    if (result.not_found.length > 0) {
      text += `\n\nNot found: ${result.not_found.join(", ")}`;
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// Tool: timeline
server.tool(
  "timeline",
  "Timeline around an observation",
  {
    anchor: z.number().describe("Observation ID to centre on"),
    depth_before: z.number().optional().describe("Before anchor (default: 3)"),
    depth_after: z.number().optional().describe("After anchor (default: 3)"),
    project_scoped: z.boolean().optional().describe("Scope to project (default: true)"),
  },
  async (params) => {
    const result = getTimeline(db, {
      anchor_id: params.anchor,
      depth_before: params.depth_before,
      depth_after: params.depth_after,
      project_scoped: params.project_scoped,
      user_id: config.user_id,
    });

    if (result.observations.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Observation #${params.anchor} not found`,
          },
        ],
      };
    }

    const lines = result.observations.map((obs, i) => {
      const marker = i === result.anchor_index ? "→" : " ";
      const date = obs.created_at.split("T")[0];
      return `${marker} #${obs.id} [${date}] ${obs.type}: ${obs.title}`;
    });

    const projectLine = result.project
      ? `Project: ${result.project}\n`
      : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Timeline around #${params.anchor}:\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// Tool: pin_observation
server.tool(
  "pin_observation",
  "Pin/unpin observation",
  {
    id: z.number().describe("Observation ID"),
    pinned: z.boolean().describe("true=pin, false=unpin"),
  },
  async (params) => {
    const result = pinObservation(db, params);

    return {
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `Observation #${params.id} ${params.pinned ? "pinned" : "unpinned"}`
            : `Failed: ${result.reason}`,
        },
      ],
    };
  }
);

// Tool: check_messages
server.tool(
  "check_messages",
  "Check for messages sent from other devices or sessions. Messages are cross-device notes left by you or your team.",
  {
    mark_read: z.boolean().optional().describe("Mark messages as read after viewing (default: true)"),
  },
  async (params) => {
    const markRead = params.mark_read !== false;

    // Find unread messages: type='message', not from this device, not yet marked read
    const readKey = `messages_read_${config.device_id}`;
    const lastReadId = parseInt(db.getSyncState(readKey) ?? "0", 10);

    const messages = db.db
      .query<{
        id: number; title: string; narrative: string | null;
        user_id: string; device_id: string; created_at: string;
      }, [number, string, string]>(
        `SELECT id, title, narrative, user_id, device_id, created_at FROM observations
         WHERE type = 'message'
           AND id > ?
           AND lifecycle IN ('active', 'pinned')
           AND device_id != ?
           AND (sensitivity != 'personal' OR user_id = ?)
         ORDER BY created_at_epoch DESC LIMIT 20`
      )
      .all(lastReadId, config.device_id, config.user_id);

    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No new messages." }],
      };
    }

    // Mark as read
    if (markRead && messages.length > 0) {
      const maxId = Math.max(...messages.map((m) => m.id));
      db.setSyncState(readKey, String(maxId));
    }

    const lines = messages.map((m) => {
      const from = m.device_id === config.device_id ? "you (this device)" : m.device_id;
      const ago = formatTimeAgo(m.created_at);
      return `[${ago}] from ${from}:\n  ${m.title}${m.narrative ? "\n  " + m.narrative : ""}`;
    });

    return {
      content: [{
        type: "text" as const,
      text: `${messages.length} message(s):\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

// Tool: send_message
server.tool(
  "send_message",
  "Leave a cross-device or team note in Engrm's shared inbox",
  {
    title: z.string().describe("Short message title"),
    narrative: z.string().optional().describe("Optional message body"),
    concepts: z.array(z.string()).optional().describe("Optional tags"),
    session_id: z.string().optional(),
  },
  async (params) => {
    const result = await sendMessage(db, config, {
      ...params,
      cwd: process.cwd(),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `Message saved as observation #${result.observation_id}`
            : `Failed: ${result.reason}`,
        },
      ],
    };
  }
);

// Tool: recent_activity
server.tool(
  "recent_activity",
  "Inspect the most recent observations captured by Engrm",
  {
    limit: z.number().optional().describe("Max observations to return (default: 10)"),
    project_scoped: z.boolean().optional().describe("Scope to current project (default: true)"),
    type: z.string().optional().describe("Optional observation type filter"),
  },
  async (params) => {
    const result = getRecentActivity(db, {
      ...params,
      cwd: process.cwd(),
      user_id: config.user_id,
    });

    if (result.observations.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: result.project
              ? `No recent observations found in project ${result.project}.`
              : "No recent observations found.",
          },
        ],
      };
    }

    const showProject = !result.project;
    const header = showProject
      ? "| ID | Project | Type | Title | Created |"
      : "| ID | Type | Title | Created |";
    const separator = showProject
      ? "|---|---|---|---|---|"
      : "|---|---|---|---|";
    const rows = result.observations.map((obs) => {
      const date = obs.created_at.split("T")[0];
      if (showProject) {
        return `| ${obs.id} | ${obs.project_name ?? "(unknown)"} | ${obs.type} | ${obs.title} | ${date} |`;
      }
      return `| ${obs.id} | ${obs.type} | ${obs.title} | ${date} |`;
    });

    const projectLine = result.project ? `Project: ${result.project}\n` : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Recent activity:\n\n${header}\n${separator}\n${rows.join("\n")}`,
        },
      ],
    };
  }
);

// Tool: memory_stats
server.tool(
  "memory_stats",
  "Show high-level Engrm capture and sync statistics",
  {},
  async () => {
    const stats = getMemoryStats(db);
    const packs = stats.installed_packs.length > 0
      ? stats.installed_packs.join(", ")
      : "(none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Active observations: ${stats.active_observations}\n` +
            `Messages: ${stats.messages}\n` +
            `Session summaries: ${stats.session_summaries}\n` +
            `Installed packs: ${packs}\n` +
            `Outbox: pending ${stats.outbox.pending ?? 0}, failed ${stats.outbox.failed ?? 0}, synced ${stats.outbox.synced ?? 0}`,
        },
      ],
    };
  }
);

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Tool: install_pack
server.tool(
  "install_pack",
  "Install a help pack (pre-curated observations for a technology stack)",
  {
    pack_name: z.string().describe("Pack name (e.g. 'typescript-patterns', 'react-gotchas')"),
  },
  async (params) => {
    const installed = db.getInstalledPacks();
    if (installed.includes(params.pack_name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Pack '${params.pack_name}' is already installed.`,
          },
        ],
      };
    }

    const pack = loadPack(params.pack_name);
    if (!pack) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Pack '${params.pack_name}' not found. Available packs can be recommended based on your project's technology stack.`,
          },
        ],
      };
    }

    let savedCount = 0;
    for (const obs of pack.observations) {
      try {
        await saveObservation(db, config, {
          type: obs.type as "pattern" | "bugfix" | "discovery" | "decision" | "change" | "feature" | "refactor" | "digest",
          title: obs.title,
          narrative: obs.narrative,
          concepts: obs.concepts,
          agent: getDetectedAgent(),
        });
        savedCount++;
      } catch {
        // Skip individual failures
      }
    }

    db.markPackInstalled(params.pack_name, savedCount);

    return {
      content: [
        {
          type: "text" as const,
          text: `Installed pack '${params.pack_name}': ${savedCount}/${pack.observations.length} observations saved.`,
        },
      ],
    };
  }
);

// Tool: session_context
server.tool(
  "session_context",
  "Load project memory for this session",
  {
    max_observations: z.number().optional().describe("Max observations (default: token-budgeted)"),
  },
  async (params) => {
    // Double-injection guard
    if (contextServed) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Context already loaded for this session. Use search for specific queries.",
          },
        ],
      };
    }

    const context = buildSessionContext(
      db,
      process.cwd(),
      params.max_observations
        ? { maxCount: params.max_observations, userId: config.user_id }
        : { tokenBudget: 800, userId: config.user_id }
    );

    if (!context || context.observations.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: context
              ? `Project: ${context.project_name} — no prior observations found.`
              : "Could not detect project.",
          },
        ],
      };
    }

    contextServed = true;

    // Track injection metrics for beacon
    sessionMetrics.contextObsInjected = context.observations.length;
    sessionMetrics.contextTotalAvailable = context.total_active;
    persistSessionMetrics();

    return {
      content: [
        {
          type: "text" as const,
          text: formatContextForInjection(context),
        },
      ],
    };
  }
);

// --- Helpers ---

function qualityIndicator(quality: number): string {
  const filled = Math.round(quality * 5);
  return "●".repeat(filled) + "○".repeat(5 - filled);
}

// --- Start ---

async function main(): Promise<void> {
  // Run lifecycle jobs if due (aging, compaction, purge)
  runDueJobs(db);

  // Backfill embeddings for observations without vectors (non-blocking)
  if (db.vecAvailable) {
    backfillEmbeddings(db, 100).catch(() => {});
  }

  // Start sync engine (no-op if not configured)
  syncEngine = new SyncEngine(db, config);
  syncEngine.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal:", error);
  db.close();
  process.exit(1);
});
