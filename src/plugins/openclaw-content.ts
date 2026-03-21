import type { PluginObservationType, SavePluginMemoryInput } from "./types.js";

export interface ReduceOpenClawContentInput {
  title?: string;
  posted?: string[];
  researched?: string[];
  outcomes?: string[];
  next_actions?: string[];
  links?: string[];
  session_id?: string;
  cwd?: string;
  agent?: string;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const cleaned = item.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function inferType(input: ReduceOpenClawContentInput): PluginObservationType {
  if ((input.next_actions ?? []).length > 0) return "decision";
  if ((input.researched ?? []).length > 0) return "discovery";
  if ((input.posted ?? []).length > 0 || (input.outcomes ?? []).length > 0) return "change";
  return "message";
}

function inferTitle(input: ReduceOpenClawContentInput): string {
  const explicit = input.title?.trim();
  if (explicit && explicit.length >= 8) return explicit.replace(/\.$/, "");
  const firstPosted = input.posted?.find((item) => item.trim().length > 0);
  if (firstPosted) return firstPosted;
  const firstOutcome = input.outcomes?.find((item) => item.trim().length > 0);
  if (firstOutcome) return firstOutcome;
  const firstResearch = input.researched?.find((item) => item.trim().length > 0);
  if (firstResearch) return firstResearch;
  return "OpenClaw content work";
}

function buildFacts(input: ReduceOpenClawContentInput): string[] {
  const posted = dedupe(input.posted ?? []);
  const researched = dedupe(input.researched ?? []);
  const outcomes = dedupe(input.outcomes ?? []);
  const nextActions = dedupe(input.next_actions ?? []);

  const facts = [
    posted.length > 0 ? `Posted: ${posted.length}` : null,
    researched.length > 0 ? `Researched: ${researched.length}` : null,
    outcomes.length > 0 ? `Outcomes: ${outcomes.length}` : null,
    nextActions.length > 0 ? `Next actions: ${nextActions.length}` : null,
    ...posted.slice(0, 2),
    ...researched.slice(0, 2),
    ...outcomes.slice(0, 2),
    ...nextActions.slice(0, 2),
  ].filter((item): item is string => Boolean(item));

  return dedupe(facts).slice(0, 8);
}

function buildSummary(input: ReduceOpenClawContentInput): string {
  const sections: string[] = [];
  const posted = dedupe(input.posted ?? []);
  const researched = dedupe(input.researched ?? []);
  const outcomes = dedupe(input.outcomes ?? []);
  const nextActions = dedupe(input.next_actions ?? []);

  if (posted.length > 0) {
    sections.push(`Posted:\n${posted.map((item) => `- ${item}`).join("\n")}`);
  }
  if (researched.length > 0) {
    sections.push(`Researched:\n${researched.map((item) => `- ${item}`).join("\n")}`);
  }
  if (outcomes.length > 0) {
    sections.push(`Outcomes:\n${outcomes.map((item) => `- ${item}`).join("\n")}`);
  }
  if (nextActions.length > 0) {
    sections.push(`Next Actions:\n${nextActions.map((item) => `- ${item}`).join("\n")}`);
  }

  return sections.join("\n\n") || "Reduced OpenClaw content activity into reusable memory.";
}

export function reduceOpenClawContentToMemory(
  input: ReduceOpenClawContentInput
): SavePluginMemoryInput {
  const links = dedupe(input.links ?? []);
  const posted = dedupe(input.posted ?? []);
  const researched = dedupe(input.researched ?? []);
  const outcomes = dedupe(input.outcomes ?? []);
  const nextActions = dedupe(input.next_actions ?? []);

  return {
    plugin_id: "engrm.openclaw-content",
    type: inferType(input),
    title: inferTitle(input),
    summary: buildSummary(input),
    facts: buildFacts(input),
    tags: dedupe([
      "openclaw-content",
      posted.length > 0 ? "posted" : "",
      researched.length > 0 ? "researched" : "",
      outcomes.length > 0 ? "outcomes" : "",
      nextActions.length > 0 ? "next-actions" : "",
    ]),
    source: "openclaw",
    source_refs: links.map((value) => ({ kind: "thread" as const, value })),
    surfaces: ["briefs", "startup", "insights"],
    session_id: input.session_id,
    cwd: input.cwd,
    agent: input.agent,
  };
}
