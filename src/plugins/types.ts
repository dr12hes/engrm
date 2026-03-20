export const PLUGIN_SPEC_VERSION = "0.1" as const;

export const PLUGIN_KINDS = ["source", "memory", "workflow"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const PLUGIN_CONNECTORS = ["mcp", "cli", "api", "filesystem", "git", "hook"] as const;
export type PluginConnector = (typeof PLUGIN_CONNECTORS)[number];

export const PLUGIN_SURFACES = [
  "startup",
  "briefs",
  "sentinel",
  "delivery_review",
  "insights",
] as const;
export type PluginSurface = (typeof PLUGIN_SURFACES)[number];

export const OBSERVATION_TYPES = [
  "bugfix",
  "discovery",
  "decision",
  "pattern",
  "change",
  "feature",
  "refactor",
  "digest",
  "message",
] as const;
export type PluginObservationType = (typeof OBSERVATION_TYPES)[number];

export interface PluginSensitivityConfig {
  default_mode: "local_first" | "shared_first" | "explicit_opt_in";
  can_redact?: boolean;
  supports_sync?: boolean;
}

export interface EngrmPluginManifest {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  connectors: PluginConnector[];
  produces: PluginObservationType[];
  surfaces: PluginSurface[];
  project_scopes?: string[];
  capabilities?: string[];
  sensitivity?: PluginSensitivityConfig;
}

export interface PluginSourceRef {
  kind: "file" | "url" | "ticket" | "commit" | "thread" | "command" | "other";
  value: string;
}

export interface SavePluginMemoryInput {
  plugin_id: string;
  plugin_name?: string;
  type: PluginObservationType;
  title: string;
  summary?: string;
  facts?: string[];
  tags?: string[];
  source?: string;
  source_refs?: PluginSourceRef[];
  surfaces?: PluginSurface[];
  files_read?: string[];
  files_modified?: string[];
  sensitivity?: "shared" | "personal" | "secret";
  session_id?: string;
  cwd?: string;
  agent?: string;
}

