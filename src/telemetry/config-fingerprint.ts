/**
 * Config fingerprinting — detect when agent configuration changes.
 *
 * Hashes CLAUDE.md, MEMORY.md, .engrm.json, and client version into
 * a single combined hash. Compares with previous session to detect
 * config changes that may affect agent effectiveness.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ConfigFingerprint {
  config_hash: string;
  config_changed: boolean;
  claude_md_hash: string | null;
  memory_md_hash: string | null;
  engrm_json_hash: string | null;
  memory_file_count: number;
  client_version: string;
}

const STATE_PATH = join(homedir(), ".engrm", "config-fingerprint.json");
const CLIENT_VERSION = "0.4.37";

function hashFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function countMemoryFiles(memoryDir: string): number {
  try {
    if (!existsSync(memoryDir)) return 0;
    return readdirSync(memoryDir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function readPreviousFingerprint(): ConfigFingerprint | null {
  try {
    if (!existsSync(STATE_PATH)) return null;
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as ConfigFingerprint;
  } catch {
    return null;
  }
}

function saveFingerprint(fp: ConfigFingerprint): void {
  try {
    const dir = join(homedir(), ".engrm");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(fp, null, 2) + "\n", "utf-8");
  } catch {
    // State file is best-effort
  }
}

/**
 * Compute a config fingerprint for the current working directory.
 * Compares with the previous session's fingerprint to detect changes.
 *
 * @param cwd - The current working directory (project root)
 * @returns The computed fingerprint
 */
export function computeAndSaveFingerprint(cwd: string): ConfigFingerprint {
  // Hash individual config files
  const claudeMdHash = hashFile(join(cwd, "CLAUDE.md"));
  const engrmJsonHash = hashFile(join(cwd, ".engrm.json"));

  // Memory dir: ~/.claude/projects/{slug}/memory/MEMORY.md
  const slug = cwd.replace(/\//g, "-");
  const memoryDir = join(homedir(), ".claude", "projects", slug, "memory");
  const memoryMdHash = hashFile(join(memoryDir, "MEMORY.md"));
  const memoryFileCount = countMemoryFiles(memoryDir);

  // Combined hash
  const material = [
    claudeMdHash ?? "null",
    memoryMdHash ?? "null",
    engrmJsonHash ?? "null",
    String(memoryFileCount),
    CLIENT_VERSION,
  ].join("+");
  const configHash = createHash("sha256").update(material).digest("hex");

  // Compare with previous
  const previous = readPreviousFingerprint();
  const configChanged = previous !== null && previous.config_hash !== configHash;

  const fingerprint: ConfigFingerprint = {
    config_hash: configHash,
    config_changed: configChanged,
    claude_md_hash: claudeMdHash,
    memory_md_hash: memoryMdHash,
    engrm_json_hash: engrmJsonHash,
    memory_file_count: memoryFileCount,
    client_version: CLIENT_VERSION,
  };

  saveFingerprint(fingerprint);
  return fingerprint;
}
