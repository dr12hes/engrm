/**
 * Secret scrubbing pipeline.
 *
 * Runs before any observation is saved (even to local SQLite).
 * Patterns from SPEC §6.
 *
 * Pattern definitions are stored as source/flags (not RegExp instances)
 * to avoid shared mutable state from global regex lastIndex.
 */

export interface ScrubPatternDef {
  source: string;
  flags: string;
  replacement: string;
  description: string;
  category: "api_key" | "token" | "password" | "db_url" | "custom";
  severity: "critical" | "high" | "medium" | "low";
}

export const DEFAULT_PATTERNS: ScrubPatternDef[] = [
  {
    source: "sk-[a-zA-Z0-9]{20,}",
    flags: "g",
    replacement: "[REDACTED_API_KEY]",
    description: "OpenAI API keys",
    category: "api_key",
    severity: "critical",
  },
  {
    source: "Bearer [a-zA-Z0-9\\-._~+/]+=*",
    flags: "g",
    replacement: "[REDACTED_BEARER]",
    description: "Bearer auth tokens",
    category: "token",
    severity: "medium",
  },
  {
    source: "password[=:]\\s*\\S+",
    flags: "gi",
    replacement: "password=[REDACTED]",
    description: "Passwords in config",
    category: "password",
    severity: "high",
  },
  {
    source: "postgresql://[^\\s]+",
    flags: "g",
    replacement: "[REDACTED_DB_URL]",
    description: "PostgreSQL connection strings",
    category: "db_url",
    severity: "high",
  },
  {
    source: "mongodb://[^\\s]+",
    flags: "g",
    replacement: "[REDACTED_DB_URL]",
    description: "MongoDB connection strings",
    category: "db_url",
    severity: "high",
  },
  {
    source: "mysql://[^\\s]+",
    flags: "g",
    replacement: "[REDACTED_DB_URL]",
    description: "MySQL connection strings",
    category: "db_url",
    severity: "high",
  },
  {
    source: "AKIA[A-Z0-9]{16}",
    flags: "g",
    replacement: "[REDACTED_AWS_KEY]",
    description: "AWS access keys",
    category: "api_key",
    severity: "critical",
  },
  {
    source: "ghp_[a-zA-Z0-9]{36}",
    flags: "g",
    replacement: "[REDACTED_GH_TOKEN]",
    description: "GitHub personal access tokens",
    category: "token",
    severity: "high",
  },
  {
    source: "gho_[a-zA-Z0-9]{36}",
    flags: "g",
    replacement: "[REDACTED_GH_TOKEN]",
    description: "GitHub OAuth tokens",
    category: "token",
    severity: "high",
  },
  {
    source: "github_pat_[a-zA-Z0-9_]{22,}",
    flags: "g",
    replacement: "[REDACTED_GH_TOKEN]",
    description: "GitHub fine-grained PATs",
    category: "token",
    severity: "high",
  },
  {
    source: "cvk_[a-f0-9]{64}",
    flags: "g",
    replacement: "[REDACTED_CANDENGO_KEY]",
    description: "Candengo API keys",
    category: "api_key",
    severity: "critical",
  },
  {
    source: "xox[bpras]-[a-zA-Z0-9\\-]+",
    flags: "g",
    replacement: "[REDACTED_SLACK_TOKEN]",
    description: "Slack tokens",
    category: "token",
    severity: "high",
  },
];

/**
 * Compile custom patterns from config strings into pattern definitions.
 * Each string is treated as a regex pattern with global flag.
 */
function compileCustomPatterns(patterns: string[]): ScrubPatternDef[] {
  const compiled: ScrubPatternDef[] = [];
  for (const pattern of patterns) {
    try {
      // Validate the regex is parseable
      new RegExp(pattern);
      compiled.push({
        source: pattern,
        flags: "g",
        replacement: "[REDACTED_CUSTOM]",
        description: `Custom pattern: ${pattern}`,
        category: "custom",
        severity: "medium",
      });
    } catch {
      // Skip invalid regex patterns — don't crash the scrubber
    }
  }
  return compiled;
}

/**
 * Scrub sensitive content from text.
 * Returns the scrubbed text.
 */
export function scrubSecrets(
  text: string,
  customPatterns: string[] = []
): string {
  let result = text;
  const allPatterns = [...DEFAULT_PATTERNS, ...compileCustomPatterns(customPatterns)];

  for (const pattern of allPatterns) {
    // Fresh RegExp per call — no shared mutable lastIndex state
    result = result.replace(
      new RegExp(pattern.source, pattern.flags),
      pattern.replacement
    );
  }

  return result;
}

/**
 * Check if text contains any secrets that would be scrubbed.
 * Useful for sensitivity classification.
 */
export function containsSecrets(
  text: string,
  customPatterns: string[] = []
): boolean {
  const allPatterns = [...DEFAULT_PATTERNS, ...compileCustomPatterns(customPatterns)];

  for (const pattern of allPatterns) {
    if (new RegExp(pattern.source, pattern.flags).test(text)) return true;
  }

  return false;
}

const FLEET_HOSTNAME_PATTERN = /\b(?=.{1,253}\b)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
const FLEET_IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const FLEET_MAC_PATTERN = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi;

export function scrubFleetIdentifiers(text: string): string {
  return text
    .replace(FLEET_MAC_PATTERN, "[REDACTED_MAC]")
    .replace(FLEET_IP_PATTERN, "[REDACTED_IP]")
    .replace(FLEET_HOSTNAME_PATTERN, "[REDACTED_HOSTNAME]");
}
