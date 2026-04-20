#!/usr/bin/env bun
/**
 * Engrm CLI.
 *
 * Commands:
 *   init                — Browser OAuth setup (default)
 *   init --token=cmt_x  — Setup from provisioning token
 *   init --no-browser   — Device code flow (headless/SSH)
 *   init --manual       — Interactive manual setup
 *   init --config <f>   — Non-interactive setup from a JSON file
 *   status              — Show current config and database stats
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { hostname, homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadConfig,
  saveConfig,
  configExists,
  getConfigDir,
  getSettingsPath,
  getDbPath,
  type Config,
} from "./config.js";
import { MemDatabase } from "./storage/sqlite.js";
import { classifyOutboxFailure, getOutboxFailureSummaries, getOutboxStats } from "./storage/outbox.js";
import { computeSessionValueSignals } from "./intelligence/value-signals.js";
import { getSchemaVersion, LATEST_SCHEMA_VERSION } from "./storage/migrations.js";
import {
  provision,
  ProvisionError,
  DEFAULT_CANDENGO_URL,
  type ProvisionResponse,
} from "./provisioning/provision.js";
import { runBrowserAuth } from "./provisioning/browser-auth.js";
import { registerAll } from "./register.js";
import { listPacks, installPack } from "./packs/loader.js";
import { listRulePacks, installRulePacks } from "./sentinel/rules.js";
import { getCaptureStatus } from "./tools/capture-status.js";
import { normalizeBaseUrl } from "./sync/auth.js";

const LEGACY_CODEX_SERVER_NAME = `candengo-${"mem"}`;

const args = process.argv.slice(2);
const command = args[0];
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const IS_BUILT_DIST = THIS_DIR.endsWith("/dist") || THIS_DIR.endsWith("\\dist");

switch (command) {
  case "init":
    await handleInit(args.slice(1));
    break;
  case "serve":
    await handleServe();
    break;
  case "status":
    handleStatus();
    break;
  case "update":
    handleUpdate();
    break;
  case "install-pack":
    await handleInstallPack(args.slice(1));
    break;
  case "packs":
    handleListPacks();
    break;
  case "sentinel":
    await handleSentinel(args.slice(1));
    break;
  case "doctor":
    await handleDoctor();
    break;
  default:
    printUsage();
    break;
}

// Ensure clean exit — some operations leave open handles (HTTP servers, DB connections)
process.exit(0);

// --- Init ---

async function handleInit(flags: string[]): Promise<void> {
  // --token=cmt_xxx or --token cmt_xxx
  const tokenFlag = flags.find((f) => f.startsWith("--token"));
  if (tokenFlag) {
    let token: string;
    if (tokenFlag.includes("=")) {
      token = tokenFlag.split("=")[1]!;
    } else {
      const idx = flags.indexOf("--token");
      token = flags[idx + 1] ?? "";
    }
    if (!token || !token.startsWith("cmt_")) {
      console.error("Error: --token requires a cmt_ provisioning token");
      process.exit(1);
    }
    const url = extractUrlFlag(flags) ?? DEFAULT_CANDENGO_URL;
    await initWithToken(url, token);
    await maybeInstallPack(flags);
    return;
  }

  // --config <path>
  if (flags.includes("--config")) {
    const configIndex = flags.indexOf("--config");
    const configPath = flags[configIndex + 1];
    if (!configPath) {
      console.error("Error: --config requires a file path");
      process.exit(1);
    }
    initFromFile(configPath);
    return;
  }

  // --manual
  if (flags.includes("--manual")) {
    await initManual();
    return;
  }

  // --no-browser (device code flow — placeholder for Phase 4.1b)
  if (flags.includes("--no-browser")) {
    console.error("Device code flow is not yet implemented.");
    console.error("Use: engrm init --token=cmt_xxx");
    process.exit(1);
  }

  // Default: browser OAuth flow
  const url = extractUrlFlag(flags) ?? DEFAULT_CANDENGO_URL;
  await initWithBrowser(url);

  // Install starter pack if specified
  await maybeInstallPack(flags);
}

async function handleServe(): Promise<void> {
  const packageRoot = join(THIS_DIR, "..");
  const serverPath = IS_BUILT_DIST
    ? join(packageRoot, "dist", "server.js")
    : join(packageRoot, "src", "server.ts");

  await import(pathToFileURL(serverPath).href);

  // src/server.ts bootstraps itself on import. Keep the CLI process alive so
  // local MCP clients like OpenCode can hold the stdio session open.
  await new Promise<never>(() => {});
}

/**
 * Install a starter pack if --pack flag is present.
 */
async function maybeInstallPack(flags: string[]): Promise<void> {
  const packFlag = flags.find((f) => f.startsWith("--pack"));
  if (!packFlag) return;

  let packName: string;
  if (packFlag.includes("=")) {
    packName = packFlag.split("=")[1]!;
  } else {
    const idx = flags.indexOf("--pack");
    packName = flags[idx + 1] ?? "";
  }

  if (!packName) {
    console.error("--pack requires a pack name. Available: " + listPacks().join(", "));
    return;
  }

  const config = loadConfig();
  const db = new MemDatabase(getDbPath());
  try {
    console.log(`\nInstalling starter pack: ${packName}...`);
    const result = await installPack(db, config, packName, process.cwd());
    console.log(`Loaded ${result.installed} observations from '${packName}' pack`);
  } catch (error) {
    console.error(`Pack install failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

/**
 * Extract --url flag value from flags array.
 */
function extractUrlFlag(flags: string[]): string | undefined {
  const urlFlag = flags.find((f) => f.startsWith("--url"));
  if (!urlFlag) return undefined;
  if (urlFlag.includes("=")) return urlFlag.split("=")[1];
  const idx = flags.indexOf("--url");
  return flags[idx + 1];
}

// --- Flow C: Provisioning token ---

async function initWithToken(baseUrl: string, token: string): Promise<void> {
  if (configExists()) {
    console.log("Existing configuration found. Overwriting...\n");
  }

  console.log("Exchanging provisioning token...");

  try {
    const result = await provision(baseUrl, {
      token,
      device_name: hostname(),
    });
    writeConfigFromProvision(baseUrl, result);
    console.log(`\nConnected as ${result.user_email}`);
    printPostInit();
    await checkDeviceLimits(baseUrl, result.api_key);
  } catch (error) {
    if (error instanceof ProvisionError) {
      console.error(`\nProvisioning failed: ${error.detail}`);
      process.exit(1);
    }
    throw error;
  }
}

// --- Flow A: Browser OAuth ---

async function initWithBrowser(baseUrl: string): Promise<void> {
  if (configExists()) {
    console.log("Existing configuration found. Overwriting...\n");
  }

  try {
    const { code } = await runBrowserAuth(baseUrl);

    console.log("Exchanging authorization code...");
    const result = await provision(baseUrl, {
      code,
      device_name: hostname(),
    });
    writeConfigFromProvision(baseUrl, result);
    console.log(`\nConnected as ${result.user_email}`);
    printPostInit();
    await checkDeviceLimits(baseUrl, result.api_key);
  } catch (error) {
    if (error instanceof ProvisionError) {
      console.error(`\nProvisioning failed: ${error.detail}`);
      process.exit(1);
    }
    console.error(
      `\nAuthorization failed: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error("Try: engrm init --token=cmt_xxx");
    process.exit(1);
  }
}

// --- Shared: write config from provision response ---

function writeConfigFromProvision(
  baseUrl: string,
  result: ProvisionResponse
): void {
  ensureConfigDir();

  // Preserve existing device_id and sentinel config on re-init
  let existingDeviceId: string | undefined;
  let existingSentinel: Config["sentinel"] | undefined;
  if (configExists()) {
    try {
      const existing = loadConfig();
      existingDeviceId = existing.device_id;
      existingSentinel = existing.sentinel;
    } catch { /* ignore */ }
  }

  const config: Config = {
    candengo_url: baseUrl,
    candengo_api_key: result.api_key,
    site_id: result.site_id,
    namespace: result.namespace,
    user_id: result.user_id,
    user_email: result.user_email,
    device_id: existingDeviceId || generateDeviceId(),
    teams: result.teams ?? [],
    sync: {
      enabled: true,
      interval_seconds: 30,
      batch_size: 50,
    },
    search: {
      default_limit: 10,
      local_boost: 1.2,
      scope: "all",
    },
    scrubbing: {
      enabled: true,
      custom_patterns: [],
      default_sensitivity: "shared",
    },
    sentinel: existingSentinel ?? {
      enabled: false,
      mode: "advisory",
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "",
      base_url: "",
      skip_patterns: [],
      daily_limit: 100,
      tier: "free",
    },
    observer: {
      enabled: true,
      mode: "per_event",
      model: "haiku",
    },
    transcript_analysis: {
      enabled: false,
    },
  };

  saveConfig(config);

  // Initialise database
  const db = new MemDatabase(getDbPath());
  db.close();

  console.log(`Configuration saved to ${getSettingsPath()}`);
  console.log(`Database initialised at ${getDbPath()}`);
}

// --- Flow D: Manual ---

function initFromFile(configPath: string): void {
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Invalid JSON in ${configPath}`);
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error("Config file must contain a JSON object");
    process.exit(1);
  }

  const input = parsed as Record<string, unknown>;

  const required = [
    "candengo_url",
    "candengo_api_key",
    "site_id",
    "namespace",
    "user_id",
  ];
  for (const field of required) {
    if (typeof input[field] !== "string" || !(input[field] as string).trim()) {
      console.error(`Missing required field: ${field}`);
      process.exit(1);
    }
  }

  ensureConfigDir();

  const config: Config = {
    candengo_url: (input["candengo_url"] as string).trim(),
    candengo_api_key: (input["candengo_api_key"] as string).trim(),
    site_id: (input["site_id"] as string).trim(),
    namespace: (input["namespace"] as string).trim(),
    user_id: (input["user_id"] as string).trim(),
    user_email:
      typeof input["user_email"] === "string"
        ? (input["user_email"] as string).trim()
        : "",
    device_id:
      typeof input["device_id"] === "string"
        ? input["device_id"]
        : generateDeviceId(),
    teams: [],
    sync: {
      enabled: true,
      interval_seconds: 30,
      batch_size: 50,
    },
    search: {
      default_limit: 10,
      local_boost: 1.2,
      scope: "all",
    },
    scrubbing: {
      enabled: true,
      custom_patterns: [],
      default_sensitivity: "shared",
    },
    sentinel: {
      enabled: false,
      mode: "advisory",
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "",
      base_url: "",
      skip_patterns: [],
      daily_limit: 100,
      tier: "free",
    },
    observer: {
      enabled: true,
      mode: "per_event",
      model: "haiku",
    },
    transcript_analysis: {
      enabled: false,
    },
  };

  saveConfig(config);

  const db = new MemDatabase(getDbPath());
  db.close();

  console.log(`Configuration saved to ${getSettingsPath()}`);
  console.log(`Database initialised at ${getDbPath()}`);
  printPostInit();
}

async function initManual(): Promise<void> {
  const prompt = createPrompter();

  console.log("Engrm — Interactive Setup\n");

  if (configExists()) {
    const overwrite = await prompt(
      "Config already exists. Overwrite? [y/N]: "
    );
    if (overwrite.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  const candengoUrl = await prompt(
    "Engrm server URL (e.g. https://engrm.dev): "
  );
  const apiKey = await prompt("API key (cvk_...): ");
  const siteId = await prompt("Site ID: ");
  const namespace = await prompt("Namespace: ");
  const userId = await prompt("User ID: ");
  const userEmail = await prompt("Email (optional): ");

  if (!candengoUrl || !apiKey || !siteId || !namespace || !userId) {
    console.error("All fields (except email) are required.");
    process.exit(1);
  }

  ensureConfigDir();

  const config: Config = {
    candengo_url: candengoUrl.trim(),
    candengo_api_key: apiKey.trim(),
    site_id: siteId.trim(),
    namespace: namespace.trim(),
    user_id: userId.trim(),
    user_email: userEmail.trim(),
    device_id: generateDeviceId(),
    teams: [],
    sync: {
      enabled: true,
      interval_seconds: 30,
      batch_size: 50,
    },
    search: {
      default_limit: 10,
      local_boost: 1.2,
      scope: "all",
    },
    scrubbing: {
      enabled: true,
      custom_patterns: [],
      default_sensitivity: "shared",
    },
    sentinel: {
      enabled: false,
      mode: "advisory",
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "",
      base_url: "",
      skip_patterns: [],
      daily_limit: 100,
      tier: "free",
    },
    observer: {
      enabled: true,
      mode: "per_event",
      model: "haiku",
    },
    transcript_analysis: {
      enabled: false,
    },
  };

  saveConfig(config);

  const db = new MemDatabase(getDbPath());
  db.close();

  console.log(`\nConfiguration saved to ${getSettingsPath()}`);
  console.log(`Database initialised at ${getDbPath()}`);
  printPostInit();
}

// --- Status ---

function handleStatus(): void {
  if (!configExists()) {
    console.log("Engrm is not configured.");
    console.log("Run: npx engrm init");
    return;
  }

  const config = loadConfig();

  // --- Account section ---
  console.log("Engrm Status\n");
  console.log("  Account");
  console.log(`    User:          ${config.user_id}`);
  if (config.user_email) {
    console.log(`    Email:         ${config.user_email}`);
  }
  console.log(`    Device:        ${config.device_id}`);
  if (config.teams.length > 0) {
    console.log(
      `    Teams:         ${config.teams.map((t) => t.name).join(", ")}`
    );
  }

  // Plan/tier display
  const tierLabels: Record<string, string> = {
    free: "Free",
    vibe: "Vibe ($9/mo)",
    solo: "Vibe ($9/mo)",
    pro: "Pro ($15/mo)",
    team: "Team",
    enterprise: "Enterprise",
  };
  const tier = config.sentinel?.tier ?? "free";
  console.log(`    Plan:          ${tierLabels[tier] ?? tier}`);

  // --- Integration section ---
  console.log("\n  Integration");
  console.log(`    Server:        ${config.candengo_url ? normalizeBaseUrl(config.candengo_url) : "(not set)"}`);
  console.log(`    Sync:          ${config.sync.enabled ? "enabled" : "disabled"}`);
  console.log(`    HTTP MCP:      ${config.http.enabled ? `enabled (:${config.http.port})` : "disabled"}`);
  console.log(`    HTTP tokens:   ${config.http.bearer_tokens.length}`);
  console.log(`    Tool profile:  ${config.tool_profile ?? "full"}`);
  console.log(`    Fleet project: ${config.fleet.project_name || "(not set)"}`);
  console.log(`    Fleet sync:    ${config.fleet.namespace && config.fleet.api_key ? "configured" : "not configured"}`);

  const claudeJson = join(homedir(), ".claude.json");
  const claudeSettings = join(homedir(), ".claude", "settings.json");
  const codexConfig = join(homedir(), ".codex", "config.toml");
  const codexHooks = join(homedir(), ".codex", "hooks.json");
  const openclawConfig = join(homedir(), ".openclaw", "openclaw.json");
  const openclawPlugin = join(homedir(), ".openclaw", "extensions", "engrm", "openclaw.plugin.json");
  const opencodeConfig = join(homedir(), ".config", "opencode", "opencode.json");
  const opencodePlugin = join(homedir(), ".config", "opencode", "plugins", "engrm.js");
  const mcpRegistered = existsSync(claudeJson) && readFileSync(claudeJson, "utf-8").includes('"engrm"');
  const settingsContent = existsSync(claudeSettings) ? readFileSync(claudeSettings, "utf-8") : "";
  const codexContent = existsSync(codexConfig) ? readFileSync(codexConfig, "utf-8") : "";
  const codexHooksContent = existsSync(codexHooks) ? readFileSync(codexHooks, "utf-8") : "";
  const openclawConfigContent = existsSync(openclawConfig) ? readFileSync(openclawConfig, "utf-8") : "";
  const opencodeConfigContent = existsSync(opencodeConfig) ? readFileSync(opencodeConfig, "utf-8") : "";
  const hooksRegistered =
    settingsContent.includes("engrm") ||
    settingsContent.includes("session-start") ||
    settingsContent.includes("user-prompt-submit");
  const codexRegistered =
    codexContent.includes("[mcp_servers.engrm]") ||
    codexContent.includes(`[mcp_servers.${LEGACY_CODEX_SERVER_NAME}]`);
  const codexHooksRegistered =
    codexHooksContent.includes("\"SessionStart\"") &&
    codexHooksContent.includes("\"Stop\"");
  const openclawMcpRegistered = hasOpenClawMcpRegistration(openclawConfigContent);
  const openclawPluginRegistered = existsSync(openclawPlugin);
  const opencodeRegistered = opencodeConfigContent.includes('"engrm"') && opencodeConfigContent.includes('"local"');
  const opencodePluginRegistered = existsSync(opencodePlugin);

  // Count registered hooks by parsing the settings JSON
  let hookCount = 0;
  if (hooksRegistered) {
    try {
      const settings = JSON.parse(settingsContent);
      const hooks = settings?.hooks ?? {};
      for (const entries of Object.values(hooks)) {
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const e = entry as { hooks?: { command?: string }[] };
            if (e.hooks?.some((h) => h.command?.includes("engrm") || h.command?.includes("session-start") || h.command?.includes("user-prompt-submit") || h.command?.includes("sentinel") || h.command?.includes("post-tool-use") || h.command?.includes("pre-compact") || h.command?.includes("stop") || h.command?.includes("elicitation"))) {
              hookCount++;
            }
          }
        }
      }
    } catch {
      // fall back to unknown count
    }
  }

  console.log(`    MCP server:    ${mcpRegistered ? "registered" : "not registered"}`);
  console.log(`    Codex MCP:     ${codexRegistered ? "registered" : "not registered"}`);
  console.log(`    OpenClaw MCP:  ${openclawMcpRegistered ? "registered" : "not registered"}`);
  console.log(`    OpenClaw plug: ${openclawPluginRegistered ? "registered" : "not registered"}`);
  console.log(`    OpenCode MCP:  ${opencodeRegistered ? "registered" : "not registered"}`);
  console.log(`    Hooks:         ${hooksRegistered ? `registered (${hookCount || "?"} hooks)` : "not registered"}`);
  console.log(`    Codex hooks:   ${codexHooksRegistered ? "registered (2 hooks)" : "not registered"}`);
  console.log(`    OpenCode plug: ${opencodePluginRegistered ? "registered" : "not registered"}`);

  // --- Sentinel section ---
  if (config.sentinel?.enabled) {
    console.log("\n  Sentinel");
    console.log(`    Mode:          ${config.sentinel.mode}`);
    console.log(`    Daily limit:   ${config.sentinel.daily_limit}`);
    if (config.sentinel.provider) {
      console.log(`    Provider:      ${config.sentinel.provider}${config.sentinel.model ? ` (${config.sentinel.model})` : ""}`);
    }
    if (existsSync(getDbPath())) {
      try {
        const db = new MemDatabase(getDbPath());
        const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        const todayAudits = db.db
          .query<{ count: number }, [number]>(
            "SELECT COUNT(*) as count FROM security_findings WHERE finding_type LIKE 'sentinel_%' AND created_at_epoch >= ?"
          )
          .get(todayStart)?.count ?? 0;
        console.log(`    Today:         ${todayAudits}/${config.sentinel.daily_limit} audits`);
        db.close();
      } catch {
        // security_findings may not exist
      }
    }
  } else {
    console.log("\n  Sentinel:        disabled");
  }

  // --- Database section ---
  if (existsSync(getDbPath())) {
    try {
      const db = new MemDatabase(getDbPath());
      const obsCount = db.getActiveObservationCount();
      const outbox = getOutboxStats(db);

      console.log("\n  Memory");
      console.log(`    Observations:  ${obsCount.toLocaleString()} active`);

      // Observation breakdown by type
      try {
        const byType = db.db
          .query<{ type: string; count: number }, []>(
            `SELECT type, COUNT(*) as count FROM observations
             WHERE lifecycle IN ('active', 'aging', 'pinned') AND superseded_by IS NULL
             GROUP BY type ORDER BY count DESC`
          )
          .all();
        if (byType.length > 0) {
          const typeParts = byType.map((t) => `${t.type}: ${t.count}`);
          console.log(`    By type:       ${typeParts.join(", ")}`);
        }
      } catch {
        // type breakdown may fail on old schemas
      }

      // Session summaries count
      const summaryCount = db.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM session_summaries"
        )
        .get()?.count ?? 0;
      console.log(`    Sessions:      ${summaryCount} summarised`);

      const capture = getCaptureStatus(db, { user_id: config.user_id });
      console.log(
        `    Raw capture:   ${capture.raw_capture_active ? "active" : "observations-only so far"}`
      );
      console.log(
        `    Prompts/tools: ${capture.recent_user_prompts}/${capture.recent_tool_events} in last 24h`
      );
      if (capture.recent_sessions_with_partial_capture > 0) {
        console.log(
          `    Partial raw:   ${capture.recent_sessions_with_partial_capture} recent session${capture.recent_sessions_with_partial_capture === 1 ? "" : "s"} missing some chronology`
        );
      }
      console.log(
        `    Hook state:    Claude ${capture.claude_user_prompt_hook && capture.claude_post_tool_hook ? "raw-ready" : "partial"}, Codex ${capture.codex_raw_chronology_supported ? "raw-ready" : "start/stop only"}`
      );
      if (capture.latest_post_tool_hook_epoch) {
        const lastSeen = new Date(capture.latest_post_tool_hook_epoch * 1000).toISOString();
        const parseStatus = capture.latest_post_tool_parse_status ?? "unknown";
        const toolName = capture.latest_post_tool_name ?? "unknown";
        console.log(`    PostToolUse:   ${parseStatus} (${toolName}, ${lastSeen})`);
      }

      // Value signals
      try {
        const activeObservations = db.db
          .query<any, []>(
            `SELECT * FROM observations
             WHERE lifecycle IN ('active', 'aging', 'pinned') AND superseded_by IS NULL`
          )
          .all();
        const securityFindings = db.db
          .query<any, []>(
            `SELECT * FROM security_findings
             ORDER BY created_at_epoch DESC
             LIMIT 500`
          )
          .all();
        const signals = computeSessionValueSignals(activeObservations, securityFindings);
        const signalParts = [
          `lessons: ${signals.lessons_count}`,
          `decisions: ${signals.decisions_count}`,
          `discoveries: ${signals.discoveries_count}`,
          `features: ${signals.features_count}`,
        ];
        if (signals.repeated_patterns_count > 0) {
          signalParts.push(`patterns: ${signals.repeated_patterns_count}`);
        }
        console.log(`    Value:         ${signalParts.join(", ")}`);
        if (signals.security_findings_count > 0 || signals.delivery_review_ready) {
          console.log(
            `    Review/Safety: ${signals.delivery_review_ready ? "delivery-ready" : "not ready"}, ` +
              `${signals.security_findings_count} finding${signals.security_findings_count === 1 ? "" : "s"}`
          );
        }
      } catch {
        // value signals are optional on older schemas
      }

      // Last session
      try {
        const lastSummary = db.db
          .query<{ request: string | null; created_at_epoch: number }, []>(
            `SELECT request, created_at_epoch FROM session_summaries
             ORDER BY created_at_epoch DESC LIMIT 1`
          )
          .get();
        if (lastSummary) {
          const label = lastSummary.request
            ? lastSummary.request.length > 50
              ? lastSummary.request.slice(0, 47) + "..."
              : lastSummary.request
            : "(no request recorded)";
          const ago = formatTimeAgo(lastSummary.created_at_epoch);
          console.log(`    Last session:  ${label} (${ago})`);
        }
      } catch {
        // session_summaries may not exist
      }

      // Installed packs
      try {
        const packs = db.getInstalledPacks();
        if (packs.length > 0) {
          console.log(`    Packs:         ${packs.join(", ")}`);
        }
      } catch {
        // packs table may not exist
      }

      // --- Sync section ---
      console.log("\n  Sync");
      console.log(
        `    Outbox:        ${outbox["pending"] ?? 0} pending, ${outbox["failed"] ?? 0} failed, ${outbox["synced"] ?? 0} synced`
      );
      const topFailures = getOutboxFailureSummaries(db, 2);
      if (topFailures.length > 0) {
        const failureSummary = topFailures
          .map((row) => `${classifyOutboxFailure(row.error)} ${row.count}`)
          .join(", ");
        console.log(`    Failures:      ${failureSummary}`);
      }

      try {
        const lastPush = db.db
          .query<{ value: string }, [string]>(
            "SELECT value FROM sync_state WHERE key = ?"
          )
          .get("last_push_epoch");
        const lastPull = db.db
          .query<{ value: string }, [string]>(
            "SELECT value FROM sync_state WHERE key = ?"
          )
          .get("last_pull_epoch");

        console.log(
          `    Last push:     ${formatSyncTime(lastPush?.value)}`
        );
        console.log(
          `    Last pull:     ${formatSyncTime(lastPull?.value)}`
        );
      } catch {
        // sync_state may not exist
      }

      // --- Security section ---
      try {
        const findings = db.db
          .query<{ severity: string; count: number }, []>(
            "SELECT severity, COUNT(*) as count FROM security_findings GROUP BY severity"
          )
          .all();
        if (findings.length > 0) {
          const bySeverity = Object.fromEntries(findings.map((f) => [f.severity, f.count]));
          const total = findings.reduce((s, f) => s + f.count, 0);
          const parts: string[] = [];
          if (bySeverity["critical"]) parts.push(`${bySeverity["critical"]} critical`);
          if (bySeverity["high"]) parts.push(`${bySeverity["high"]} high`);
          if (bySeverity["medium"]) parts.push(`${bySeverity["medium"]} medium`);
          if (bySeverity["low"]) parts.push(`${bySeverity["low"]} low`);
          console.log(`\n  Security:        ${total} finding${total === 1 ? "" : "s"} (${parts.join(", ")})`);
        }
      } catch {
        // security_findings table may not exist yet
      }

      db.close();
    } catch (error) {
      console.log(
        `\n  Database error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // --- File paths ---
  console.log(`\n  Files`);
  console.log(`    Config:        ${getSettingsPath()}`);
  console.log(`    Database:      ${getDbPath()}`);
  console.log(`    Codex config:  ${join(homedir(), ".codex", "config.toml")}`);
  console.log(`    Codex hooks:   ${join(homedir(), ".codex", "hooks.json")}`);
  console.log(`    OpenCode cfg:  ${join(homedir(), ".config", "opencode", "opencode.json")}`);
  console.log(`    OpenCode plug: ${join(homedir(), ".config", "opencode", "plugins", "engrm.js")}`);
}

function formatTimeAgo(epoch: number): string {
  const ago = Math.floor(Date.now() / 1000) - epoch;
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}

function formatSyncTime(epochStr: string | undefined): string {
  if (!epochStr) return "never";
  const epoch = parseInt(epochStr, 10);
  if (isNaN(epoch) || epoch === 0) return "never";
  return formatTimeAgo(epoch);
}

// --- Helpers ---

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function generateDeviceId(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "");
  let mac = "";
  const ifaces = networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.internal && entry.mac && entry.mac !== "00:00:00:00:00:00") {
        mac = entry.mac;
        break;
      }
    }
    if (mac) break;
  }
  const material = `${host}:${mac || "no-mac"}`;
  const suffix = createHash("sha256").update(material).digest("hex").slice(0, 8);
  return `${host}-${suffix}`;
}

// --- Install Pack ---

async function handleInstallPack(flags: string[]): Promise<void> {
  const packName = flags[0];
  if (!packName) {
    console.error("Usage: engrm install-pack <name>");
    console.error(`Available: ${listPacks().join(", ") || "none"}`);
    process.exit(1);
  }

  if (!configExists()) {
    console.error("Engrm is not configured. Run: engrm init");
    process.exit(1);
  }

  const config = loadConfig();
  const db = new MemDatabase(getDbPath());

  try {
    console.log(`Installing pack: ${packName}...`);
    const result = await installPack(db, config, packName, process.cwd());
    console.log(`Installed ${result.installed}/${result.total} observations (${result.skipped} skipped)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    db.close();
  }
}

async function handleSentinel(flags: string[]): Promise<void> {
  const subcommand = flags[0];

  if (subcommand === "init-rules") {
    if (!configExists()) {
      console.error("Engrm is not configured. Run: engrm init");
      process.exit(1);
    }
    const config = loadConfig();
    const db = new MemDatabase(getDbPath());
    try {
      const packNames = flags.slice(1);
      const names = packNames.length > 0 ? packNames : undefined;
      console.log(`Installing Sentinel rule packs: ${(names ?? listRulePacks()).join(", ")}...`);
      const result = await installRulePacks(db, config, names);
      console.log(`Installed ${result.installed} standards (${result.skipped} skipped)`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === "rules") {
    const packs = listRulePacks();
    console.log("Available Sentinel rule packs:\n");
    for (const name of packs) {
      console.log(`  ${name}`);
    }
    console.log(`\nInstall all: engrm sentinel init-rules`);
    console.log(`Install one: engrm sentinel init-rules <name>`);
    return;
  }

  console.log("Sentinel — Real-time AI code audit\n");
  console.log("Commands:");
  console.log("  engrm sentinel init-rules           Install all rule packs");
  console.log("  engrm sentinel init-rules <name>     Install specific pack");
  console.log("  engrm sentinel rules                 List available rule packs");
}

function handleListPacks(): void {
  const packs = listPacks();
  if (packs.length === 0) {
    console.log("No starter packs available.");
    return;
  }
  console.log("Available starter packs:\n");
  for (const name of packs) {
    console.log(`  ${name}`);
  }
  console.log(`\nInstall with: engrm install-pack <name>`);
}

function handleUpdate(): void {
  const { execSync } = require("node:child_process");
  console.log("Updating Engrm to latest version...\n");
  try {
    const latest = execSync("npm view engrm version", { encoding: "utf-8" }).trim();
    if (!latest) throw new Error("Could not resolve latest engrm version from npm");
    console.log(`Installing engrm@${latest}...\n`);
    execSync(`npm install -g engrm@${latest}`, { stdio: "inherit" });
    console.log("\nUpdate complete. Re-registering integrations...");
    const result = registerAll();
    console.log(`  Claude MCP registered → ${result.mcp.path}`);
    console.log(`  Claude hooks registered → ${result.hooks.path}`);
    console.log(`  Codex MCP registered → ${result.codex.path}`);
    console.log(`  Codex hooks registered → ${result.codexHooks.path}`);
    console.log("\nRestart Claude Code or Codex to use the new version.");
  } catch (error) {
    console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Try manually: npm install -g engrm@<version>");
  }
}

// --- Doctor ---

async function handleDoctor(): Promise<void> {
  type Result = { symbol: string; message: string; kind: "pass" | "fail" | "warn" | "info" };
  const results: Result[] = [];

  const pass = (msg: string) => results.push({ symbol: "\u2713", message: msg, kind: "pass" });
  const fail = (msg: string) => results.push({ symbol: "\u2717", message: msg, kind: "fail" });
  const warn = (msg: string) => results.push({ symbol: "\u26A0", message: msg, kind: "warn" });
  const info = (msg: string) => results.push({ symbol: "\u2139", message: msg, kind: "info" });

  // 1. Config exists
  if (configExists()) {
    pass("Configuration file exists");
  } else {
    fail("Configuration file not found — run: engrm init");
    // Can't continue without config
    printDoctorReport(results);
    return;
  }

  // 2. Config valid
  let config: Config | null = null;
  try {
    config = loadConfig();
    pass("Configuration is valid");
  } catch (err) {
    fail(`Configuration is invalid: ${err instanceof Error ? err.message : String(err)}`);
    printDoctorReport(results);
    return;
  }

  if (config.http.enabled) {
    if (config.http.bearer_tokens.length > 0) {
      pass(`HTTP MCP enabled on port ${config.http.port} with ${config.http.bearer_tokens.length} bearer token(s)`);
    } else {
      warn("HTTP MCP is enabled but no bearer tokens are configured");
    }
  } else {
    info("HTTP MCP disabled");
  }

  info(`Tool profile: ${config.tool_profile ?? "full"}`);

  if (config.fleet.project_name) {
    if (config.fleet.namespace && config.fleet.api_key) {
      pass(`Fleet project '${config.fleet.project_name}' is configured`);
    } else {
      info(`Fleet project '${config.fleet.project_name}' is reserved but not fully configured`);
    }
  }

  // 3. Database opens
  let db: MemDatabase | null = null;
  try {
    db = new MemDatabase(getDbPath());
    pass("Database opens successfully");
  } catch (err) {
    fail(`Database failed to open: ${err instanceof Error ? err.message : String(err)}`);
    printDoctorReport(results);
    return;
  }

  // 4. Database migrations current
  try {
    const currentVersion = getSchemaVersion(db.db);
    if (currentVersion >= LATEST_SCHEMA_VERSION) {
      pass(`Database schema is current (v${currentVersion})`);
    } else {
      warn(`Database schema is outdated (v${currentVersion}, latest is v${LATEST_SCHEMA_VERSION})`);
    }
  } catch {
    warn("Could not check database schema version");
  }

  // 5. MCP server registered
  const claudeJson = join(homedir(), ".claude.json");
  try {
    if (existsSync(claudeJson)) {
      const content = readFileSync(claudeJson, "utf-8");
      if (content.includes('"engrm"')) {
        pass("MCP server registered in Claude Code");
      } else {
        warn("MCP server not registered in Claude Code — run: engrm init");
      }
    } else {
      warn("Claude Code config not found (~/.claude.json)");
    }
  } catch {
    warn("Could not check MCP server registration");
  }

  // 6. Hooks registered
  const claudeSettings = join(homedir(), ".claude", "settings.json");
  try {
    if (existsSync(claudeSettings)) {
      const content = readFileSync(claudeSettings, "utf-8");
      let hookCount = 0;
      let hasSessionStart = false;
      let hasUserPrompt = false;
      let hasPostToolUse = false;
      let hasStop = false;
      try {
        const settings = JSON.parse(content);
        const hooks = settings?.hooks ?? {};
        hasSessionStart = Array.isArray(hooks["SessionStart"]);
        hasUserPrompt = Array.isArray(hooks["UserPromptSubmit"]);
        hasPostToolUse = Array.isArray(hooks["PostToolUse"]);
        hasStop = Array.isArray(hooks["Stop"]);
        for (const entries of Object.values(hooks)) {
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const e = entry as { hooks?: { command?: string }[] };
              if (e.hooks?.some((h) => h.command?.includes("engrm") || h.command?.includes("session-start") || h.command?.includes("user-prompt-submit") || h.command?.includes("sentinel") || h.command?.includes("post-tool-use") || h.command?.includes("pre-compact") || h.command?.includes("stop") || h.command?.includes("elicitation"))) {
                hookCount++;
              }
            }
          }
        }
      } catch {
        // parse error
      }
      const missingCritical: string[] = [];
      if (!hasSessionStart) missingCritical.push("SessionStart");
      if (!hasUserPrompt) missingCritical.push("UserPromptSubmit");
      if (!hasPostToolUse) missingCritical.push("PostToolUse");
      if (!hasStop) missingCritical.push("Stop");
      if (hookCount > 0 && missingCritical.length === 0) {
        pass(`Hooks registered (${hookCount} hook${hookCount === 1 ? "" : "s"})`);
      } else if (hookCount > 0) {
        warn(`Hooks registered but incomplete — missing ${missingCritical.join(", ")}`);
      } else {
        warn("No Engrm hooks found in Claude Code settings");
      }
    } else {
      warn("Claude Code settings not found (~/.claude/settings.json)");
    }
  } catch {
    warn("Could not check hooks registration");
  }

  // 6b. Codex MCP server registered
  const codexConfig = join(homedir(), ".codex", "config.toml");
  try {
    if (existsSync(codexConfig)) {
      const content = readFileSync(codexConfig, "utf-8");
      if (
        content.includes("[mcp_servers.engrm]") ||
        content.includes(`[mcp_servers.${LEGACY_CODEX_SERVER_NAME}]`)
      ) {
        pass("MCP server registered in Codex");
      } else {
        warn("MCP server not registered in Codex");
      }
    } else {
      warn("Codex config not found (~/.codex/config.toml)");
    }
  } catch {
    warn("Could not check Codex MCP registration");
  }

  // 6c. Codex hooks registered
  const codexHooks = join(homedir(), ".codex", "hooks.json");
  try {
    if (existsSync(codexHooks)) {
      const content = readFileSync(codexHooks, "utf-8");
      if (content.includes("\"SessionStart\"") && content.includes("\"Stop\"")) {
        pass("Hooks registered in Codex");
      } else {
        warn("Codex hooks config found, but Engrm hooks are missing");
      }
    } else {
      warn("Codex hooks config not found (~/.codex/hooks.json)");
    }
  } catch {
    warn("Could not check Codex hooks registration");
  }

  // 6d. OpenCode MCP registered
  const openclawConfig = join(homedir(), ".openclaw", "openclaw.json");
  try {
    if (existsSync(openclawConfig)) {
      const content = readFileSync(openclawConfig, "utf-8");
      if (hasOpenClawMcpRegistration(content)) {
        pass("MCP server registered in OpenClaw");
      } else {
        warn("MCP server not registered in OpenClaw");
      }
    } else {
      warn("OpenClaw config not found (~/.openclaw/openclaw.json)");
    }
  } catch {
    warn("Could not check OpenClaw MCP registration");
  }

  const openclawPlugin = join(homedir(), ".openclaw", "extensions", "engrm", "openclaw.plugin.json");
  if (existsSync(openclawPlugin)) {
    pass("Plugin installed in OpenClaw");
  } else {
    warn("OpenClaw plugin not installed (~/.openclaw/extensions/engrm/openclaw.plugin.json)");
  }

  // 6d. OpenCode MCP registered
  const opencodeConfig = join(homedir(), ".config", "opencode", "opencode.json");
  try {
    if (existsSync(opencodeConfig)) {
      const content = readFileSync(opencodeConfig, "utf-8");
      if (content.includes('"engrm"') && content.includes('"local"')) {
        pass("MCP server registered in OpenCode");
      } else {
        warn("MCP server not registered in OpenCode");
      }
    } else {
      warn("OpenCode config not found (~/.config/opencode/opencode.json)");
    }
  } catch {
    warn("Could not check OpenCode MCP registration");
  }

  // 6e. OpenCode plugin registered
  const opencodePlugin = join(homedir(), ".config", "opencode", "plugins", "engrm.js");
  if (existsSync(opencodePlugin)) {
    pass("Plugin installed in OpenCode");
  } else {
    warn("OpenCode plugin not installed (~/.config/opencode/plugins/engrm.js)");
  }

  // 7. Server connectivity
  if (config.candengo_url) {
    try {
      const baseUrl = normalizeBaseUrl(config.candengo_url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const start = Date.now();
      let res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      if (res.status === 404) {
        res = await fetch(`${baseUrl}/v1/mem/provision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        });
      }
      clearTimeout(timeout);
      const elapsed = Date.now() - start;
      if (res.ok || res.status === 400) {
        const host = new URL(baseUrl).hostname;
        pass(`Server connectivity (${host}, ${elapsed}ms)`);
      } else {
        fail(`Server returned HTTP ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Server unreachable: ${msg.includes("abort") ? "timeout (5s)" : msg}`);
    }
  } else {
    fail("Server URL not configured");
  }

  // 8. Auth valid
  if (config.candengo_url && config.candengo_api_key) {
    try {
      const baseUrl = normalizeBaseUrl(config.candengo_url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}/v1/mem/user-settings`, {
        headers: { Authorization: `Bearer ${config.candengo_api_key}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const email = config.user_email ?? "configured";
        pass(`Authentication valid (${email})`);
      } else if (res.status === 401 || res.status === 403) {
        fail("Authentication failed — API key may be expired");
      } else {
        fail(`Authentication check returned HTTP ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Authentication check failed: ${msg.includes("abort") ? "timeout (5s)" : msg}`);
    }
  } else {
    fail("Authentication not configured (missing URL or API key)");
  }

  // 9. Sync working
  try {
    const outbox = getOutboxStats(db);
    const failedCount = outbox["failed"] ?? 0;
    if (failedCount > 10) {
      warn(`Sync has stuck items (${failedCount} failed in outbox)`);
    } else {
      const pending = outbox["pending"] ?? 0;
      pass(`Sync outbox healthy (${pending} pending, ${failedCount} failed)`);
    }
  } catch {
    warn("Could not check sync outbox");
  }

  // 10. Embedding model (sqlite-vec)
  if (db.vecAvailable) {
    pass("Embedding model available (sqlite-vec loaded)");
  } else {
    warn("Embedding model not available (FTS5 fallback active)");
  }

  // 11. Observation count
  try {
    const totalActive = db.getActiveObservationCount();
    if (totalActive > 0) {
      // Get lifecycle breakdown
      let breakdownParts: string[] = [];
      try {
        const byLifecycle = db.db
          .query<{ lifecycle: string; count: number }, []>(
            `SELECT lifecycle, COUNT(*) as count FROM observations
             WHERE superseded_by IS NULL AND lifecycle IN ('active', 'aging', 'pinned')
             GROUP BY lifecycle`
          )
          .all();
        breakdownParts = byLifecycle.map((r) => `${r.lifecycle}: ${r.count.toLocaleString()}`);
      } catch {
        // fallback — no breakdown
      }
      const detail = breakdownParts.length > 0 ? ` (${breakdownParts.join(", ")})` : "";
      pass(`${totalActive.toLocaleString()} observations${detail}`);
    } else {
      warn("No observations yet — start a Claude Code session to capture context");
    }
  } catch {
    warn("Could not count observations");
  }

  // 12. Raw chronology capture
  try {
    const capture = getCaptureStatus(db, { user_id: config.user_id });
    if (
      capture.raw_capture_active &&
      capture.recent_tool_events > 0 &&
      capture.recent_sessions_with_partial_capture === 0
    ) {
      pass(
        `Raw chronology active (${capture.recent_user_prompts} prompts, ${capture.recent_tool_events} tools in last 24h)`
      );
    } else if (capture.raw_capture_active && capture.recent_sessions_with_partial_capture > 0) {
      warn(
        `Raw chronology is only partially active (${capture.recent_user_prompts} prompts, ${capture.recent_tool_events} tools in last 24h; ${capture.recent_sessions_with_partial_capture} recent session${capture.recent_sessions_with_partial_capture === 1 ? "" : "s"} missing some chronology).`
      );
      if (capture.latest_post_tool_hook_epoch) {
        info(
          `Last PostToolUse hook: ${new Date(capture.latest_post_tool_hook_epoch * 1000).toISOString()} (${capture.latest_post_tool_parse_status ?? "unknown"}${capture.latest_post_tool_name ? `, ${capture.latest_post_tool_name}` : ""})`
        );
      }
    } else if (capture.claude_hooks_registered || capture.codex_hooks_registered) {
      const guidance = capture.claude_user_prompt_hook && capture.claude_post_tool_hook
        ? "Claude is raw-ready; open a fresh Claude Code session and perform a few actions to verify capture."
        : "Claude raw chronology hooks are incomplete, and Codex currently supports start/stop capture only.";
      warn(
        `Hooks are registered, but no raw prompt/tool chronology has been captured in the last 24h. ${guidance}`
      );
    } else {
      warn("Raw chronology inactive — hook registration is incomplete");
    }
  } catch {
    warn("Could not check raw chronology capture");
  }

  // 13. Disk space
  try {
    const dbPath = getDbPath();
    if (existsSync(dbPath)) {
      const stats = statSync(dbPath);
      const sizeMB = stats.size / (1024 * 1024);
      const sizeStr = sizeMB >= 1 ? `${sizeMB.toFixed(1)} MB` : `${(stats.size / 1024).toFixed(0)} KB`;
      info(`Database size: ${sizeStr}`);
    }
  } catch {
    // skip
  }

  db.close();
  printDoctorReport(results);
}

function printDoctorReport(results: { symbol: string; message: string; kind: "pass" | "fail" | "warn" | "info" }[]): void {
  console.log("\nEngrm Doctor \u2014 Diagnostic Report\n");

  for (const r of results) {
    console.log(`  ${r.symbol} ${r.message}`);
  }

  const passes = results.filter((r) => r.kind === "pass").length;
  const fails = results.filter((r) => r.kind === "fail").length;
  const warns = results.filter((r) => r.kind === "warn").length;
  const checks = results.filter((r) => r.kind !== "info").length;

  const parts: string[] = [];
  if (warns > 0) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  if (fails > 0) parts.push(`${fails} failure${fails === 1 ? "" : "s"}`);

  const summary = `${passes}/${checks} checks passed` + (parts.length > 0 ? `, ${parts.join(", ")}` : "");
  console.log(`\n  ${summary}`);
}

/**
 * Check device count vs plan limit after provisioning.
 * Best-effort — failures are silently ignored.
 */
async function checkDeviceLimits(baseUrl: string, apiKey: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${baseUrl}/v1/mem/billing`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return;

    const billing = (await resp.json()) as {
      limits?: { max_devices?: number; max_observations?: number };
      usage?: { devices?: number; observations?: number };
      plan?: string;
      upgrade_url?: string;
    };
    const limits = billing.limits || {};
    const usage = billing.usage || {};

    if (limits.max_devices && usage.devices && usage.devices >= limits.max_devices) {
      const upgradeUrl = billing.upgrade_url || "https://engrm.dev/billing";
      console.warn(
        `\n\u26A0\uFE0F  Device limit reached (${usage.devices}/${limits.max_devices}).`
      );
      console.warn(
        `   This device may not sync. Upgrade at: ${upgradeUrl}`
      );
    }

    if (limits.max_observations && usage.observations && usage.observations >= limits.max_observations) {
      console.warn(
        `\u26A0\uFE0F  Observation limit reached (${usage.observations.toLocaleString()}/${limits.max_observations.toLocaleString()}).`
      );
      console.warn(
        `   New observations won't sync until you upgrade or delete old data.`
      );
    }
  } catch {
    // Best-effort — don't block init on network/parse errors
  }
}

function printPostInit(): void {
  console.log("\nRegistering with Claude Code and Codex...");

  try {
    const result = registerAll();
    console.log(`  Claude MCP registered → ${result.mcp.path}`);
    console.log(`  Claude hooks registered → ${result.hooks.path}`);
    console.log(`  Codex MCP registered → ${result.codex.path}`);
    console.log(`  Codex hooks registered → ${result.codexHooks.path}`);
    console.log(`  OpenCode MCP registered → ${result.opencode.path}`);
    console.log(`  OpenCode plugin installed → ${result.opencode.pluginPath}`);
    console.log("\nEngrm is ready! Start a new Claude Code, Codex, or OpenCode session to use memory.");
  } catch (error) {
    const packageRoot = join(THIS_DIR, "..");
    const runtime = IS_BUILT_DIST ? process.execPath : "bun";
    const serverArgs = IS_BUILT_DIST
      ? [join(packageRoot, "dist", "server.js")]
      : ["run", join(packageRoot, "src", "server.ts")];
    const sessionStartCommand = IS_BUILT_DIST
      ? `${process.execPath} ${join(packageRoot, "dist", "hooks", "session-start.js")}`
      : `bun run ${join(packageRoot, "hooks", "session-start.ts")}`;
    const codexStopCommand = IS_BUILT_DIST
      ? `${process.execPath} ${join(packageRoot, "dist", "hooks", "codex-stop.js")}`
      : `bun run ${join(packageRoot, "hooks", "codex-stop.ts")}`;

    // Registration failed — fall back to manual instructions
    console.log("\nCould not auto-register with Claude Code, Codex, and OpenCode.");
    console.log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.log("\nManual setup — add to ~/.claude.json:");
    console.log(`
{
  "mcpServers": {
    "engrm": {
      "type": "stdio",
      "command": "${runtime}",
      "args": ${JSON.stringify(serverArgs)}
    }
  }
}`);
    console.log("\nAnd add to ~/.codex/config.toml:");
    console.log(`
[mcp_servers.engrm]
enabled = true
command = "${runtime}"
args = ${formatTomlArray(serverArgs)}
startup_timeout_sec = 15
tool_timeout_sec = 30
[features]
codex_hooks = true
`);
    console.log("\nAnd add to ~/.codex/hooks.json:");
    console.log(`
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${sessionStartCommand}"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${codexStopCommand}"
          }
        ]
      }
    ]
  }
}
`);
    console.log("\nAnd add to ~/.config/opencode/opencode.json:");
    console.log(`
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "engrm": {
      "type": "local",
      "command": ${JSON.stringify(IS_BUILT_DIST ? [process.execPath, join(packageRoot, "dist", "server.js")] : ["bun", "run", join(packageRoot, "src", "server.ts")])},
      "enabled": true,
      "timeout": 5000
    }
  }
}
`);
    console.log("\nAnd copy the OpenCode plugin file to ~/.config/opencode/plugins/engrm.js:");
    console.log(`  ${join(packageRoot, "opencode", "plugin", "engrm-opencode.js")}`);
  }
}

function formatTomlArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function hasOpenClawMcpRegistration(content: string): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as {
      mcp?: { servers?: Record<string, unknown> };
    };
    return Boolean(parsed.mcp?.servers?.engrm);
  } catch {
    return content.includes('"mcp"') && content.includes('"servers"') && content.includes('"engrm"');
  }
}

function printUsage(): void {
  console.log("Engrm — Memory layer for AI coding agents\n");
  console.log("Usage:");
  console.log("  engrm serve                 Run the MCP server over stdio");
  console.log("  engrm init                  Setup via browser (recommended)");
  console.log("  engrm init --token=cmt_xxx  Setup from provisioning token");
  console.log("  engrm init --pack=<name>    Setup + install a starter pack");
  console.log("  engrm init --no-browser     Setup via device code (SSH/headless)");
  console.log("  engrm init --manual         Manual setup (enter all values)");
  console.log("  engrm init --config <file>  Setup from JSON file");
  console.log("  engrm status                Show status");
  console.log("  engrm update                Update to latest version");
  console.log("  engrm packs                 List available starter packs");
  console.log("  engrm install-pack <name>   Install a starter pack");
  console.log("  engrm doctor                Run diagnostic checks");
  console.log("  engrm sentinel              Sentinel code audit commands");
  console.log("  engrm sentinel init-rules   Install Sentinel rule packs");
}

/**
 * Simple line-based prompter using Node.js readline.
 */
function createPrompter(): (question: string) => Promise<string> {
  return async (question: string): Promise<string> => {
    process.stdout.write(question);
    for await (const chunk of process.stdin) {
      const line = (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()).trim();
      return line;
    }
    return "";
  };
}
