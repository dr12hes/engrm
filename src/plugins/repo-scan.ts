import type { PluginObservationType, SavePluginMemoryInput } from "./types.js";

export interface RepoScanFinding {
  kind: "risk" | "discovery" | "pattern" | "change";
  title: string;
  detail?: string;
  severity?: "critical" | "high" | "medium" | "low";
  file?: string;
}

export interface ReduceRepoScanInput {
  summary?: string;
  findings: RepoScanFinding[];
  session_id?: string;
  cwd?: string;
  agent?: string;
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

function countByKind(findings: RepoScanFinding[]): Record<RepoScanFinding["kind"], number> {
  return findings.reduce(
    (acc, finding) => {
      acc[finding.kind] += 1;
      return acc;
    },
    { risk: 0, discovery: 0, pattern: 0, change: 0 }
  );
}

function inferType(findings: RepoScanFinding[]): PluginObservationType {
  if (findings.some((finding) => finding.kind === "risk")) return "pattern";
  if (findings.some((finding) => finding.kind === "discovery")) return "discovery";
  return "change";
}

function inferTitle(summary: string | undefined, findings: RepoScanFinding[]): string {
  const cleanedSummary = summary?.trim();
  if (cleanedSummary && cleanedSummary.length >= 8) {
    return cleanedSummary.replace(/\.$/, "");
  }

  const firstRisk = findings.find((finding) => finding.kind === "risk");
  if (firstRisk) {
    return `Repo scan: ${firstRisk.title}`;
  }

  const firstDiscovery = findings.find((finding) => finding.kind === "discovery");
  if (firstDiscovery) {
    return `Repo scan: ${firstDiscovery.title}`;
  }

  return "Repo scan findings";
}

function buildFacts(findings: RepoScanFinding[]): string[] {
  const facts: string[] = [];
  const counts = countByKind(findings);

  facts.push(
    `Repo scan findings: ${counts.risk} risks, ${counts.discovery} discoveries, ${counts.pattern} patterns, ${counts.change} changes`
  );

  for (const finding of findings.slice(0, 3)) {
    const severity = finding.severity ? `${finding.severity} ` : "";
    const file = finding.file ? ` (${finding.file})` : "";
    facts.push(`${severity}${finding.title}${file}`.trim());
  }

  return uniq(facts).slice(0, 4);
}

function buildTags(findings: RepoScanFinding[]): string[] {
  const tags = ["repo-scan"];

  if (findings.some((finding) => finding.kind === "risk")) tags.push("risk-finding");
  if (findings.some((finding) => finding.kind === "discovery")) tags.push("discovery");
  if (findings.some((finding) => finding.kind === "pattern")) tags.push("pattern");

  for (const severity of ["critical", "high", "medium", "low"] as const) {
    if (findings.some((finding) => finding.severity === severity)) {
      tags.push(`severity:${severity}`);
    }
  }

  return uniq(tags);
}

function buildSummary(summary: string | undefined, findings: RepoScanFinding[]): string {
  if (summary && summary.trim().length >= 16) {
    return summary.trim();
  }

  const counts = countByKind(findings);
  return (
    `Reduced a repository scan into reusable memory with ` +
    `${counts.risk} risks, ${counts.discovery} discoveries, ` +
    `${counts.pattern} patterns, and ${counts.change} changes.`
  );
}

export function reduceRepoScanToMemory(input: ReduceRepoScanInput): SavePluginMemoryInput {
  const findings = input.findings.filter((finding) => finding.title.trim().length > 0);
  const files = uniq(findings.map((finding) => finding.file ?? "").filter(Boolean)).slice(0, 6);

  return {
    plugin_id: "engrm.repo-scan",
    type: inferType(findings),
    title: inferTitle(input.summary, findings),
    summary: buildSummary(input.summary, findings),
    facts: buildFacts(findings),
    tags: buildTags(findings),
    source: "repo-scan",
    source_refs: files.map((file) => ({ kind: "file" as const, value: file })),
    surfaces: ["startup", "briefs", "sentinel", "insights"],
    files_read: files,
    session_id: input.session_id,
    cwd: input.cwd,
    agent: input.agent,
  };
}

