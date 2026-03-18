/**
 * Shared utilities for Claude Code hooks.
 *
 * All hooks must:
 *   - Exit 0 to allow the session to proceed (never block)
 *   - Output errors to stderr (shown to user in terminal)
 *   - Fail gracefully when config/DB/deps are missing
 */

import { configExists, loadConfig, getDbPath } from "../config.js";
import { MemDatabase } from "../storage/sqlite.js";

// ANSI color helpers
const c = {
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

/**
 * Read all stdin as a string. Returns empty string if nothing.
 */
export async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
  }
  return chunks.join("");
}

/**
 * Parse stdin JSON, returning null if empty or invalid.
 */
export async function parseStdinJson<T>(): Promise<T | null> {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface HookBootstrap {
  config: ReturnType<typeof loadConfig>;
  db: MemDatabase;
}

/**
 * Bootstrap a hook: load config and open database.
 * Returns null with a user-visible warning if setup fails.
 * Hooks should exit 0 when this returns null.
 */
export function bootstrapHook(hookName: string): HookBootstrap | null {
  if (!configExists()) {
    warnUser(hookName, "Engrm not configured. Run: npx engrm init");
    return null;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    warnUser(hookName, `Config error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  let db;
  try {
    db = new MemDatabase(getDbPath());
  } catch (err) {
    warnUser(hookName, `Database error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  return { config, db };
}

/**
 * Show a visible warning to the user (stderr).
 * Only for bootstrap failures — optional feature errors should be silent.
 */
export function warnUser(hookName: string, message: string): void {
  console.error(`${c.yellow}engrm ${hookName}:${c.reset} ${c.dim}${message}${c.reset}`);
}

/**
 * Wrap a hook's main function with error handling.
 * Catches unhandled errors, shows a warning, and exits 0 (never blocks).
 */
export function runHook(hookName: string, fn: () => Promise<void>): void {
  fn().catch((err) => {
    warnUser(hookName, `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
}
