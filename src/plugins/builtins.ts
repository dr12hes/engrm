import type { EngrmPluginManifest } from "./types.js";

export const BUILTIN_PLUGIN_MANIFESTS: EngrmPluginManifest[] = [
  {
    id: "engrm.git-diff",
    name: "Git Diff",
    version: "0.1.0",
    kind: "source",
    connectors: ["git", "cli"],
    produces: ["bugfix", "feature", "change", "refactor", "decision"],
    surfaces: ["startup", "briefs", "delivery_review", "insights"],
    project_scopes: ["project", "repo", "branch"],
    capabilities: ["diff_scan", "commit_reduction", "risky_edit_detection"],
    sensitivity: {
      default_mode: "local_first",
      can_redact: true,
      supports_sync: true,
    },
  },
  {
    id: "engrm.repo-scan",
    name: "Repo Scan",
    version: "0.1.0",
    kind: "source",
    connectors: ["cli", "filesystem"],
    produces: ["discovery", "bugfix", "pattern", "change", "decision"],
    surfaces: ["startup", "briefs", "sentinel", "insights"],
    project_scopes: ["project", "repo"],
    capabilities: ["structure_scan", "risk_finding", "config_analysis"],
    sensitivity: {
      default_mode: "local_first",
      can_redact: true,
      supports_sync: true,
    },
  },
  {
    id: "engrm.openclaw-content",
    name: "OpenClaw Content",
    version: "0.1.0",
    kind: "workflow",
    connectors: ["mcp", "cli", "hook"],
    produces: ["change", "decision", "discovery", "message"],
    surfaces: ["briefs", "startup", "insights"],
    project_scopes: ["project", "campaign"],
    capabilities: ["thread_summary", "content_outcomes", "research_notes"],
    sensitivity: {
      default_mode: "shared_first",
      can_redact: true,
      supports_sync: true,
    },
  },
];

