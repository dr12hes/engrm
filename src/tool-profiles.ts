import type { ToolProfile } from "./config.js";

export const MEMORY_PROFILE_TOOLS = [
  "save_observation",
  "search_recall",
  "resume_thread",
  "list_recall_items",
  "load_recall_item",
  "recent_chat",
  "search_chat",
  "refresh_chat_recall",
  "repair_recall",
] as const;

export function getEnabledToolNames(
  profile: ToolProfile | undefined
): Set<string> | null {
  if (!profile || profile === "full") return null;
  return new Set(MEMORY_PROFILE_TOOLS);
}

export function isToolEnabled(
  profile: ToolProfile | undefined,
  toolName: string
): boolean {
  const enabled = getEnabledToolNames(profile);
  if (!enabled) return true;
  return enabled.has(toolName);
}
