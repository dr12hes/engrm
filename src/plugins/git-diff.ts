import type { PluginObservationType, SavePluginMemoryInput } from "./types.js";

export interface ReduceGitDiffInput {
  diff: string;
  summary?: string;
  files?: string[];
  session_id?: string;
  cwd?: string;
  agent?: string;
}

const BUGFIX_HINTS = [
  "fix",
  "bug",
  "error",
  "fail",
  "failing",
  "prevent",
  "guard",
  "retry",
  "regression",
  "patch",
];

const FEATURE_HINTS = [
  "add",
  "added",
  "introduce",
  "enable",
  "support",
  "create",
  "new",
];

const DECISION_HINTS = [
  "choose",
  "switch",
  "prefer",
  "standardize",
  "adopt",
  "migrate",
];

const REFACTOR_HINTS = [
  "refactor",
  "rename",
  "restructure",
  "cleanup",
  "extract",
  "move",
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const cleaned = item.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function extractChangedFiles(diff: string): string[] {
  const matches = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  if (matches.length === 0) return [];
  return uniq(matches.map((match) => match[2] ?? match[1] ?? "").filter(Boolean)).slice(0, 6);
}

function countLinesByPrefix(diff: string, prefix: "+" | "-"): number {
  return diff
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}

function detectType(summary: string | undefined, diff: string, files: string[]): PluginObservationType {
  const corpus = normalize([summary ?? "", diff, files.join(" ")].join(" "));

  if (BUGFIX_HINTS.some((hint) => corpus.includes(hint))) return "bugfix";
  if (DECISION_HINTS.some((hint) => corpus.includes(hint))) return "decision";
  if (REFACTOR_HINTS.some((hint) => corpus.includes(hint))) return "refactor";
  if (FEATURE_HINTS.some((hint) => corpus.includes(hint))) return "feature";

  const addedFiles = diff.match(/^new file mode /gm)?.length ?? 0;
  const renamedFiles = diff.match(/^rename (from|to) /gm)?.length ?? 0;
  if (renamedFiles > 0) return "refactor";
  if (addedFiles > 0) return "feature";

  return "change";
}

function inferTitle(type: PluginObservationType, summary: string | undefined, files: string[]): string {
  const cleanedSummary = summary?.trim();
  if (cleanedSummary && cleanedSummary.length >= 8) {
    return cleanedSummary.replace(/\.$/, "");
  }

  const leadFile = files[0];
  if (leadFile) {
    switch (type) {
      case "bugfix":
        return `Fix changes in ${leadFile}`;
      case "feature":
        return `Add capability in ${leadFile}`;
      case "decision":
        return `Decision recorded in ${leadFile}`;
      case "refactor":
        return `Refactor ${leadFile}`;
      default:
        return `Update ${leadFile}`;
    }
  }

  switch (type) {
    case "bugfix":
      return "Fix repository changes";
    case "feature":
      return "Add repository capability";
    case "decision":
      return "Record implementation decision";
    case "refactor":
      return "Refactor repository structure";
    default:
      return "Update repository changes";
  }
}

function buildFacts(diff: string, files: string[]): string[] {
  const added = countLinesByPrefix(diff, "+");
  const removed = countLinesByPrefix(diff, "-");
  const facts: string[] = [];

  if (files.length > 0) {
    facts.push(
      files.length === 1
        ? `Touched ${files[0]}`
        : `Touched ${files.slice(0, 4).join(", ")}`
    );
  }

  if (added > 0 || removed > 0) {
    facts.push(`Diff footprint: +${added} / -${removed}`);
  }

  const lower = normalize(diff);
  if (lower.includes("auth") || lower.includes("token") || lower.includes("oauth")) {
    facts.push("Touches authentication or credential flow");
  }
  if (lower.includes("sql") || lower.includes("query") || lower.includes("database")) {
    facts.push("Touches data access or query flow");
  }
  if (lower.includes("api") || lower.includes("route") || lower.includes("endpoint")) {
    facts.push("Touches API or routing behavior");
  }
  if (lower.includes("test(") || lower.includes("describe(") || files.some((file) => file.includes(".test.") || file.includes(".spec."))) {
    facts.push("Includes test coverage changes");
  }

  return uniq(facts).slice(0, 4);
}

function buildSummary(type: PluginObservationType, files: string[], diff: string): string {
  const added = countLinesByPrefix(diff, "+");
  const removed = countLinesByPrefix(diff, "-");
  const fileLabel = files.length > 0 ? files.slice(0, 4).join(", ") : "repository files";

  switch (type) {
    case "bugfix":
      return `Reduced a git diff into a bugfix memory object covering ${fileLabel} with a footprint of +${added} / -${removed}.`;
    case "feature":
      return `Reduced a git diff into a feature memory object covering ${fileLabel} with a footprint of +${added} / -${removed}.`;
    case "decision":
      return `Reduced a git diff into a decision memory object covering ${fileLabel} with a footprint of +${added} / -${removed}.`;
    case "refactor":
      return `Reduced a git diff into a refactor memory object covering ${fileLabel} with a footprint of +${added} / -${removed}.`;
    default:
      return `Reduced a git diff into a reusable change memory object covering ${fileLabel} with a footprint of +${added} / -${removed}.`;
  }
}

export function reduceGitDiffToMemory(input: ReduceGitDiffInput): SavePluginMemoryInput {
  const diff = input.diff.trim();
  const files = uniq([...(input.files ?? []), ...extractChangedFiles(diff)]).slice(0, 6);
  const type = detectType(input.summary, diff, files);
  const title = inferTitle(type, input.summary, files);
  const facts = buildFacts(diff, files);

  return {
    plugin_id: "engrm.git-diff",
    type,
    title,
    summary: buildSummary(type, files, diff),
    facts,
    tags: ["git-diff"],
    source: "git",
    source_refs: files.map((file) => ({ kind: "file" as const, value: file })),
    surfaces: ["startup", "briefs", "delivery_review", "insights"],
    files_modified: files,
    session_id: input.session_id,
    cwd: input.cwd,
    agent: input.agent,
  };
}

