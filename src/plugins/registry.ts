import { BUILTIN_PLUGIN_MANIFESTS } from "./builtins.js";
import type { EngrmPluginManifest, PluginSurface } from "./types.js";

function isValidPluginId(pluginId: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(pluginId);
}

export function listPluginManifests(surface?: PluginSurface): EngrmPluginManifest[] {
  const manifests = BUILTIN_PLUGIN_MANIFESTS.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (!surface) return manifests;
  return manifests.filter((manifest) => manifest.surfaces.includes(surface));
}

export function getPluginManifest(pluginId: string): EngrmPluginManifest | null {
  return BUILTIN_PLUGIN_MANIFESTS.find((manifest) => manifest.id === pluginId) ?? null;
}

export function validatePluginId(pluginId: string): string | null {
  if (!pluginId || pluginId.trim().length === 0) {
    return "plugin_id is required";
  }
  if (!isValidPluginId(pluginId)) {
    return "plugin_id must be a stable dotted identifier like 'engrm.git-diff'";
  }
  return null;
}

