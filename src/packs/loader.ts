/**
 * Starter pack loader.
 *
 * Loads curated observation packs (JSON) into local SQLite
 * via the save pipeline. Packs are shipped with the package
 * in the packs/ directory.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { saveObservation } from "../tools/save.js";

export interface PackObservation {
  type: string;
  title: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
}

export interface Pack {
  name: string;
  description: string;
  version: string;
  observations: PackObservation[];
}

/**
 * Resolve the packs directory (sibling to src/).
 */
function getPacksDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "..", "packs");
}

/**
 * List available pack names.
 */
export function listPacks(): string[] {
  const dir = getPacksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/**
 * Load a pack definition by name.
 */
export function loadPack(name: string): Pack | null {
  const filePath = join(getPacksDir(), `${name}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Pack;
    if (!parsed.name || !Array.isArray(parsed.observations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Install a pack into the local database.
 * Returns the number of observations successfully saved.
 */
export async function installPack(
  db: MemDatabase,
  config: Config,
  packName: string,
  cwd: string
): Promise<{ installed: number; skipped: number; total: number }> {
  const pack = loadPack(packName);
  if (!pack) {
    throw new Error(
      `Pack '${packName}' not found. Available: ${listPacks().join(", ") || "none"}`
    );
  }

  let installed = 0;
  let skipped = 0;

  for (const obs of pack.observations) {
    const result = await saveObservation(db, config, {
      type: obs.type,
      title: obs.title,
      narrative: obs.narrative,
      facts: obs.facts,
      concepts: obs.concepts,
      cwd,
    });

    if (result.success && result.observation_id) {
      installed++;
    } else {
      skipped++;
    }
  }

  return { installed, skipped, total: pack.observations.length };
}
