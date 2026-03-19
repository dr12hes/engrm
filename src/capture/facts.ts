export interface StructuredFactInput {
  type: string;
  title: string;
  narrative?: string | null;
  facts?: string[];
  filesModified?: string[] | null;
}

const FACT_ELIGIBLE_TYPES = new Set([
  "bugfix",
  "decision",
  "discovery",
  "pattern",
  "feature",
  "refactor",
  "change",
]);

export function buildStructuredFacts(input: StructuredFactInput): string[] {
  const seedFacts = dedupeFacts(input.facts ?? []);
  if (!FACT_ELIGIBLE_TYPES.has(input.type)) {
    return seedFacts;
  }

  const derived: string[] = [...seedFacts];

  if (seedFacts.length === 0 && looksMeaningful(input.title)) {
    derived.push(input.title.trim());
  }

  for (const sentence of extractNarrativeFacts(input.narrative)) {
    derived.push(sentence);
  }

  const fileFact = buildFilesFact(input.filesModified);
  if (fileFact) {
    derived.push(fileFact);
  }

  return dedupeFacts(derived).slice(0, 4);
}

function extractNarrativeFacts(narrative: string | null | undefined): string[] {
  if (!narrative) return [];

  const cleaned = narrative
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 24) return [];

  const parts = cleaned
    .split(/(?<=[.!?;])\s+/)
    .map((part) => part.trim().replace(/[.!?;]+$/, ""))
    .filter(Boolean)
    .filter(looksMeaningful);

  return parts.slice(0, 2);
}

function buildFilesFact(filesModified: string[] | null | undefined): string | null {
  if (!filesModified || filesModified.length === 0) return null;

  const cleaned = filesModified
    .map((file) => file.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) {
    return `Touched ${cleaned[0]}`;
  }
  return `Touched ${cleaned.join(", ")}`;
}

function dedupeFacts(facts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fact of facts) {
    const cleaned = fact.trim().replace(/\s+/g, " ");
    if (!looksMeaningful(cleaned)) continue;
    const key = cleaned
      .toLowerCase()
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function looksMeaningful(value: string): boolean {
  const cleaned = value.trim();
  if (cleaned.length < 12) return false;
  if (/^[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]+$/.test(cleaned)) return false;
  if (/^(updated|modified|edited|changed|touched)\s+[A-Za-z0-9_.\-\/]+$/i.test(cleaned)) return false;
  return true;
}
