/**
 * Sentinel rule pack loader.
 *
 * Loads standard observations from built-in rule packs
 * into the local database.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { saveObservation } from "../tools/save.js";

interface RulePackObservation {
  type: string;
  title: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
}

interface RulePack {
  name: string;
  description: string;
  observations: RulePackObservation[];
}

/**
 * Get the rule packs directory.
 */
function getRulePacksDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "rule-packs");
}

/**
 * List available rule pack names.
 */
export function listRulePacks(): string[] {
  const dir = getRulePacksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/**
 * Load a rule pack by name.
 */
export function loadRulePack(name: string): RulePack | null {
  const filePath = join(getRulePacksDir(), `${name}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as RulePack;
  } catch {
    return null;
  }
}

/**
 * Install one or all rule packs into the database.
 */
export async function installRulePacks(
  db: MemDatabase,
  config: Config,
  packNames?: string[]
): Promise<{ installed: number; skipped: number }> {
  const names = packNames ?? listRulePacks();
  let installed = 0;
  let skipped = 0;

  for (const name of names) {
    const pack = loadRulePack(name);
    if (!pack) {
      skipped++;
      continue;
    }

    for (const obs of pack.observations) {
      const result = await saveObservation(db, config, {
        type: obs.type,
        title: obs.title,
        narrative: obs.narrative,
        facts: obs.facts,
        concepts: obs.concepts ?? [name, "sentinel-standard"],
        cwd: process.cwd(),
      });

      if (result.success && result.observation_id) {
        installed++;
      } else {
        skipped++;
      }
    }
  }

  return { installed, skipped };
}
