import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// --- Types ---

export interface SyncConfig {
  enabled: boolean;
  interval_seconds: number;
  batch_size: number;
}

export interface SearchConfig {
  default_limit: number;
  local_boost: number;
  scope: "personal" | "team" | "all";
}

export interface ScrubbingConfig {
  enabled: boolean;
  custom_patterns: string[];
  default_sensitivity: "shared" | "personal" | "secret";
}

export interface TeamMembership {
  id: string;
  name: string;
  namespace: string;
}

export interface SentinelConfig {
  enabled: boolean;
  mode: "advisory" | "blocking";
  provider: "openai" | "anthropic" | "ollama" | "custom";
  model: string;
  api_key: string;
  base_url: string;
  skip_patterns: string[];
  daily_limit: number;
  /** Cached subscription tier — determines Sentinel access */
  tier: "free" | "vibe" | "solo" | "pro" | "team" | "enterprise";
}

export interface ObserverConfig {
  /** Enable AI-powered observation extraction (default: true) */
  enabled: boolean;
  /** Processing mode: "per_event" or "per_session" (default: "per_event") */
  mode: "per_event" | "per_session";
  /** Model to use for observation extraction (default: "sonnet") */
  model: string;
}

export interface TranscriptAnalysisConfig {
  /** Enable transcript analysis at session end (default: false, opt-in) */
  enabled: boolean;
}

export interface Config {
  candengo_url: string;
  candengo_api_key: string;
  site_id: string;
  namespace: string;
  user_id: string;
  user_email: string;
  device_id: string;
  teams: TeamMembership[];
  sync: SyncConfig;
  search: SearchConfig;
  scrubbing: ScrubbingConfig;
  sentinel: SentinelConfig;
  observer: ObserverConfig;
  transcript_analysis: TranscriptAnalysisConfig;
}

// --- Paths ---

const CONFIG_DIR = join(homedir(), ".engrm");
const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");
const DB_PATH = join(CONFIG_DIR, "engrm.db");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

export function getDbPath(): string {
  return DB_PATH;
}

// --- Device ID ---

/**
 * Generate a deterministic device ID from machine-specific attributes.
 * Same machine always produces the same ID, even across re-installs.
 * Format: {hostname}-{hash8} where hash is derived from hostname + MAC address.
 */
function generateDeviceId(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "");

  // Get the first non-internal MAC address for a stable machine fingerprint
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

  // Hash hostname + MAC for a stable suffix (falls back to hostname-only if no MAC)
  const material = `${host}:${mac || "no-mac"}`;
  const suffix = createHash("sha256").update(material).digest("hex").slice(0, 8);
  return `${host}-${suffix}`;
}

// --- Defaults ---

function createDefaultConfig(): Config {
  return {
    candengo_url: "",
    candengo_api_key: "",
    site_id: "",
    namespace: "",
    user_id: "",
    user_email: "",
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
      model: "sonnet",
    },
    transcript_analysis: {
      enabled: false,
    },
  };
}

// --- Load / Save ---

export function loadConfig(): Config {
  if (!existsSync(SETTINGS_PATH)) {
    throw new Error(
      `Config not found at ${SETTINGS_PATH}. Run 'engrm init --manual' to configure.`
    );
  }

  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${SETTINGS_PATH}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Config at ${SETTINGS_PATH} is not a JSON object`);
  }

  const config = parsed as Record<string, unknown>;

  // Merge with defaults to fill any missing fields
  const defaults = createDefaultConfig();
  return {
    candengo_url: asString(config["candengo_url"], defaults.candengo_url),
    candengo_api_key: asString(config["candengo_api_key"], defaults.candengo_api_key),
    site_id: asString(config["site_id"], defaults.site_id),
    namespace: asString(config["namespace"], defaults.namespace),
    user_id: asString(config["user_id"], defaults.user_id),
    user_email: asString(config["user_email"], defaults.user_email),
    device_id: asString(config["device_id"], defaults.device_id),
    teams: asTeams(config["teams"], defaults.teams),
    sync: {
      enabled: asBool(
        (config["sync"] as Record<string, unknown> | undefined)?.["enabled"],
        defaults.sync.enabled
      ),
      interval_seconds: asNumber(
        (config["sync"] as Record<string, unknown> | undefined)?.["interval_seconds"],
        defaults.sync.interval_seconds
      ),
      batch_size: asNumber(
        (config["sync"] as Record<string, unknown> | undefined)?.["batch_size"],
        defaults.sync.batch_size
      ),
    },
    search: {
      default_limit: asNumber(
        (config["search"] as Record<string, unknown> | undefined)?.["default_limit"],
        defaults.search.default_limit
      ),
      local_boost: asNumber(
        (config["search"] as Record<string, unknown> | undefined)?.["local_boost"],
        defaults.search.local_boost
      ),
      scope: asScope(
        (config["search"] as Record<string, unknown> | undefined)?.["scope"],
        defaults.search.scope
      ),
    },
    scrubbing: {
      enabled: asBool(
        (config["scrubbing"] as Record<string, unknown> | undefined)?.["enabled"],
        defaults.scrubbing.enabled
      ),
      custom_patterns: asStringArray(
        (config["scrubbing"] as Record<string, unknown> | undefined)?.["custom_patterns"],
        defaults.scrubbing.custom_patterns
      ),
      default_sensitivity: asSensitivity(
        (config["scrubbing"] as Record<string, unknown> | undefined)?.["default_sensitivity"],
        defaults.scrubbing.default_sensitivity
      ),
    },
    sentinel: {
      enabled: asBool(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["enabled"],
        defaults.sentinel.enabled
      ),
      mode: asSentinelMode(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["mode"],
        defaults.sentinel.mode
      ),
      provider: asLlmProvider(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["provider"],
        defaults.sentinel.provider
      ),
      model: asString(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["model"],
        defaults.sentinel.model
      ),
      api_key: asString(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["api_key"],
        defaults.sentinel.api_key
      ),
      base_url: asString(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["base_url"],
        defaults.sentinel.base_url
      ),
      skip_patterns: asStringArray(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["skip_patterns"],
        defaults.sentinel.skip_patterns
      ),
      daily_limit: asNumber(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["daily_limit"],
        defaults.sentinel.daily_limit
      ),
      tier: asTier(
        (config["sentinel"] as Record<string, unknown> | undefined)?.["tier"],
        defaults.sentinel.tier
      ),
    },
    observer: {
      enabled: asBool(
        (config["observer"] as Record<string, unknown> | undefined)?.["enabled"],
        defaults.observer.enabled
      ),
      mode: asObserverMode(
        (config["observer"] as Record<string, unknown> | undefined)?.["mode"],
        defaults.observer.mode
      ),
      model: asString(
        (config["observer"] as Record<string, unknown> | undefined)?.["model"],
        defaults.observer.model
      ),
    },
    transcript_analysis: {
      enabled: asBool(
        (config["transcript_analysis"] as Record<string, unknown> | undefined)?.["enabled"],
        defaults.transcript_analysis.enabled
      ),
    },
  };
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configExists(): boolean {
  return existsSync(SETTINGS_PATH);
}

// --- Type helpers ---

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : fallback;
}

function asScope(
  value: unknown,
  fallback: "personal" | "team" | "all"
): "personal" | "team" | "all" {
  if (value === "personal" || value === "team" || value === "all") return value;
  return fallback;
}

function asSensitivity(
  value: unknown,
  fallback: "shared" | "personal" | "secret"
): "shared" | "personal" | "secret" {
  if (value === "shared" || value === "personal" || value === "secret") return value;
  return fallback;
}

function asSentinelMode(
  value: unknown,
  fallback: "advisory" | "blocking"
): "advisory" | "blocking" {
  if (value === "advisory" || value === "blocking") return value;
  return fallback;
}

function asLlmProvider(
  value: unknown,
  fallback: "openai" | "anthropic" | "ollama" | "custom"
): "openai" | "anthropic" | "ollama" | "custom" {
  if (value === "openai" || value === "anthropic" || value === "ollama" || value === "custom") return value;
  return fallback;
}

function asTier(
  value: unknown,
  fallback: "free" | "vibe" | "solo" | "pro" | "team" | "enterprise"
): "free" | "vibe" | "solo" | "pro" | "team" | "enterprise" {
  if (value === "free" || value === "vibe" || value === "solo" || value === "pro" || value === "team" || value === "enterprise") return value;
  return fallback;
}

function asObserverMode(
  value: unknown,
  fallback: "per_event" | "per_session"
): "per_event" | "per_session" {
  if (value === "per_event" || value === "per_session") return value;
  return fallback;
}

function asTeams(value: unknown, fallback: TeamMembership[]): TeamMembership[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter(
    (t): t is TeamMembership =>
      typeof t === "object" &&
      t !== null &&
      typeof t.id === "string" &&
      typeof t.name === "string" &&
      typeof t.namespace === "string"
  );
}
