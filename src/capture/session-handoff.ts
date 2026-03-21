import type {
  ObservationRow,
  ToolEventRow,
  UserPromptRow,
} from "../storage/sqlite.js";

export interface SessionHandoffMetadata {
  prompt_count: number;
  tool_event_count: number;
  recent_request_prompts: string[];
  latest_request: string | null;
  current_thread: string | null;
  recent_tool_names: string[];
  recent_tool_commands: string[];
  capture_state: "rich" | "partial" | "summary-only";
  hot_files: string[];
  recent_outcomes: string[];
  observation_source_tools: Array<{ tool: string; count: number }>;
  latest_observation_prompt_number: number | null;
}

export function buildSessionHandoffMetadata(
  prompts: UserPromptRow[],
  toolEvents: ToolEventRow[],
  observations: ObservationRow[]
): SessionHandoffMetadata {
  const latestRequest = prompts.length > 0
    ? prompts[prompts.length - 1]?.prompt ?? null
    : null;

  const recentRequestPrompts = prompts
    .slice(-3)
    .map((prompt) => prompt.prompt.trim())
    .filter(Boolean);

  const recentToolNames = [...new Set(
    toolEvents
      .slice(-8)
      .map((tool) => tool.tool_name)
      .filter(Boolean)
  )];

  const recentToolCommands = [...new Set(
    toolEvents
      .slice(-5)
      .map((tool) => (tool.command ?? tool.file_path ?? "").trim())
      .filter(Boolean)
  )];

  const hotFiles = [...new Set(
    observations
      .flatMap((obs) => [
        ...parseJsonArray(obs.files_modified),
        ...parseJsonArray(obs.files_read),
      ])
      .filter(Boolean)
  )].slice(0, 6);

  const recentOutcomes = observations
    .filter((obs) => ["bugfix", "feature", "refactor", "change", "decision"].includes(obs.type))
    .map((obs) => obs.title.trim())
    .filter((title) => title.length > 0)
    .slice(0, 6);

  const captureState: SessionHandoffMetadata["capture_state"] =
    prompts.length > 0 && toolEvents.length > 0
      ? "rich"
      : prompts.length > 0 || toolEvents.length > 0
        ? "partial"
        : "summary-only";

  const observationSourceTools = Array.from(
    observations.reduce((acc, obs) => {
      if (!obs.source_tool) return acc;
      acc.set(obs.source_tool, (acc.get(obs.source_tool) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()).entries()
  )
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, 6);

  const latestObservationPromptNumber = observations
    .map((obs) => obs.source_prompt_number)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => b - a)[0] ?? null;

  const currentThread = buildCurrentThread(
    latestRequest,
    recentOutcomes,
    hotFiles,
    recentToolNames
  );

  return {
    prompt_count: prompts.length,
    tool_event_count: toolEvents.length,
    recent_request_prompts: recentRequestPrompts,
    latest_request: latestRequest,
    current_thread: currentThread,
    recent_tool_names: recentToolNames,
    recent_tool_commands: recentToolCommands,
    capture_state: captureState,
    hot_files: hotFiles,
    recent_outcomes: recentOutcomes,
    observation_source_tools: observationSourceTools,
    latest_observation_prompt_number: latestObservationPromptNumber,
  };
}

function buildCurrentThread(
  latestRequest: string | null,
  recentOutcomes: string[],
  hotFiles: string[],
  recentToolNames: string[]
): string | null {
  const request = compactLine(latestRequest);
  const outcome = recentOutcomes
    .map((item) => compactLine(item))
    .find(Boolean);
  const file = hotFiles[0] ? compactFileHint(hotFiles[0]) : null;
  const tools = recentToolNames.slice(0, 2).join("/");

  if (outcome && file) {
    return `${outcome} · ${file}${tools ? ` · ${tools}` : ""}`;
  }
  if (request && file) {
    return `${request} · ${file}${tools ? ` · ${tools}` : ""}`;
  }
  if (outcome) {
    return `${outcome}${tools ? ` · ${tools}` : ""}`;
  }
  if (request) {
    return `${request}${tools ? ` · ${tools}` : ""}`;
  }
  return null;
}

function compactLine(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function compactFileHint(value: string): string {
  const parts = value.split("/");
  if (parts.length <= 2) return value;
  return parts.slice(-2).join("/");
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}
