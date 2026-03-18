import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Normalise a git remote URL to a canonical project ID.
 *
 * All of these resolve to the same canonical ID:
 *   git@github.com:unimpossible/aimy-agent.git     → github.com/unimpossible/aimy-agent
 *   https://github.com/unimpossible/aimy-agent.git  → github.com/unimpossible/aimy-agent
 *   https://david@github.com/unimpossible/aimy-agent → github.com/unimpossible/aimy-agent
 *   ssh://git@github.com/unimpossible/aimy-agent.git → github.com/unimpossible/aimy-agent
 *
 * Rules (from SPEC §1):
 *   1. Strip protocol (https://, git@, ssh://)
 *   2. Replace : with / (for SSH-style URLs)
 *   3. Strip .git suffix
 *   4. Strip auth credentials (user@)
 *   5. Lowercase the host
 */
export function normaliseGitRemoteUrl(remoteUrl: string): string {
  let url = remoteUrl.trim();

  // Strip protocol
  url = url.replace(/^(?:https?|ssh|git):\/\//, "");

  // Strip auth credentials (anything before @ in host part)
  // Handle: git@github.com:... and david@github.com/...
  url = url.replace(/^[^@]+@/, "");

  // Replace : with / for SSH-style URLs (github.com:org/repo → github.com/org/repo)
  // But only if it looks like host:path (not a port like github.com:443/...)
  url = url.replace(/^([^/:]+):(?!\d)/, "$1/");

  // Strip .git suffix
  url = url.replace(/\.git$/, "");

  // Strip trailing slashes
  url = url.replace(/\/+$/, "");

  // Lowercase the host portion (everything before the first /)
  const slashIndex = url.indexOf("/");
  if (slashIndex !== -1) {
    const host = url.substring(0, slashIndex).toLowerCase();
    const path = url.substring(slashIndex);
    url = host + path;
  } else {
    url = url.toLowerCase();
  }

  return url;
}

/**
 * Extract a human-readable project name from a canonical ID.
 * github.com/unimpossible/aimy-agent → aimy-agent
 */
export function projectNameFromCanonicalId(canonicalId: string): string {
  const parts = canonicalId.split("/");
  return parts[parts.length - 1] ?? canonicalId;
}

/**
 * Try to get the git remote origin URL for a directory.
 * Returns null if not a git repo or no remote configured.
 */
function getGitRemoteUrl(directory: string): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: directory,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return url || null;
  } catch {
    // Not a git repo, or no origin remote
    // Try any remote
    try {
      const remotes = execSync("git remote", {
        cwd: directory,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .trim()
        .split("\n")
        .filter(Boolean);

      if (remotes.length === 0) return null;

      const url = execSync(`git remote get-url ${remotes[0]}`, {
        cwd: directory,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return url || null;
    } catch {
      return null;
    }
  }
}

/**
 * Project config file (.engrm.json) for non-git projects or overrides.
 */
interface ProjectConfigFile {
  project_id: string;
  name?: string;
}

function readProjectConfigFile(directory: string): ProjectConfigFile | null {
  const configPath = join(directory, ".engrm.json");
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed["project_id"] !== "string" || !parsed["project_id"]) {
      return null;
    }

    return {
      project_id: parsed["project_id"],
      name: typeof parsed["name"] === "string" ? parsed["name"] : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Detect the project identity for a given directory.
 *
 * Resolution order (from SPEC §1):
 *   1. Git remote origin URL → normalised
 *   2. Git remote (any remote if origin doesn't exist)
 *   3. Manual project_id in .engrm.json
 *   4. Last resort: directory name
 *
 * Returns { canonicalId, name, remoteUrl, localPath }
 */
export interface DetectedProject {
  canonical_id: string;
  name: string;
  remote_url: string | null;
  local_path: string;
}

export function detectProject(directory: string): DetectedProject {
  // Try git remote first (covers fallback #1 and #2)
  const remoteUrl = getGitRemoteUrl(directory);
  if (remoteUrl) {
    const canonicalId = normaliseGitRemoteUrl(remoteUrl);
    return {
      canonical_id: canonicalId,
      name: projectNameFromCanonicalId(canonicalId),
      remote_url: remoteUrl,
      local_path: directory,
    };
  }

  // Try .engrm.json config file
  const configFile = readProjectConfigFile(directory);
  if (configFile) {
    return {
      canonical_id: configFile.project_id,
      name: configFile.name ?? projectNameFromCanonicalId(configFile.project_id),
      remote_url: null,
      local_path: directory,
    };
  }

  // Last resort: directory name
  const dirName = basename(directory);
  return {
    canonical_id: `local/${dirName}`,
    name: dirName,
    remote_url: null,
    local_path: directory,
  };
}
