/**
 * Auto-register Engrm MCP server + hooks in Claude Code config.
 *
 * - MCP server → ~/.claude.json (mcpServers.engrm)
 * - Hooks → ~/.claude/settings.json (hooks.SessionStart, UserPromptSubmit, PostToolUse, ElicitationResult, Stop)
 *
 * Merges into existing config — never overwrites other servers or hooks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- Paths ---

const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const CODEX_HOOKS = join(homedir(), ".codex", "hooks.json");
const OPENCODE_CONFIG = join(homedir(), ".config", "opencode", "opencode.json");
const OPENCODE_PLUGIN = join(homedir(), ".config", "opencode", "plugins", "engrm.js");
const LEGACY_CODEX_SERVER_NAME = `candengo-${"mem"}`;

/**
 * Detect whether we're running from source (dev, Bun) or from dist/ (npm, Node.js).
 */
function isBuiltDist(): boolean {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // Built dist/ puts this file in dist/ (flat), source puts it in src/
  return thisDir.endsWith("/dist") || thisDir.endsWith("\\dist");
}

/**
 * Resolve the runtime command ("node" for dist, "bun" for source dev).
 */
function findRuntime(): string {
  if (isBuiltDist()) {
    return process.execPath; // Node.js binary that's running us
  }

  // Dev mode: prefer bun
  const candidates = [
    join(homedir(), ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  if (process.execPath && process.execPath.endsWith("bun")) {
    return process.execPath;
  }
  return "bun";
}

/**
 * Resolve the package root directory.
 * Works both in dev (running from src/) and when installed via npx (from dist/).
 */
function findPackageRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..");
}

// --- JSON helpers ---

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt or empty file — start fresh
  }
  return {};
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// --- MCP registration ---

export function registerMcpServer(): { path: string; added: boolean } {
  const runtime = findRuntime();
  const root = findPackageRoot();
  const dist = isBuiltDist();

  const serverPath = dist
    ? join(root, "dist", "server.js")
    : join(root, "src", "server.ts");

  const config = readJsonFile(CLAUDE_JSON);
  const servers = (config["mcpServers"] ?? {}) as Record<string, unknown>;

  servers["engrm"] = {
    type: "stdio",
    command: runtime,
    args: dist ? [serverPath] : ["run", serverPath],
  };

  config["mcpServers"] = servers;
  writeJsonFile(CLAUDE_JSON, config);

  return { path: CLAUDE_JSON, added: true };
}

/**
 * Merge an Engrm MCP server entry into Codex's TOML config.
 * Replaces both the current "engrm" block and the legacy pre-Engrm block.
 */
export function upsertCodexMcpServerConfig(
  existing: string,
  entry: { name: string; command: string; args: string[] }
): string {
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const targetHeaders = new Set([
    `[mcp_servers.${entry.name}]`,
    `[mcp_servers.${LEGACY_CODEX_SERVER_NAME}]`,
  ]);
  const output: string[] = [];
  let skipping = false;
  let inFeatures = false;
  let featuresInserted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      if (inFeatures && !featuresInserted) {
        output.push(`codex_hooks = true`);
        featuresInserted = true;
      }
      skipping = targetHeaders.has(trimmed);
      inFeatures = trimmed === "[features]";
      if (!skipping) output.push(line);
      continue;
    }

    if (!skipping) {
      if (inFeatures && trimmed.startsWith("codex_hooks")) {
        if (!featuresInserted) {
          output.push(`codex_hooks = true`);
          featuresInserted = true;
        }
        continue;
      }
      output.push(line);
    }
  }

  if (inFeatures && !featuresInserted) {
    output.push(`codex_hooks = true`);
    featuresInserted = true;
  }

  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }

  if (output.length > 0) {
    output.push("");
  }

  output.push(`[mcp_servers.${entry.name}]`);
  output.push(`enabled = true`);
  output.push(`command = "${escapeTomlString(entry.command)}"`);
  output.push(
    `args = [${entry.args.map((arg) => `"${escapeTomlString(arg)}"`).join(", ")}]`
  );
  output.push(`startup_timeout_sec = 15`);
  output.push(`tool_timeout_sec = 30`);
  output.push("");

  if (!featuresInserted) {
    output.push(`[features]`);
    output.push(`codex_hooks = true`);
    output.push("");
  }

  return output.join("\n");
}

export function registerCodexMcpServer(): { path: string; added: boolean } {
  const runtime = findRuntime();
  const root = findPackageRoot();
  const dist = isBuiltDist();
  const serverPath = dist
    ? join(root, "dist", "server.js")
    : join(root, "src", "server.ts");
  const args = dist ? [serverPath] : ["run", serverPath];

  const existing = existsSync(CODEX_CONFIG)
    ? readFileSync(CODEX_CONFIG, "utf-8")
    : "";
  const updated = upsertCodexMcpServerConfig(existing, {
    name: "engrm",
    command: runtime,
    args,
  });

  ensureParentDir(CODEX_CONFIG);
  writeFileSync(CODEX_CONFIG, updated, "utf-8");
  return { path: CODEX_CONFIG, added: true };
}

export function buildCodexHooksConfig(
  sessionStartCommand: string,
  stopCommand: string
): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: sessionStartCommand,
              statusMessage: "loading Engrm context",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: stopCommand,
              statusMessage: "saving Engrm session summary",
            },
          ],
        },
      ],
    },
  }, null, 2) + "\n";
}

export function registerCodexHooks(): { path: string; added: boolean } {
  const runtime = findRuntime();
  const root = findPackageRoot();
  const dist = isBuiltDist();
  const hooksDir = dist ? join(root, "dist", "hooks") : join(root, "hooks");
  const ext = dist ? ".js" : ".ts";
  const runArg = dist ? [] : ["run"];

  const commandFor = (name: string): string =>
    [runtime, ...runArg, join(hooksDir, `${name}${ext}`)].join(" ");

  const content = buildCodexHooksConfig(
    commandFor("session-start"),
    commandFor("codex-stop")
  );
  ensureParentDir(CODEX_HOOKS);
  writeFileSync(CODEX_HOOKS, content, "utf-8");
  return { path: CODEX_HOOKS, added: true };
}

export function registerOpenCode(): { path: string; added: boolean; pluginPath: string } {
  const root = findPackageRoot();
  const pluginSource = join(root, "opencode", "plugin", "engrm-opencode.js");
  const config = readJsonFile(OPENCODE_CONFIG);
  const mcp = (config["mcp"] ?? {}) as Record<string, unknown>;

  mcp["engrm"] = {
    type: "local",
    command: ["engrm", "serve"],
    enabled: true,
    timeout: 5000,
  };

  config["$schema"] = "https://opencode.ai/config.json";
  config["mcp"] = mcp;
  writeJsonFile(OPENCODE_CONFIG, config);

  ensureParentDir(OPENCODE_PLUGIN);
  if (existsSync(pluginSource)) {
    copyFileSync(pluginSource, OPENCODE_PLUGIN);
  }

  return { path: OPENCODE_CONFIG, added: true, pluginPath: OPENCODE_PLUGIN };
}

// --- Hooks registration ---

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

export function registerHooks(): { path: string; added: boolean } {
  const runtime = findRuntime();
  const root = findPackageRoot();
  const dist = isBuiltDist();

  // Use dist/ .js files when installed via npm, src/ .ts when running in dev
  const hooksDir = dist ? join(root, "dist", "hooks") : join(root, "hooks");
  const ext = dist ? ".js" : ".ts";
  const runArg = dist ? [] : ["run"];

  function hookCmd(name: string): string {
    return [runtime, ...runArg, join(hooksDir, `${name}${ext}`)].join(" ");
  }

  const sessionStartCmd = hookCmd("session-start");
  const userPromptSubmitCmd = hookCmd("user-prompt-submit");
  const preCompactCmd = hookCmd("pre-compact");
  const preToolUseCmd = hookCmd("sentinel");
  const postToolUseCmd = hookCmd("post-tool-use");
  const elicitationResultCmd = hookCmd("elicitation-result");
  const stopCmd = hookCmd("stop");

  const settings = readJsonFile(CLAUDE_SETTINGS);
  const hooks = (settings["hooks"] ?? {}) as Record<string, HookEntry[]>;

  // Replace any existing engrm hooks, preserve others
  hooks["SessionStart"] = replaceEngrmHook(
    hooks["SessionStart"],
    { hooks: [{ type: "command", command: sessionStartCmd }] },
    "session-start"
  );

  hooks["UserPromptSubmit"] = replaceEngrmHook(
    hooks["UserPromptSubmit"],
    { hooks: [{ type: "command", command: userPromptSubmitCmd }] },
    "user-prompt-submit"
  );

  hooks["PreCompact"] = replaceEngrmHook(
    hooks["PreCompact"],
    { hooks: [{ type: "command", command: preCompactCmd }] },
    "pre-compact"
  );

  hooks["PreToolUse"] = replaceEngrmHook(
    hooks["PreToolUse"],
    {
      matcher: "Edit|Write",
      hooks: [{ type: "command", command: preToolUseCmd }],
    },
    "sentinel"
  );

  hooks["PostToolUse"] = replaceEngrmHook(
    hooks["PostToolUse"],
    {
      matcher: "Edit|Write|Bash|Read|Grep|Glob|WebSearch|WebFetch|mcp__.*",
      hooks: [{ type: "command", command: postToolUseCmd }],
    },
    "post-tool-use"
  );

  hooks["ElicitationResult"] = replaceEngrmHook(
    hooks["ElicitationResult"],
    {
      hooks: [{ type: "command", command: elicitationResultCmd }],
    },
    "elicitation-result"
  );

  hooks["Stop"] = replaceEngrmHook(
    hooks["Stop"],
    { hooks: [{ type: "command", command: stopCmd }] },
    "stop"
  );

  settings["hooks"] = hooks;
  writeJsonFile(CLAUDE_SETTINGS, settings);

  return { path: CLAUDE_SETTINGS, added: true };
}

/**
 * Replace any existing engrm hook entry in the array, or append.
 * Identifies engrm hooks by checking if the command contains our hook filename.
 */
function replaceEngrmHook(
  existing: HookEntry[] | undefined,
  newEntry: HookEntry,
  hookFilename: string
): HookEntry[] {
  if (!existing || !Array.isArray(existing)) return [newEntry];

  const isEngrmHook = (entry: HookEntry): boolean =>
    entry.hooks?.some(
      (h) =>
        h.command?.includes("engrm") || h.command?.includes(hookFilename)
    ) ?? false;

  // Remove old engrm entries, add new one
  const others = existing.filter((e) => !isEngrmHook(e));
  return [...others, newEntry];
}

/**
 * Register both MCP server and hooks. Returns summary for CLI output.
 */
export function registerAll(): {
  mcp: { path: string; added: boolean };
  hooks: { path: string; added: boolean };
  codex: { path: string; added: boolean };
  codexHooks: { path: string; added: boolean };
  opencode: { path: string; added: boolean; pluginPath: string };
} {
  let mcp = { path: CLAUDE_JSON, added: false };
  let hooks = { path: CLAUDE_SETTINGS, added: false };
  let codex = { path: CODEX_CONFIG, added: false };
  let codexHooks = { path: CODEX_HOOKS, added: false };
  let opencode = { path: OPENCODE_CONFIG, added: false, pluginPath: OPENCODE_PLUGIN };

  try {
    mcp = registerMcpServer();
  } catch {
    // Best-effort per integration
  }

  try {
    hooks = registerHooks();
  } catch {
    // Best-effort per integration
  }

  try {
    codex = registerCodexMcpServer();
  } catch {
    // Best-effort per integration
  }

  try {
    codexHooks = registerCodexHooks();
  } catch {
    // Best-effort per integration
  }

  try {
    opencode = registerOpenCode();
  } catch {
    // Best-effort per integration
  }

  return {
    mcp,
    hooks,
    codex,
    codexHooks,
    opencode,
  };
}
