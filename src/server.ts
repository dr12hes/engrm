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
import { getRecentRequests } from "./tools/recent-prompts.js";
import { getRecentTools } from "./tools/recent-tools.js";
import { getSessionStory } from "./tools/session-story.js";
import { getRecentSessions } from "./tools/recent-sessions.js";
import { getMemoryConsole } from "./tools/memory-console.js";
import { getProjectMemoryIndex } from "./tools/project-memory-index.js";
import { getWorkspaceMemoryIndex } from "./tools/workspace-memory-index.js";
import { getProjectRelatedWork } from "./tools/project-related-work.js";
import { reclassifyProjectMemory } from "./tools/reclassify-project-memory.js";
import { getActivityFeed } from "./tools/activity-feed.js";
import { getCaptureStatus } from "./tools/capture-status.js";
import { getCaptureQuality } from "./tools/capture-quality.js";
import { getToolMemoryIndex } from "./tools/tool-memory-index.js";
import { getSessionToolMemory } from "./tools/session-tool-memory.js";
import { getSessionContext } from "./tools/session-context.js";
import { captureGitWorktree } from "./tools/capture-git-worktree.js";
import { captureRepoScan } from "./tools/capture-repo-scan.js";
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
import { PLUGIN_SPEC_VERSION, PLUGIN_SURFACES } from "./plugins/types.js";
import { listPluginManifests } from "./plugins/registry.js";
import { savePluginMemory } from "./plugins/save.js";
import { reduceGitDiffToMemory } from "./plugins/git-diff.js";
import { reduceRepoScanToMemory } from "./plugins/repo-scan.js";
import { reduceOpenClawContentToMemory } from "./plugins/openclaw-content.js";

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
  version: "0.4.21",
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

// Tool: plugin_catalog
server.tool(
  "plugin_catalog",
  "List Engrm plugin manifests so tools can produce memory in a compatible shape",
  {
    surface: z.enum(PLUGIN_SURFACES).optional().describe("Optional surface filter"),
  },
  async (params) => {
    const manifests = listPluginManifests(params.surface);
    const lines = manifests.map((manifest) =>
      `- ${manifest.id} (${manifest.kind}) -> produces ${manifest.produces.join(", ")}; surfaces ${manifest.surfaces.join(", ")}`
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Engrm plugin spec: ${PLUGIN_SPEC_VERSION}\n\n` +
            (params.surface ? `Surface filter: ${params.surface}\n\n` : "") +
            (lines.length > 0 ? lines.join("\n") : "No plugin manifests available."),
        },
      ],
    };
  }
);

// Tool: save_plugin_memory
server.tool(
  "save_plugin_memory",
  "Save reduced plugin output as durable Engrm memory with stable plugin provenance",
  {
    plugin_id: z.string().describe("Stable plugin identifier such as 'engrm.git-diff'"),
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
    title: z.string().describe("Short durable memory title"),
    summary: z.string().optional().describe("Reduced summary of what happened and why it matters"),
    facts: z.array(z.string()).optional().describe("Reusable facts worth remembering"),
    tags: z.array(z.string()).optional().describe("Plugin-specific tags"),
    source: z.string().optional().describe("Upstream source like git, openclaw, ci, or issues"),
    source_refs: z.array(z.object({
      kind: z.enum(["file", "url", "ticket", "commit", "thread", "command", "other"]),
      value: z.string(),
    })).optional().describe("Pointers back to the original evidence"),
    surfaces: z.array(z.enum(PLUGIN_SURFACES)).optional().describe("Engrm surfaces this memory is designed to feed"),
    files_read: z.array(z.string()).optional().describe("Files read (project-relative when possible)"),
    files_modified: z.array(z.string()).optional().describe("Files modified (project-relative when possible)"),
    sensitivity: z.enum(["shared", "personal", "secret"]).optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional().describe("Project root for relative-path normalization"),
  },
  async (params) => {
    const result = await savePluginMemory(db, config, {
      ...params,
      agent: getDetectedAgent(),
    });

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
            text: `Merged plugin memory into observation #${result.merged_into} (quality: ${result.quality_score?.toFixed(2)})`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Saved plugin memory as observation #${result.observation_id} (quality: ${result.quality_score?.toFixed(2)})`,
        },
      ],
    };
  }
);

// Tool: capture_git_diff
server.tool(
  "capture_git_diff",
  "Reduce a git diff into a durable Engrm memory object and save it with plugin provenance",
  {
    diff: z.string().describe("Unified git diff text"),
    summary: z.string().optional().describe("Optional human summary or commit-style title"),
    files: z.array(z.string()).optional().describe("Optional changed file paths if already known"),
    session_id: z.string().optional(),
    cwd: z.string().optional().describe("Project root for relative-path normalization"),
  },
  async (params) => {
    const reduced = reduceGitDiffToMemory({
      ...params,
      cwd: params.cwd ?? process.cwd(),
      agent: getDetectedAgent(),
    });

    const result = await savePluginMemory(db, config, reduced);

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

    const reducedFacts = reduced.facts && reduced.facts.length > 0
      ? `\nFacts: ${reduced.facts.join("; ")}`
      : "";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Saved git diff as observation #${result.observation_id} ` +
            `(${reduced.type}: ${reduced.title})${reducedFacts}`,
        },
      ],
    };
  }
);

// Tool: capture_git_worktree
server.tool(
  "capture_git_worktree",
  "Capture the current git worktree as durable memory. Best for saving a meaningful local diff before context is lost.",
  {
    cwd: z.string().optional().describe("Git repo path. Defaults to the current working directory."),
    staged: z.boolean().optional().describe("If true, capture staged changes instead of unstaged worktree changes."),
    summary: z.string().optional().describe("Optional human summary or commit-style title to steer the saved memory."),
    session_id: z.string().optional().describe("Optional session ID to link this capture to active work."),
  },
  async (params) => {
    let worktree;
    try {
      worktree = captureGitWorktree({
        cwd: params.cwd ?? process.cwd(),
        staged: params.staged,
      });
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Not captured: ${error instanceof Error ? error.message : "unable to read git worktree"}`,
          },
        ],
      };
    }

    if (!worktree.diff.trim()) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No ${params.staged ? "staged" : "unstaged"} git diff found in ${worktree.cwd}`,
          },
        ],
      };
    }

    const reduced = reduceGitDiffToMemory({
      diff: worktree.diff,
      summary: params.summary,
      files: worktree.files,
      session_id: params.session_id,
      cwd: worktree.cwd,
      agent: getDetectedAgent(),
    });

    const result = await savePluginMemory(db, config, reduced);

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

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Saved ${params.staged ? "staged" : "worktree"} git diff as observation #${result.observation_id} ` +
            `(${reduced.type}: ${reduced.title})`,
        },
      ],
    };
  }
);

// Tool: capture_repo_scan
server.tool(
  "capture_repo_scan",
  "Run a lightweight repository scan and save reduced findings as durable memory. Best for quick architecture, risk, or implementation scans.",
  {
    cwd: z.string().optional().describe("Repo path to scan. Defaults to the current working directory."),
    focus: z.array(z.string()).optional().describe("Optional topics to bias the scan toward, for example 'billing', 'auth', or 'validation'."),
    max_findings: z.number().optional().describe("Maximum findings to keep before reduction."),
    summary: z.string().optional().describe("Optional human summary for the saved memory."),
    session_id: z.string().optional().describe("Optional session ID to link this scan to active work."),
  },
  async (params) => {
    let scan;
    try {
      scan = captureRepoScan({
        cwd: params.cwd ?? process.cwd(),
        focus: params.focus,
        max_findings: params.max_findings,
      });
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Not captured: ${error instanceof Error ? error.message : "unable to scan repository"}`,
          },
        ],
      };
    }

    if (scan.findings.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No lightweight repo-scan findings found in ${scan.cwd}`,
          },
        ],
      };
    }

    const reduced = reduceRepoScanToMemory({
      summary: params.summary,
      findings: scan.findings,
      session_id: params.session_id,
      cwd: scan.cwd,
      agent: getDetectedAgent(),
    });

    const result = await savePluginMemory(db, config, reduced);
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

    const findingSummary = scan.findings
      .slice(0, 3)
      .map((finding) => finding.title)
      .join("; ");

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Saved repo scan as observation #${result.observation_id} ` +
            `(${reduced.type}: ${reduced.title})` +
            `${findingSummary ? `\nFindings: ${findingSummary}` : ""}`,
        },
      ],
    };
  }
);

// Tool: capture_openclaw_content
server.tool(
  "capture_openclaw_content",
  "Capture OpenClaw content, research, and follow-up work as durable memory. Best for preserving posted outcomes, discoveries, and next actions.",
  {
    title: z.string().optional().describe("Short content, campaign, or research title."),
    posted: z.array(z.string()).optional().describe("Concrete posted items or shipped content outcomes."),
    researched: z.array(z.string()).optional().describe("Research or discovery items worth retaining."),
    outcomes: z.array(z.string()).optional().describe("Meaningful outcomes from the run."),
    next_actions: z.array(z.string()).optional().describe("Real follow-up actions that remain."),
    links: z.array(z.string()).optional().describe("Thread or source URLs tied to the work."),
    session_id: z.string().optional().describe("Optional session ID to link this memory to active work."),
    cwd: z.string().optional().describe("Optional project path for attribution."),
  },
  async (params) => {
    const reduced = reduceOpenClawContentToMemory({
      ...params,
      cwd: params.cwd ?? process.cwd(),
      agent: getDetectedAgent(),
    });

    const result = await savePluginMemory(db, config, reduced);
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

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Saved OpenClaw content memory as observation #${result.observation_id} ` +
            `(${reduced.type}: ${reduced.title})`,
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

    const includeProjectColumn = result.observations.some((obs) => obs.project_name);
    const header = includeProjectColumn
      ? "| ID | Type | Q | Title | Project | Created |"
      : "| ID | Type | Q | Title | Created |";
    const separator = includeProjectColumn
      ? "|---|---|---|---|---|---|"
      : "|---|---|---|---|---|";
    const rows = result.observations.map((obs) => {
      const qualityDots = qualityIndicator(obs.quality);
      const date = obs.created_at.split("T")[0];
      if (includeProjectColumn) {
        return `| ${obs.id} | ${obs.type} | ${qualityDots} | ${obs.title} | ${obs.project_name ?? "-"} | ${date} |`;
      }
      return `| ${obs.id} | ${obs.type} | ${qualityDots} | ${obs.title} | ${date} |`;
    });

    const previews = result.observations
      .slice(0, Math.min(3, result.observations.length))
      .map((obs) => {
        const preview = formatFactPreview(obs.facts, obs.narrative);
        const projectSuffix = obs.project_name ? ` [${obs.project_name}]` : "";
        return preview
          ? `- #${obs.id} [${obs.type}] ${obs.title}${projectSuffix}: ${preview}`
          : `- #${obs.id} [${obs.type}] ${obs.title}${projectSuffix}`;
      });

    const projectLine = result.project
      ? `Project: ${result.project}\n`
      : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Found ${result.total} result(s):\n\n${header}\n${separator}\n${rows.join("\n")}\n\nTop context:\n${previews.join("\n")}`,
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
    const promptSection = result.session_prompts && result.session_prompts.length > 0
      ? `\n\nSession requests:\n${result.session_prompts
          .map((prompt) => `- #${prompt.prompt_number} ${prompt.prompt.replace(/\s+/g, " ").trim()}`)
          .join("\n")}`
      : "";
    const toolSection = result.session_tool_events && result.session_tool_events.length > 0
      ? `\n\nSession tools:\n${result.session_tool_events
          .slice(-8)
          .map((tool) => {
            const detail = tool.file_path ?? tool.command ?? tool.tool_response_preview ?? "";
            return `- ${tool.tool_name}${detail ? ` — ${detail}` : ""}`;
          })
          .join("\n")}`
      : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Timeline around #${params.anchor}:\n\n${lines.join("\n")}${promptSection}${toolSection}`,
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
    const recentRequests = stats.recent_requests.length > 0
      ? stats.recent_requests.map((item) => `- ${item}`).join("\n")
      : "- (none)";
    const recentLessons = stats.recent_lessons.length > 0
      ? stats.recent_lessons.map((item) => `- ${item}`).join("\n")
      : "- (none)";
    const recentCompleted = stats.recent_completed.length > 0
      ? stats.recent_completed.map((item) => `- ${item}`).join("\n")
      : "- (none)";
    const nextSteps = stats.next_steps.length > 0
      ? stats.next_steps.map((item) => `- ${item}`).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Active observations: ${stats.active_observations}\n` +
            `User prompts: ${stats.user_prompts}\n` +
            `Tool events: ${stats.tool_events}\n` +
            `Messages: ${stats.messages}\n` +
            `Session summaries: ${stats.session_summaries}\n` +
            `Summary coverage: learned ${stats.summaries_with_learned}, completed ${stats.summaries_with_completed}, next steps ${stats.summaries_with_next_steps}\n` +
            `Installed packs: ${packs}\n` +
            `Outbox: pending ${stats.outbox.pending ?? 0}, failed ${stats.outbox.failed ?? 0}, synced ${stats.outbox.synced ?? 0}\n\n` +
            `Recent requests:\n${recentRequests}\n\n` +
            `Recent lessons:\n${recentLessons}\n\n` +
            `Recent completed:\n${recentCompleted}\n\n` +
            `Next steps:\n${nextSteps}`,
        },
      ],
    };
  }
);

// Tool: memory_console
server.tool(
  "memory_console",
  "Show a high-signal local overview of what Engrm currently knows about this project",
  {
    cwd: z.string().optional(),
    project_scoped: z.boolean().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getMemoryConsole(db, {
      ...params,
      cwd: params.cwd ?? process.cwd(),
      user_id: params.user_id ?? config.user_id,
    });

    const sessionLines = result.sessions.length > 0
      ? result.sessions.map((session) => {
          const label = session.request ?? session.completed ?? "(no summary)";
          return `- ${session.session_id} :: ${label.replace(/\s+/g, " ").trim()}`;
        }).join("\n")
      : "- (none)";

    const requestLines = result.requests.length > 0
      ? result.requests.map((prompt) => `- #${prompt.prompt_number} ${prompt.prompt.replace(/\s+/g, " ").trim()}`).join("\n")
      : "- (none)";

    const toolLines = result.tools.length > 0
      ? result.tools.map((tool) => {
          const detail = tool.file_path ?? tool.command ?? tool.tool_response_preview ?? "";
          return `- ${tool.tool_name}${detail ? ` — ${detail}` : ""}`;
        }).join("\n")
      : "- (none)";

    const observationLines = result.observations.length > 0
      ? result.observations.map((obs) => {
          const provenance: string[] = [];
          if (obs.source_tool) provenance.push(`via ${obs.source_tool}`);
          if (typeof obs.source_prompt_number === "number") provenance.push(`#${obs.source_prompt_number}`);
          return `- #${obs.id} [${obs.type}] ${obs.title}${provenance.length ? ` (${provenance.join(" · ")})` : ""}`;
        }).join("\n")
      : "- (none)";
    const provenanceLines = result.provenance_summary.length > 0
      ? result.provenance_summary.map((item) => `- ${item.tool}: ${item.count}`).join("\n")
      : "- (none)";
    const provenanceMixLines = result.provenance_type_mix.length > 0
      ? result.provenance_type_mix
          .map((item) => `- ${item.tool}: ${item.top_types.map((entry) => `${entry.type} ${entry.count}`).join(", ")}`)
          .join("\n")
      : "- (none)";
    const checkpointTypeLines = result.assistant_checkpoint_types.length > 0
      ? result.assistant_checkpoint_types.map((item) => `- ${item.type}: ${item.count}`).join("\n")
      : "- (none)";
    const topTypes = result.top_types.length > 0
      ? result.top_types.map((item) => `- ${item.type}: ${item.count}`).join("\n")
      : "- (none)";

    const projectLine = result.project ? `Project: ${result.project}\n\n` : "";
    const captureLine = result.capture_mode === "rich"
      ? `Raw chronology: active (${result.requests.length} requests, ${result.tools.length} tools)\n\n`
      : "Raw chronology: observations-only so far (prompt/tool hooks have not produced local history here yet)\n\n";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${projectLine}` +
            `${captureLine}` +
            `${typeof result.assistant_checkpoint_count === "number" ? `Assistant checkpoints: ${result.assistant_checkpoint_count}\n` : ""}` +
            `${typeof result.estimated_read_tokens === "number" ? `Estimated read cost: ~${result.estimated_read_tokens}t\n` : ""}` +
            `Suggested tools: ${result.suggested_tools.join(", ") || "(none)"}\n\n` +
            `Top types:\n${topTypes}\n\n` +
            `Assistant checkpoint types:\n${checkpointTypeLines}\n\n` +
            `Observation provenance:\n${provenanceLines}\n\n` +
            `Recent sessions:\n${sessionLines}\n\n` +
            `Recent requests:\n${requestLines}\n\n` +
            `Recent tools:\n${toolLines}\n\n` +
            `Recent observations:\n${observationLines}`,
        },
      ],
    };
  }
);

// Tool: capture_status
server.tool(
  "capture_status",
  "Show whether Engrm hook registration and recent prompt/tool chronology capture are actually active on this machine",
  {
    lookback_hours: z.number().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getCaptureStatus(db, {
      lookback_hours: params.lookback_hours,
      user_id: params.user_id ?? config.user_id,
    });

    const latestPrompt = result.latest_prompt_epoch
      ? new Date(result.latest_prompt_epoch * 1000).toISOString()
      : "none";
    const latestTool = result.latest_tool_event_epoch
      ? new Date(result.latest_tool_event_epoch * 1000).toISOString()
      : "none";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Schema: v${result.schema_version} (${result.schema_current ? "current" : "outdated"})\n` +
            `Claude MCP: ${result.claude_mcp_registered ? "registered" : "missing"}\n` +
            `Claude hooks: ${result.claude_hooks_registered ? `registered (${result.claude_hook_count})` : "missing"}\n` +
            `Claude raw chronology hooks: session-start=${result.claude_session_start_hook ? "yes" : "no"}, prompt=${result.claude_user_prompt_hook ? "yes" : "no"}, post-tool=${result.claude_post_tool_hook ? "yes" : "no"}, stop=${result.claude_stop_hook ? "yes" : "no"}\n` +
            `Codex MCP: ${result.codex_mcp_registered ? "registered" : "missing"}\n` +
            `Codex hooks: ${result.codex_hooks_registered ? "registered" : "missing"}\n` +
            `Codex raw chronology: ${result.codex_raw_chronology_supported ? "supported" : "not yet supported (start/stop only)"}\n\n` +
            `Recent user prompts: ${result.recent_user_prompts}\n` +
            `Recent tool events: ${result.recent_tool_events}\n` +
            `Recent sessions with raw chronology: ${result.recent_sessions_with_raw_capture}\n` +
            `Recent sessions with partial chronology: ${result.recent_sessions_with_partial_capture}\n` +
            `Raw chronology active: ${result.raw_capture_active ? "yes" : "no"}\n` +
            `Latest prompt: ${latestPrompt}\n` +
            `Latest tool event: ${latestTool}\n` +
            `Latest PostToolUse hook: ${formatEpoch(result.latest_post_tool_hook_epoch)}\n` +
            `Last PostToolUse parse: ${result.latest_post_tool_parse_status ?? "unknown"}\n` +
            `Last PostToolUse tool: ${result.latest_post_tool_name ?? "unknown"}`,
        },
      ],
    };
  }
);

// Tool: capture_quality
server.tool(
  "capture_quality",
  "Show how healthy Engrm capture is across the workspace: raw chronology coverage, checkpoints, and provenance by tool.",
  {
    limit: z.number().optional().describe("Maximum projects to include in the top-projects section."),
    user_id: z.string().optional().describe("Optional user override; defaults to the configured user."),
  },
  async (params) => {
    const result = getCaptureQuality(db, {
      limit: params.limit,
      user_id: params.user_id ?? config.user_id,
    });

    const provenanceLines = result.provenance_summary.length > 0
      ? result.provenance_summary.map((item) => `- ${item.tool}: ${item.count}`).join("\n")
      : "- (none)";
    const checkpointTypeLines = result.assistant_checkpoint_types.length > 0
      ? result.assistant_checkpoint_types.map((item) => `- ${item.type}: ${item.count}`).join("\n")
      : "- (none)";
    const projectLines = result.top_projects.length > 0
      ? result.top_projects.map((project) =>
          `- ${project.name} [${project.raw_capture_state}] obs=${project.observation_count} sessions=${project.session_count} prompts=${project.prompt_count} tools=${project.tool_event_count} checkpoints=${project.assistant_checkpoint_count}`
        ).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Workspace totals: projects=${result.totals.projects}, observations=${result.totals.observations}, sessions=${result.totals.sessions}, prompts=${result.totals.prompts}, tools=${result.totals.tool_events}, checkpoints=${result.totals.assistant_checkpoints}\n\n` +
            `Session capture states: rich=${result.session_states.rich}, partial=${result.session_states.partial}, summary-only=${result.session_states.summary_only}, legacy=${result.session_states.legacy}\n\n` +
            `Projects with raw capture: ${result.projects_with_raw_capture}\n\n` +
            `Assistant checkpoints by type:\n${checkpointTypeLines}\n\n` +
            `Observation provenance:\n${provenanceLines}\n\n` +
            `Provenance type mix:\n${provenanceMixLines}\n\n` +
            `Top projects:\n${projectLines}`,
        },
      ],
    };
  }
);

// Tool: tool_memory_index
server.tool(
  "tool_memory_index",
  "Show which tools are actually producing durable memory, which plugins they exercise, and what memory types they create.",
  {
    cwd: z.string().optional().describe("Project path to inspect. Defaults to the current working directory."),
    project_scoped: z.boolean().optional().describe("If true, limit results to the current project instead of the whole workspace."),
    limit: z.number().optional().describe("Maximum tools to include."),
    user_id: z.string().optional().describe("Optional user override; defaults to the configured user."),
  },
  async (params) => {
    const result = getToolMemoryIndex(db, {
      cwd: params.cwd ?? process.cwd(),
      project_scoped: params.project_scoped,
      limit: params.limit,
      user_id: params.user_id ?? config.user_id,
    });

    const toolLines = result.tools.length > 0
      ? result.tools.map((tool) => {
          const typeMix = tool.top_types.map((item) => `${item.type} ${item.count}`).join(", ");
          const pluginMix = tool.top_plugins.length > 0
            ? ` plugins=[${tool.top_plugins.map((item) => `${item.plugin} ${item.count}`).join(", ")}]`
            : "";
          const sample = tool.sample_titles[0] ? ` sample="${tool.sample_titles[0]}"` : "";
          const promptInfo = typeof tool.latest_prompt_number === "number" ? ` latest_prompt=#${tool.latest_prompt_number}` : "";
          return `- ${tool.tool}: obs=${tool.observation_count} sessions=${tool.session_count}${promptInfo} types=[${typeMix}]${pluginMix}${sample}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${result.project ? `Project: ${result.project}\n\n` : ""}` +
            `Tools producing durable memory:\n${toolLines}`,
        },
      ],
    };
  }
);

// Tool: session_tool_memory
server.tool(
  "session_tool_memory",
  "Show which tools in one session produced durable memory and which tools produced none",
  {
    session_id: z.string().describe("Session ID to inspect"),
  },
  async (params) => {
    const result = getSessionToolMemory(db, params);

    const toolLines = result.tools.length > 0
      ? result.tools.map((tool) => {
          const typeMix = tool.top_types.map((item) => `${item.type} ${item.count}`).join(", ");
          const pluginMix = tool.top_plugins.length > 0
            ? ` plugins=[${tool.top_plugins.map((item) => `${item.plugin} ${item.count}`).join(", ")}]`
            : "";
          const sample = tool.sample_titles[0] ? ` sample="${tool.sample_titles[0]}"` : "";
          const promptInfo = typeof tool.latest_prompt_number === "number" ? ` latest_prompt=#${tool.latest_prompt_number}` : "";
          return `- ${tool.tool}: events=${tool.tool_event_count} observations=${tool.observation_count}${promptInfo} types=[${typeMix}]${pluginMix}${sample}`;
        }).join("\n")
      : "- (none)";

    const unmappedLines = result.tools_without_memory.length > 0
      ? result.tools_without_memory.map((tool) => `- ${tool.tool}: events=${tool.tool_event_count}`).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Session: ${result.session_id}\n\n` +
            `Tools producing durable memory:\n${toolLines}\n\n` +
            `Tools without durable memory:\n${unmappedLines}`,
        },
      ],
    };
  }
);

// Tool: session_context
server.tool(
  "session_context",
  "Preview the exact project memory context Engrm would inject at session start",
  {
    cwd: z.string().optional(),
    token_budget: z.number().optional(),
    scope: z.enum(["personal", "team", "all"]).optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getSessionContext(db, {
      cwd: params.cwd ?? process.cwd(),
      token_budget: params.token_budget,
      scope: params.scope,
      user_id: params.user_id ?? config.user_id,
    });

    if (!result) {
      return {
        content: [{ type: "text" as const, text: "No session context available." }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Project: ${result.project_name}\n` +
            `Canonical ID: ${result.canonical_id}\n` +
            `Loaded observations: ${result.session_count}\n` +
            `Searchable total: ${result.total_active}\n` +
            `Recent requests: ${result.recent_requests}\n` +
            `Recent tools: ${result.recent_tools}\n` +
            `Recent sessions: ${result.recent_sessions}\n` +
            `Raw chronology active: ${result.raw_capture_active ? "yes" : "no"}\n\n` +
            result.preview,
        },
      ],
    };
  }
);

// Tool: activity_feed
server.tool(
  "activity_feed",
  "Show one chronological local feed across prompts, tools, observations, and summaries",
  {
    limit: z.number().optional(),
    project_scoped: z.boolean().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getActivityFeed(db, {
      ...params,
      cwd: params.cwd ?? process.cwd(),
      user_id: params.user_id ?? config.user_id,
    });

    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const rows = result.events.length > 0
      ? result.events.map((event) => {
          const stamp = new Date(event.created_at_epoch * 1000).toISOString().replace("T", " ").slice(0, 16);
          const kind = event.kind === "observation" && event.observation_type
            ? `${event.kind}:${event.observation_type}`
            : event.kind;
          return `- ${stamp} [${kind}] ${event.title}${event.detail ? ` — ${event.detail}` : ""}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Activity feed:\n${rows}`,
        },
      ],
    };
  }
);

// Tool: project_memory_index
server.tool(
  "project_memory_index",
  "Show a typed local memory index for the current project",
  {
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getProjectMemoryIndex(db, {
      cwd: params.cwd ?? process.cwd(),
      user_id: params.user_id ?? config.user_id,
    });

    if (!result) {
      return {
        content: [{ type: "text" as const, text: "No project memory found for this folder yet." }],
      };
    }

    const counts = Object.entries(result.observation_counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, count]) => `- ${type}: ${count}`)
      .join("\n") || "- (none)";

    const sessions = result.recent_sessions.length > 0
      ? result.recent_sessions.map((session) => {
          const label = session.request ?? session.completed ?? "(no summary)";
          return `- ${session.session_id} :: ${label.replace(/\s+/g, " ").trim()}`;
        }).join("\n")
      : "- (none)";

    const hotFiles = result.hot_files.length > 0
      ? result.hot_files.map((file) => `- ${file.path} (${file.count})`).join("\n")
      : "- (none)";
    const provenance = result.provenance_summary.length > 0
      ? result.provenance_summary.map((item) => `- ${item.tool}: ${item.count}`).join("\n")
      : "- (none)";
    const topTypes = result.top_types.length > 0
      ? result.top_types.map((item) => `- ${item.type}: ${item.count}`).join("\n")
      : "- (none)";

    const topTitles = result.top_titles.length > 0
      ? result.top_titles.map((item) => `- #${item.id} [${item.type}] ${item.title}`).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Project: ${result.project}\n` +
            `Canonical ID: ${result.canonical_id}\n` +
            `Recent requests captured: ${result.recent_requests_count}\n` +
            `Recent tools captured: ${result.recent_tools_count}\n\n` +
            `Raw chronology: ${result.raw_capture_active ? "active" : "observations-only so far"}\n\n` +
            `Assistant checkpoints: ${result.assistant_checkpoint_count}\n` +
            `Estimated read cost: ~${result.estimated_read_tokens}t\n` +
            `Suggested tools: ${result.suggested_tools.join(", ") || "(none)"}\n\n` +
            `Observation counts:\n${counts}\n\n` +
            `Top types:\n${topTypes}\n\n` +
            `Recent sessions:\n${sessions}\n\n` +
            `Hot files:\n${hotFiles}\n\n` +
            `Observation provenance:\n${provenance}\n\n` +
            `Recent memory objects:\n${topTitles}`,
        },
      ],
    };
  }
);

// Tool: project_related_work
server.tool(
  "project_related_work",
  "Show work that looks relevant to the current repo but is currently stored under other projects",
  {
    cwd: z.string().optional(),
    user_id: z.string().optional(),
    limit: z.number().optional(),
  },
  async (params) => {
    const result = getProjectRelatedWork(db, {
      cwd: params.cwd ?? process.cwd(),
      user_id: params.user_id ?? config.user_id,
      limit: params.limit,
    });

    const rows = result.related.length > 0
      ? result.related.map((item) =>
          `- #${item.id} [${item.type}] ${item.title} :: stored under ${item.source_project} (${item.matched_on})`
        ).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Project: ${result.project}\n` +
            `Canonical ID: ${result.canonical_id}\n\n` +
            `Related work stored under other projects:\n${rows}`,
        },
      ],
    };
  }
);

// Tool: reclassify_project_memory
server.tool(
  "reclassify_project_memory",
  "Move repo-relevant observations currently stored under other projects into the current git project",
  {
    cwd: z.string().optional(),
    user_id: z.string().optional(),
    limit: z.number().optional(),
    dry_run: z.boolean().optional(),
  },
  async (params) => {
    const result = reclassifyProjectMemory(db, {
      cwd: params.cwd ?? process.cwd(),
      user_id: params.user_id ?? config.user_id,
      limit: params.limit,
      dry_run: params.dry_run,
    });

    const rows = result.candidates.length > 0
      ? result.candidates.map((item) =>
          `- #${item.id} [${item.type}] ${item.title} :: from ${item.from} (${item.matched_on})${item.moved ? " -> moved" : ""}`
        ).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Project: ${result.project}\n` +
            `Canonical ID: ${result.canonical_id}\n` +
            `Dry run: ${params.dry_run === true ? "yes" : "no"}\n` +
            `Moved: ${result.moved}\n\n` +
            `Candidates:\n${rows}`,
        },
      ],
    };
  }
);

// Tool: workspace_memory_index
server.tool(
  "workspace_memory_index",
  "Show a cross-project local memory index for the whole Engrm workspace",
  {
    limit: z.number().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getWorkspaceMemoryIndex(db, {
      limit: params.limit,
      user_id: params.user_id ?? config.user_id,
    });

    const projectLines = result.projects.length > 0
      ? result.projects.map((project) => {
          const when = new Date(project.last_active_epoch * 1000).toISOString().split("T")[0];
          return `- ${project.name} (${when}) obs=${project.observation_count} sessions=${project.session_count} prompts=${project.prompt_count} tools=${project.tool_event_count} checkpoints=${project.assistant_checkpoint_count}`;
        }).join("\n")
      : "- (none)";
    const provenanceLines = result.provenance_summary.length > 0
      ? result.provenance_summary.map((item) => `- ${item.tool}: ${item.count}`).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Workspace totals: observations=${result.totals.observations}, sessions=${result.totals.sessions}, prompts=${result.totals.prompts}, tools=${result.totals.tool_events}, checkpoints=${result.totals.assistant_checkpoints}\n\n` +
            `Projects with raw chronology: ${result.projects_with_raw_capture}\n\n` +
            `Observation provenance:\n${provenanceLines}\n\n` +
            `Projects:\n${projectLines}`,
        },
      ],
    };
  }
);

// Tool: recent_requests
server.tool(
  "recent_requests",
  "Inspect recently captured raw user requests and prompt chronology",
  {
    limit: z.number().optional(),
    project_scoped: z.boolean().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getRecentRequests(db, params);
    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const rows = result.prompts.length > 0
      ? result.prompts.map((prompt) => {
          const stamp = new Date(prompt.created_at_epoch * 1000).toISOString().split("T")[0];
          return `- #${prompt.prompt_number} (${stamp}) ${prompt.prompt.replace(/\s+/g, " ").trim()}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Recent requests:\n${rows}`,
        },
      ],
    };
  }
);

// Tool: recent_tools
server.tool(
  "recent_tools",
  "Inspect recently captured raw tool chronology",
  {
    limit: z.number().optional(),
    project_scoped: z.boolean().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getRecentTools(db, params);
    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const rows = result.tool_events.length > 0
      ? result.tool_events.map((tool) => {
          const stamp = new Date(tool.created_at_epoch * 1000).toISOString().split("T")[0];
          const detail = tool.file_path ?? tool.command ?? tool.tool_response_preview ?? "";
          return `- ${stamp} ${tool.tool_name}${detail ? ` — ${detail}` : ""}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Recent tools:\n${rows}`,
        },
      ],
    };
  }
);

// Tool: recent_sessions
server.tool(
  "recent_sessions",
  "List the latest captured sessions so you can inspect one in detail",
  {
    limit: z.number().optional(),
    project_scoped: z.boolean().optional(),
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getRecentSessions(db, params);
    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const rows = result.sessions.length > 0
      ? result.sessions.map((session) => {
          const whenEpoch = session.completed_at_epoch ?? session.started_at_epoch ?? 0;
          const when = whenEpoch > 0
            ? new Date(whenEpoch * 1000).toISOString().split("T")[0]
            : "unknown";
          const summary = session.request ?? session.completed ?? "(no summary)";
          return `- ${session.session_id} (${when}) [${session.capture_state}] prompts=${session.prompt_count} tools=${session.tool_event_count} obs=${session.observation_count} :: ${summary.replace(/\s+/g, " ").trim()}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}Recent sessions:\n${rows}`,
        },
      ],
    };
  }
);

// Tool: session_story
server.tool(
  "session_story",
  "Show the full local memory story for one session",
  {
    session_id: z.string().describe("Session ID to inspect"),
  },
  async (params) => {
    const result = getSessionStory(db, params);
    if (!result.session) {
      return {
        content: [{ type: "text" as const, text: `Session ${params.session_id} not found` }],
      };
    }

    const summaryLines = result.summary
      ? [
          result.summary.request ? `Request: ${result.summary.request}` : null,
          result.summary.investigated ? `Investigated: ${result.summary.investigated}` : null,
          result.summary.learned ? `Learned: ${result.summary.learned}` : null,
          result.summary.completed ? `Completed: ${result.summary.completed}` : null,
          result.summary.next_steps ? `Next steps: ${result.summary.next_steps}` : null,
        ].filter(Boolean).join("\n")
      : "(none)";

    const promptLines = result.prompts.length > 0
      ? result.prompts.map((prompt) => `- #${prompt.prompt_number} ${prompt.prompt.replace(/\s+/g, " ").trim()}`).join("\n")
      : "- (none)";

    const toolLines = result.tool_events.length > 0
      ? result.tool_events.slice(-15).map((tool) => {
          const detail = tool.file_path ?? tool.command ?? tool.tool_response_preview ?? "";
          return `- ${tool.tool_name}${detail ? ` — ${detail}` : ""}`;
        }).join("\n")
      : "- (none)";

    const observationLines = result.observations.length > 0
      ? result.observations.slice(-15).map((obs) => {
          const provenance: string[] = [];
          if (obs.source_tool) provenance.push(`via ${obs.source_tool}`);
          if (typeof obs.source_prompt_number === "number") provenance.push(`#${obs.source_prompt_number}`);
          return `- #${obs.id} [${obs.type}] ${obs.title}${provenance.length ? ` (${provenance.join(" · ")})` : ""}`;
        }).join("\n")
      : "- (none)";

    const metrics = result.metrics
      ? `files=${result.metrics.files_touched_count}, searches=${result.metrics.searches_performed}, tools=${result.metrics.tool_calls_count}, observations=${result.metrics.observation_count}`
      : "metrics unavailable";
    const captureGaps = result.capture_gaps.length > 0
      ? result.capture_gaps.map((gap) => `- ${gap}`).join("\n")
      : "- none";
    const provenanceSummary = result.provenance_summary.length > 0
      ? result.provenance_summary.map((item) => `- ${item.tool}: ${item.count}`).join("\n")
      : "- none";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Session: ${result.session.session_id}\n` +
            `Status: ${result.session.status}\n` +
            `Capture: ${result.capture_state}\n` +
            `Metrics: ${metrics}\n\n` +
            `Summary:\n${summaryLines}\n\n` +
            `Prompts:\n${promptLines}\n\n` +
            `Tools:\n${toolLines}\n\n` +
            `Provenance:\n${provenanceSummary}\n\n` +
            `Capture gaps:\n${captureGaps}\n\n` +
            `Observations:\n${observationLines}`,
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

// Tool: load_session_context
server.tool(
  "load_session_context",
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

function formatFactPreview(factsRaw: string | null, narrative: string | null): string | null {
  if (factsRaw) {
    try {
      const parsed = JSON.parse(factsRaw);
      if (Array.isArray(parsed)) {
        const facts = parsed
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 2);
        if (facts.length > 0) {
          return facts.join("; ");
        }
      }
    } catch {
      const trimmedFacts = factsRaw.trim();
      if (trimmedFacts.length > 0) {
        return trimmedFacts.length > 160 ? `${trimmedFacts.slice(0, 157)}...` : trimmedFacts;
      }
    }
  }

  if (!narrative) return null;
  const trimmed = narrative.trim().replace(/\s+/g, " ");
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
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
