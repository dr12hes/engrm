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
import { searchRecall } from "./tools/search-recall.js";
import { getObservations } from "./tools/get.js";
import { getTimeline } from "./tools/timeline.js";
import { pinObservation } from "./tools/pin.js";
import { getRecentActivity } from "./tools/recent.js";
import { getRecentRequests } from "./tools/recent-prompts.js";
import { getChatCaptureOrigin, getRecentChat } from "./tools/recent-chat.js";
import { searchChat } from "./tools/search-chat.js";
import { createHandoff, formatHandoffSource, getRecentHandoffs, isDraftHandoff, loadHandoff, upsertRollingHandoff } from "./tools/handoffs.js";
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
import { listRecallItems } from "./tools/list-recall-items.js";
import { loadRecallItem } from "./tools/load-recall-item.js";
import { captureGitWorktree } from "./tools/capture-git-worktree.js";
import { captureRepoScan } from "./tools/capture-repo-scan.js";
import { repairRecall } from "./tools/repair-recall.js";
import { resumeThread } from "./tools/resume-thread.js";
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
import { syncTranscriptChat } from "./capture/transcript.js";

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
  version: "0.4.32",
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

server.tool(
  "search_recall",
  "Search live recall across durable memory and chat together. Best for questions like 'what were we just talking about?'",
  {
    query: z.string().describe("Recall query"),
    project_scoped: z.boolean().optional().describe("Scope to project (default: true)"),
    limit: z.number().optional().describe("Max results (default: 10)"),
    cwd: z.string().optional().describe("Optional cwd override for project-scoped recall"),
    user_id: z.string().optional().describe("Optional user override"),
  },
  async (params) => {
    const result = await searchRecall(db, {
      query: params.query,
      project_scoped: params.project_scoped,
      limit: params.limit,
      cwd: params.cwd,
      user_id: params.user_id ?? config.user_id,
    });

    if (result.results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: result.project
              ? `No recall found for "${params.query}" in project ${result.project}`
              : `No recall found for "${params.query}"`,
          },
        ],
      };
    }

    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const summaryLine = `Matches: ${result.results.length} · memory ${result.totals.memory} · chat ${result.totals.chat}\n`;
    const rows = result.results
      .map((item) => {
        const sourceBits: string[] = [item.kind];
        if (item.type) sourceBits.push(item.type);
        if (item.role) sourceBits.push(item.role);
        if (item.source_kind) sourceBits.push(item.source_kind);
        const idBit = item.observation_id
          ? `#${item.observation_id}`
          : item.id
            ? `chat:${item.id}`
            : "";
        const title = `${idBit ? `${idBit} ` : ""}${item.title}${item.project_name ? ` (${item.project_name})` : ""}`;
        return `- [${sourceBits.join(" · ")}] ${title}\n  ${item.detail.slice(0, 220)}`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}${summaryLine}Recall search for "${params.query}":\n${rows}`,
        },
      ],
    };
  }
);

server.tool(
  "list_recall_items",
  "USE FIRST when continuity feels fuzzy. List the best current handoffs, session threads, chat snippets, and memory entries before opening one exact item.",
  {
    cwd: z.string().optional().describe("Optional cwd override for project-scoped recall"),
    project_scoped: z.boolean().optional().describe("Scope to project (default: true)"),
    user_id: z.string().optional().describe("Optional user override"),
    limit: z.number().optional().describe("Max recall items to list"),
  },
  async (params) => {
    const result = listRecallItems(db, {
      cwd: params.cwd ?? process.cwd(),
      project_scoped: params.project_scoped,
      user_id: params.user_id ?? config.user_id,
      current_device_id: config.device_id,
      limit: params.limit,
    });

    if (result.items.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: result.project
              ? `No recall items found yet for project ${result.project}`
              : "No recall items found yet.",
          },
        ],
      };
    }

    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const rows = result.items.map((item) =>
      `- ${item.key} [${item.kind} · ${item.freshness}] ${item.title}${item.source_device_id ? ` (${item.source_device_id})` : ""}\n  ${item.detail}`
    ).join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${projectLine}Recall index (${result.continuity_mode} mode):\n` +
            `${rows}\n\n` +
            `Suggested next step: use load_handoff for handoff:* items, get_observations([...]) for obs:* items, or resume_thread when you want one merged resume point.`,
        },
      ],
    };
  }
);

server.tool(
  "load_recall_item",
  "USE AFTER list_recall_items. Load one exact recall item key so you can inspect a specific handoff, thread, chat message, or memory entry without fuzzy recall guessing.",
  {
    key: z.string().describe("Exact recall key from list_recall_items, such as handoff:12, session:sess-1, chat:55, or obs:402"),
    cwd: z.string().optional().describe("Optional cwd override"),
    user_id: z.string().optional().describe("Optional user override"),
  },
  async (params) => {
    const result = loadRecallItem(db, {
      key: params.key,
      cwd: params.cwd ?? process.cwd(),
      user_id: params.user_id ?? config.user_id,
      current_device_id: config.device_id,
    });

    if (!result.payload) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No recall item found for ${params.key}`,
          },
        ],
      };
    }

    if (result.payload.type === "handoff") {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Recall item ${result.key} [handoff]\n` +
              `Title: ${result.title}\n` +
              `Session: ${result.session_id ?? "(unknown)"}\n` +
              `Source: ${result.source_device_id ?? "(unknown)"}\n\n` +
              `${result.payload.narrative ?? "(no narrative)"}`,
          },
        ],
      };
    }

    if (result.payload.type === "thread") {
      const outcomes = result.payload.recent_outcomes.length > 0
        ? result.payload.recent_outcomes.map((item) => `- ${item}`).join("\n")
        : "- (none)";
      const hotFiles = result.payload.hot_files.length > 0
        ? result.payload.hot_files.map((item) => `- ${item.path}${item.count > 1 ? ` (${item.count})` : ""}`).join("\n")
        : "- (none)";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Recall item ${result.key} [thread]\n` +
              `Title: ${result.title}\n` +
              `Session: ${result.session_id ?? "(unknown)"}\n` +
              `Source: ${result.source_device_id ?? "(unknown)"}\n` +
              `Latest request: ${result.payload.latest_request ?? "(none)"}\n` +
              `Current thread: ${result.payload.current_thread ?? "(none)"}\n\n` +
              `Recent outcomes:\n${outcomes}\n\n` +
              `Hot files:\n${hotFiles}`,
          },
        ],
      };
    }

    if (result.payload.type === "chat") {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Recall item ${result.key} [chat]\n` +
              `Title: ${result.title}\n` +
              `Session: ${result.session_id ?? "(unknown)"}\n` +
              `Source: ${result.source_device_id ?? "(unknown)"}\n\n` +
              `${result.payload.content}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Recall item ${result.key} [memory]\n` +
            `Title: ${result.title}\n` +
            `Session: ${result.session_id ?? "(unknown)"}\n` +
            `Source: ${result.source_device_id ?? "(unknown)"}\n` +
            `Type: ${result.payload.observation_type}\n\n` +
            `${result.payload.narrative ?? result.payload.facts ?? "(no detail)"}`,
        },
      ],
    };
  }
);

server.tool(
  "resume_thread",
  "USE FIRST when you want one direct 'where were we?' answer. Build a clear resume point for the current project by combining handoff, live recall, current thread, and recent chat continuity.",
  {
    cwd: z.string().optional().describe("Optional cwd override for the project to resume"),
    limit: z.number().optional().describe("Max recall hits/chat snippets to include"),
    user_id: z.string().optional().describe("Optional user override"),
    repair_if_needed: z.boolean().optional().describe("If true, attempt recall repair before resuming when continuity is still weak"),
  },
  async (params) => {
    const result = await resumeThread(db, config, {
      cwd: params.cwd ?? process.cwd(),
      limit: params.limit,
      user_id: params.user_id ?? config.user_id,
      current_device_id: config.device_id,
      repair_if_needed: params.repair_if_needed,
    });

    const projectLine = result.project_name ? `Project: ${result.project_name}\n` : "";
    const handoffLine = result.handoff
      ? `Handoff: #${result.handoff.id} ${result.handoff.title}${result.handoff.source ? ` (${result.handoff.source})` : ""}\n`
      : "Handoff: (none)\n";
    const openExactLine = result.best_recall_key
      ? `Open exact: load_recall_item("${result.best_recall_key}")${result.best_recall_title ? `  # ${result.best_recall_title}` : ""}\n`
      : "";
    const basisLines = result.resume_basis.length > 0
      ? result.resume_basis.map((item) => `- ${item}`).join("\n")
      : "- (none)";
    const toolTrailLines = result.tool_trail.length > 0
      ? result.tool_trail.map((item) => `- ${item}`).join("\n")
      : "- (none)";
    const hotFileLines = result.hot_files.length > 0
      ? result.hot_files.map((item) => `- ${item.path}${item.count > 1 ? ` (${item.count})` : ""}`).join("\n")
      : "- (none)";
    const nextActionLines = result.next_actions.length > 0
      ? result.next_actions.map((item) => `- ${item}`).join("\n")
      : "- (none)";
    const repairLine = result.repair_attempted
      ? `Recall repair: attempted${result.repair_result ? ` · imported ${result.repair_result.imported_chat_messages} chat across ${result.repair_result.sessions_with_imports} session(s)` : ""}\n`
      : "";
    const outcomes = result.recent_outcomes.length > 0
      ? result.recent_outcomes.map((item) => `- ${item}`).join("\n")
      : "- (none)";
    const chatLines = result.recent_chat.length > 0
      ? result.recent_chat.map((item) => `- [${item.role}] [${item.source}] ${item.content.slice(0, 180)}`).join("\n")
      : "- (none)";
    const recallLines = result.recall_hits.length > 0
      ? result.recall_hits.map((item) => {
          const bits = [item.kind];
          if (item.role) bits.push(item.role);
          if (item.source_kind) bits.push(item.source_kind);
          if (item.type) bits.push(item.type);
          return `- [${bits.join(" · ")}] ${item.title}\n  ${item.detail.slice(0, 200)}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${projectLine}` +
            `Continuity: ${result.continuity_state} — ${result.continuity_summary}\n` +
            `Freshness: ${result.resume_freshness}\n` +
            `Source: ${result.resume_source_session_id ?? "(unknown session)"}${result.resume_source_device_id ? ` (${result.resume_source_device_id})` : ""}\n` +
            `Resume confidence: ${result.resume_confidence}\n` +
            repairLine +
            openExactLine +
            `Current thread: ${result.current_thread ?? "(unknown)"}\n` +
            `Latest request: ${result.latest_request ?? "(none)"}\n` +
            `${handoffLine}` +
            `Chat recall: ${result.chat_coverage_state}\n` +
            `Suggested tools: ${result.suggested_tools.join(", ") || "(none)"}\n\n` +
            `Resume basis:\n${basisLines}\n\n` +
            `Tool trail:\n${toolTrailLines}\n\n` +
            `Hot files:\n${hotFileLines}\n\n` +
            `Next actions:\n${nextActionLines}\n\n` +
            `Recent outcomes:\n${outcomes}\n\n` +
            `Recent chat:\n${chatLines}\n\n` +
            `Recall hits:\n${recallLines}`,
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
    const handoffLines = result.recent_handoffs.length > 0
      ? result.recent_handoffs.map((obs) => `- #${obs.id} ${obs.title}`).join("\n")
      : "- (none)";
    const recentChatLines = result.recent_chat.length > 0
      ? result.recent_chat.map((msg) => `- [${msg.role}] ${msg.content.replace(/\s+/g, " ").trim().slice(0, 180)}`).join("\n")
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
    const recallPreviewLines = result.recall_index_preview.length > 0
      ? result.recall_index_preview.map((item) => `- ${item.key} [${item.kind} · ${item.freshness}] ${item.title}`).join("\n")
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
            `Continuity: ${result.continuity_state} — ${result.continuity_summary}\n` +
            `Recall index: ${result.recall_mode} · ${result.recall_items_ready} items ready\n` +
            `Resume readiness: ${result.resume_freshness} · ${result.resume_source_session_id ?? "(unknown session)"}${result.resume_source_device_id ? ` (${result.resume_source_device_id})` : ""}\n` +
            `Chat recall: ${result.chat_coverage_state} · ${result.recent_chat.length} messages across ${result.recent_chat_sessions} sessions (transcript ${result.chat_source_summary.transcript}, history ${result.chat_source_summary.history}, hook ${result.chat_source_summary.hook})\n` +
            `${typeof result.assistant_checkpoint_count === "number" ? `Assistant checkpoints: ${result.assistant_checkpoint_count}\n` : ""}` +
            `Handoffs: ${result.saved_handoffs} saved, ${result.rolling_handoff_drafts} rolling drafts\n` +
            `${typeof result.estimated_read_tokens === "number" ? `Estimated read cost: ~${result.estimated_read_tokens}t\n` : ""}` +
            `Suggested tools: ${result.suggested_tools.join(", ") || "(none)"}\n\n` +
            `Recall preview:\n${recallPreviewLines}\n\n` +
            `Next actions:\n${result.resume_next_actions.length > 0 ? result.resume_next_actions.map((item) => `- ${item}`).join("\n") : "- (none)"}\n\n` +
            `Top types:\n${topTypes}\n\n` +
            `Assistant checkpoint types:\n${checkpointTypeLines}\n\n` +
            `Observation provenance:\n${provenanceLines}\n\n` +
            `Recent sessions:\n${sessionLines}\n\n` +
            `Recent handoffs:\n${handoffLines}\n\n` +
            `Recent requests:\n${requestLines}\n\n` +
            `Recent tools:\n${toolLines}\n\n` +
            `Recent chat:\n${recentChatLines}\n\n` +
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
          `- ${project.name} [${project.raw_capture_state}] obs=${project.observation_count} sessions=${project.session_count} prompts=${project.prompt_count} tools=${project.tool_event_count} checkpoints=${project.assistant_checkpoint_count} chat=${project.chat_message_count} (${project.chat_coverage_state})`
        ).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Workspace totals: projects=${result.totals.projects}, observations=${result.totals.observations}, sessions=${result.totals.sessions}, prompts=${result.totals.prompts}, tools=${result.totals.tool_events}, checkpoints=${result.totals.assistant_checkpoints}, chat=${result.totals.chat_messages}\n\n` +
            `Session capture states: rich=${result.session_states.rich}, partial=${result.session_states.partial}, summary-only=${result.session_states.summary_only}, legacy=${result.session_states.legacy}\n\n` +
            `Chat recall coverage: transcript-backed sessions=${result.chat_coverage.transcript_backed_sessions}, history-backed sessions=${result.chat_coverage.history_backed_sessions}, hook-only sessions=${result.chat_coverage.hook_only_sessions}\n\n` +
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
      current_device_id: config.device_id,
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
            `Continuity: ${result.continuity_state} — ${result.continuity_summary}\n` +
            `Recall index: ${result.recall_mode} · ${result.recall_items_ready} items ready\n` +
            `Resume readiness: ${result.resume_freshness} · ${result.resume_source_session_id ?? "(unknown session)"}${result.resume_source_device_id ? ` (${result.resume_source_device_id})` : ""}\n` +
            `Loaded observations: ${result.session_count}\n` +
            `Searchable total: ${result.total_active}\n` +
            `Recent requests: ${result.recent_requests}\n` +
            `Recent tools: ${result.recent_tools}\n` +
            `Recent sessions: ${result.recent_sessions}\n` +
            `Recent handoffs: ${result.recent_handoffs}\n` +
            `Handoff split: ${result.saved_handoffs} saved, ${result.rolling_handoff_drafts} rolling drafts\n` +
            `Recent chat messages: ${result.recent_chat_messages}\n` +
            `Chat recall: ${result.chat_coverage_state} · ${result.recent_chat_sessions} sessions (transcript ${result.chat_source_summary.transcript}, history ${result.chat_source_summary.history}, hook ${result.chat_source_summary.hook})\n` +
            `Latest handoff: ${result.latest_handoff_title ?? "(none)" }\n` +
            `Next actions: ${result.resume_next_actions.length > 0 ? result.resume_next_actions.join(" | ") : "(none)"}\n` +
            `Recall preview: ${result.recall_index_preview.length > 0 ? result.recall_index_preview.map((item) => item.key).join(", ") : "(none)"}\n` +
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
  "Show one chronological local feed across prompts, tools, chat, observations, handoffs, and summaries",
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
          const kind = event.kind === "handoff" && event.handoff_kind
            ? `${event.kind}:${event.handoff_kind}`
            : event.kind === "observation" && event.observation_type
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
    const recallPreviewLines = result.recall_index_preview.length > 0
      ? result.recall_index_preview.map((item) => `- ${item.key} [${item.kind} · ${item.freshness}] ${item.title}`).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Project: ${result.project}\n` +
            `Canonical ID: ${result.canonical_id}\n` +
            `Continuity: ${result.continuity_state} — ${result.continuity_summary}\n` +
            `Recall index: ${result.recall_mode} · ${result.recall_items_ready} items ready\n` +
            `Resume readiness: ${result.resume_freshness} · ${result.resume_source_session_id ?? "(unknown session)"}${result.resume_source_device_id ? ` (${result.resume_source_device_id})` : ""}\n` +
            `Recent requests captured: ${result.recent_requests_count}\n` +
            `Recent tools captured: ${result.recent_tools_count}\n\n` +
            `Recent handoffs captured: ${result.recent_handoffs_count}\n` +
            `Handoff split: ${result.saved_handoffs_count} saved, ${result.rolling_handoff_drafts_count} rolling drafts\n` +
            `Recent chat messages captured: ${result.recent_chat_count}\n` +
            `Chat recall: ${result.chat_coverage_state} · ${result.recent_chat_sessions} sessions (transcript ${result.chat_source_summary.transcript}, history ${result.chat_source_summary.history}, hook ${result.chat_source_summary.hook})\n\n` +
            `Raw chronology: ${result.raw_capture_active ? "active" : "observations-only so far"}\n\n` +
            `Assistant checkpoints: ${result.assistant_checkpoint_count}\n` +
            `Estimated read cost: ~${result.estimated_read_tokens}t\n` +
            `Suggested tools: ${result.suggested_tools.join(", ") || "(none)"}\n\n` +
            `Recall preview:\n${recallPreviewLines}\n\n` +
            `Next actions:\n${result.resume_next_actions.length > 0 ? result.resume_next_actions.map((item) => `- ${item}`).join("\n") : "- (none)"}\n\n` +
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
  "create_handoff",
  "Capture an explicit cross-device handoff from the current or specified session into syncable memory",
  {
    session_id: z.string().optional().describe("Optional session ID to hand off; defaults to the latest recent session"),
    cwd: z.string().optional().describe("Repo path used to scope the handoff when no session ID is provided"),
    title: z.string().optional().describe("Optional short handoff title"),
    include_chat: z.boolean().optional().describe("Include a few recent chat snippets in the handoff"),
    chat_limit: z.number().optional().describe("How many recent chat snippets to include when include_chat is true"),
  },
  async (params) => {
    const result = await createHandoff(db, config, params);
    if (!result.success) {
      return {
        content: [{ type: "text" as const, text: `Handoff not created: ${result.reason}` }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Created handoff #${result.observation_id} for session ${result.session_id}\nTitle: ${result.title}`,
        },
      ],
    };
  }
);

server.tool(
  "refresh_handoff",
  "Refresh the rolling live handoff draft for the current or specified session without creating a new saved handoff",
  {
    session_id: z.string().optional().describe("Optional session ID to refresh; defaults to the latest recent session"),
    cwd: z.string().optional().describe("Repo path used to scope the rolling handoff when no session ID is provided"),
    include_chat: z.boolean().optional().describe("Include a few recent chat snippets in the rolling handoff draft"),
    chat_limit: z.number().optional().describe("How many recent chat snippets to include when include_chat is true"),
  },
  async (params) => {
    const result = await upsertRollingHandoff(db, config, params);
    if (!result.success) {
      return {
        content: [{ type: "text" as const, text: `Rolling handoff not refreshed: ${result.reason}` }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Rolling handoff draft #${result.observation_id} refreshed for session ${result.session_id}\nTitle: ${result.title}`,
        },
      ],
    };
  }
);

server.tool(
  "refresh_chat_recall",
  "Hydrate the separate chat lane from the current Claude transcript so long sessions keep their full user/assistant thread",
  {
    session_id: z.string().optional().describe("Optional session ID; defaults to the current session when called from hooks or the active repo session when known"),
    cwd: z.string().optional().describe("Project directory used to resolve the Claude transcript path"),
    transcript_path: z.string().optional().describe("Optional explicit Claude transcript JSONL path"),
  },
  async (params) => {
    const cwd = params.cwd ?? process.cwd();
    const sessionId = params.session_id
      ?? db.getRecentSessions(null, 1, config.user_id)[0]?.session_id
      ?? null;
    if (!sessionId) {
      return {
        content: [{ type: "text" as const, text: "No session available to hydrate chat recall from." }],
      };
    }

    const result = await syncTranscriptChat(db, config, sessionId, cwd, params.transcript_path);
    return {
      content: [
        {
          type: "text" as const,
          text: `Chat recall refreshed for session ${sessionId}\nImported: ${result.imported}\nTranscript messages seen: ${result.total}`,
        },
      ],
    };
  }
);

server.tool(
  "repair_recall",
  "USE WHEN recall feels thin or under-captured. Rehydrate recent session recall for the current project from Claude transcripts or history fallback before resuming.",
  {
    session_id: z.string().optional().describe("Optional single session ID to repair instead of scanning recent project sessions"),
    cwd: z.string().optional().describe("Project directory used to resolve project sessions and Claude history/transcript files"),
    limit: z.number().optional().describe("How many recent sessions to inspect when repairing a project"),
    user_id: z.string().optional().describe("Optional user override; defaults to the configured user"),
    transcript_path: z.string().optional().describe("Optional explicit transcript JSONL path when repairing a single session"),
  },
  async (params) => {
    const result = await repairRecall(db, config, {
      session_id: params.session_id,
      cwd: params.cwd ?? process.cwd(),
      limit: params.limit,
      user_id: params.user_id ?? config.user_id,
      transcript_path: params.transcript_path,
    });

    const projectLine = result.project_name ? `Project: ${result.project_name}\n` : "";
    const rows = result.results.length > 0
      ? result.results.map((session) =>
          `- ${session.session_id} [${session.chat_coverage_state}] imported=${session.imported_chat_messages} chat=${session.chat_messages_after} prompts=${session.prompt_count_after} ` +
          `(transcript ${session.chat_source_summary.transcript} · history ${session.chat_source_summary.history} · hook ${session.chat_source_summary.hook})`
        ).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${projectLine}` +
            `Scope: ${result.scope}\n` +
            `Inspected sessions: ${result.inspected_sessions}\n` +
            `Sessions with new recall: ${result.sessions_with_imports}\n` +
            `Imported chat messages: ${result.imported_chat_messages}\n\n` +
            `Repair results:\n${rows}`,
        },
      ],
    };
  }
);

server.tool(
  "recent_handoffs",
  "List recent saved handoffs and rolling handoff drafts so you can resume work on another device or in a new session",
  {
    limit: z.number().optional(),
    project_scoped: z.boolean().optional(),
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getRecentHandoffs(db, {
      ...params,
      user_id: params.user_id ?? config.user_id,
      current_device_id: config.device_id,
    });
    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const rows = result.handoffs.length > 0
      ? result.handoffs.map((handoff) => {
          const stamp = new Date(handoff.created_at_epoch * 1000).toISOString().replace("T", " ").slice(0, 16);
          const kind = isDraftHandoff(handoff) ? "draft" : "saved";
          return `- #${handoff.id} (${stamp}) [${kind}] ${handoff.title}${handoff.project_name ? ` [${handoff.project_name}]` : ""} (${formatHandoffSource(handoff)})`;
        }).join("\n")
      : "- (none)";

    return {
      content: [{ type: "text" as const, text: `${projectLine}Recent handoffs:\n${rows}` }],
    };
  }
);

server.tool(
  "load_handoff",
  "Open the best saved handoff or rolling draft and turn it back into a clear resume point for a new session",
  {
    id: z.number().optional().describe("Optional handoff observation ID; defaults to the latest recent handoff"),
    cwd: z.string().optional(),
    project_scoped: z.boolean().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = loadHandoff(db, {
      ...params,
      user_id: params.user_id ?? config.user_id,
      current_device_id: config.device_id,
    });
    if (!result.handoff) {
      return {
        content: [{ type: "text" as const, text: "No matching handoff found" }],
      };
    }

    const facts = result.handoff.facts
      ? (() => {
          try {
            const parsed = JSON.parse(result.handoff.facts);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
    const factLines = facts.length > 0 ? `\n\nFacts:\n${facts.map((fact) => `- ${fact}`).join("\n")}` : "";
    const projectLine = result.handoff.project_name ? `Project: ${result.handoff.project_name}\n` : "";
    const sourceLine = `Source: ${formatHandoffSource(result.handoff)}\n`;

    return {
      content: [
        {
          type: "text" as const,
          text:
            `${projectLine}Handoff #${result.handoff.id}\n` +
            sourceLine +
            `Title: ${result.handoff.title}\n\n` +
            `${result.handoff.narrative ?? "(no handoff narrative stored)"}${factLines}`,
        },
      ],
    };
  }
);

// Tool: recent_requests
server.tool(
  "recent_chat",
  "Inspect recently captured chat messages in the separate chat lane",
  {
    limit: z.number().optional(),
    project_scoped: z.boolean().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = getRecentChat(db, params);
    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const coverageLine =
      `Coverage: ${result.messages.length} messages across ${result.session_count} session${result.session_count === 1 ? "" : "s"} ` +
      `· transcript ${result.source_summary.transcript} · history ${result.source_summary.history} · hook ${result.source_summary.hook}\n` +
      `${result.transcript_backed ? "" : "Hint: run refresh_chat_recall for one session or repair_recall for recent project sessions if this looks under-captured.\n"}`;
    const rows = result.messages.length > 0
      ? result.messages.map((msg) => {
          const stamp = new Date(msg.created_at_epoch * 1000).toISOString().split("T")[0];
          return `- ${stamp} [${msg.role}] [${getChatCaptureOrigin(msg)}] ${msg.content.replace(/\s+/g, " ").trim().slice(0, 200)}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}${coverageLine}Recent chat:\n${rows}`,
        },
      ],
    };
  }
);

server.tool(
  "search_chat",
  "Search the separate chat lane without mixing it into durable memory observations",
  {
    query: z.string().describe("Text to search for in captured chat"),
    limit: z.number().optional(),
    project_scoped: z.boolean().optional(),
    cwd: z.string().optional(),
    user_id: z.string().optional(),
  },
  async (params) => {
    const result = await searchChat(db, params);
    const projectLine = result.project ? `Project: ${result.project}\n` : "";
    const coverageLine =
      `Coverage: ${result.messages.length} matches across ${result.session_count} session${result.session_count === 1 ? "" : "s"} ` +
      `· transcript ${result.source_summary.transcript} · history ${result.source_summary.history} · hook ${result.source_summary.hook}` +
      `${result.semantic_backed ? " · semantic yes" : ""}\n` +
      `${result.transcript_backed ? "" : "Hint: run refresh_chat_recall for one session or repair_recall for recent project sessions if this looks under-captured.\n"}`;
    const rows = result.messages.length > 0
      ? result.messages.map((msg) => {
          const stamp = new Date(msg.created_at_epoch * 1000).toISOString().split("T")[0];
          return `- ${stamp} [${msg.role}] [${getChatCaptureOrigin(msg)}] ${msg.content.replace(/\s+/g, " ").trim().slice(0, 200)}`;
        }).join("\n")
      : "- (none)";

    return {
      content: [
        {
          type: "text" as const,
          text: `${projectLine}${coverageLine}Chat search for "${params.query}":\n${rows}`,
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
    const chatLines = result.chat_messages.length > 0
      ? result.chat_messages.slice(-12).map((msg) => `- [${msg.role}] [${msg.source_kind}] ${msg.content.replace(/\s+/g, " ").trim().slice(0, 200)}`).join("\n")
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
    const handoffLines = result.handoffs.length > 0
      ? result.handoffs.slice(-8).map((obs) => {
          const kind = isDraftHandoff(obs) ? "draft" : "saved";
          return `- #${obs.id} [${kind}] ${obs.title}`;
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
            `Handoff split: ${result.saved_handoffs.length} saved, ${result.rolling_handoff_drafts.length} rolling drafts\n` +
            `Metrics: ${metrics}\n\n` +
            `Summary:\n${summaryLines}\n\n` +
            `Prompts:\n${promptLines}\n\n` +
            `Chat recall: ${result.chat_coverage_state} (transcript ${result.chat_source_summary.transcript}, history ${result.chat_source_summary.history}, hook ${result.chat_source_summary.hook})\n\n` +
            `Chat:\n${chatLines}\n\n` +
            `Tools:\n${toolLines}\n\n` +
            `Handoffs:\n${handoffLines}\n\n` +
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
        ? { maxCount: params.max_observations, userId: config.user_id, currentDeviceId: config.device_id }
        : { tokenBudget: 800, userId: config.user_id, currentDeviceId: config.device_id }
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
