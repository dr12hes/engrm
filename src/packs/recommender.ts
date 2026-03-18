/**
 * Pack recommender — maps detected stacks to available help packs.
 *
 * Packs are JSON files in the `packs/` directory containing pre-curated
 * observations for common technology stacks.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackRecommendation {
  name: string;
  description: string;
  observationCount: number;
  matchedStacks: string[];
}

export interface PackManifest {
  name: string;
  description: string;
  version?: string;
  stacks?: string[];
  observations: PackObservation[];
}

export interface PackObservation {
  type: string;
  title: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
}

/** Stack → pack name mapping */
const STACK_PACK_MAP: Record<string, string[]> = {
  typescript: ["typescript-patterns"],
  react: ["react-gotchas"],
  nextjs: ["nextjs-patterns"],
  python: ["python-django"],
  django: ["python-django"],
  javascript: ["node-security"],
  bun: ["node-security"],
};

/**
 * Get the directory containing pack JSON files.
 */
function getPacksDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "../../packs");
}

/**
 * List all available pack names (from JSON files in packs/).
 */
export function listAvailablePacks(): string[] {
  const dir = getPacksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"));
}

/**
 * Load a pack manifest from disk.
 */
export function loadPack(name: string): PackManifest | null {
  const packPath = join(getPacksDir(), `${name}.json`);
  if (!existsSync(packPath)) return null;
  try {
    const raw = readFileSync(packPath, "utf-8");
    return JSON.parse(raw) as PackManifest;
  } catch {
    return null;
  }
}

/**
 * Recommend packs based on detected stacks, filtering out already-installed ones.
 */
export function recommendPacks(
  stacks: string[],
  installedPacks: string[]
): PackRecommendation[] {
  const installed = new Set(installedPacks);
  const available = listAvailablePacks();
  const availableSet = new Set(available);
  const seen = new Set<string>();
  const recommendations: PackRecommendation[] = [];

  for (const stack of stacks) {
    const packNames = STACK_PACK_MAP[stack] ?? [];
    for (const packName of packNames) {
      if (seen.has(packName) || installed.has(packName) || !availableSet.has(packName)) {
        continue;
      }
      seen.add(packName);

      const pack = loadPack(packName);
      if (!pack) continue;

      // Find all stacks this pack matches
      const matchedStacks = stacks.filter(
        (s) => STACK_PACK_MAP[s]?.includes(packName)
      );

      recommendations.push({
        name: packName,
        description: pack.description,
        observationCount: pack.observations.length,
        matchedStacks,
      });
    }
  }

  return recommendations;
}
