import type { Config } from "../config.js";
import type { MemDatabase } from "../storage/sqlite.js";
import { saveObservation, type SaveObservationResult } from "../tools/save.js";
import { getPluginManifest, validatePluginId } from "./registry.js";
import type { PluginSurface, SavePluginMemoryInput } from "./types.js";

function normalizeSurfaceTags(surfaces?: PluginSurface[]): string[] {
  return (surfaces ?? []).map((surface) => `surface:${surface}`);
}

function normalizeSourceRefFacts(input: SavePluginMemoryInput): string[] {
  return (input.source_refs ?? [])
    .map((ref) => ref.value.trim().length > 0 ? `${ref.kind}: ${ref.value.trim()}` : null)
    .filter((value): value is string => value !== null);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export async function savePluginMemory(
  db: MemDatabase,
  config: Config,
  input: SavePluginMemoryInput
): Promise<SaveObservationResult> {
  const pluginIdError = validatePluginId(input.plugin_id);
  if (pluginIdError) {
    return { success: false, reason: pluginIdError };
  }

  const manifest = getPluginManifest(input.plugin_id);
  if (manifest && !manifest.produces.includes(input.type)) {
    return {
      success: false,
      reason: `Plugin '${input.plugin_id}' does not declare type '${input.type}'`,
    };
  }

  const concepts = dedupe([
    ...(input.tags ?? []),
    `plugin:${input.plugin_id}`,
    ...(input.source ? [`source:${input.source}`] : []),
    ...normalizeSurfaceTags(input.surfaces),
  ]);

  const facts = dedupe([
    ...(input.facts ?? []),
    ...normalizeSourceRefFacts(input),
  ]);

  return saveObservation(db, config, {
    type: input.type,
    title: input.title,
    narrative: input.summary,
    facts: facts.length > 0 ? facts : undefined,
    concepts: concepts.length > 0 ? concepts : undefined,
    files_read: input.files_read,
    files_modified: input.files_modified,
    sensitivity: input.sensitivity,
    session_id: input.session_id,
    cwd: input.cwd,
    agent: input.agent,
  });
}

