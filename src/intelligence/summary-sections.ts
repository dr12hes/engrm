export function extractSummaryItems(section: string | null | undefined, limit?: number): string[] {
  if (!section || !section.trim()) return [];

  const rawLines = section
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const items: string[] = [];
  const seen = new Set<string>();
  let heading: string | null = null;

  for (const rawLine of rawLines) {
    const line = stripSectionPrefix(rawLine);
    if (!line) continue;

    const headingOnly = parseHeading(line);
    if (headingOnly) {
      heading = headingOnly;
      continue;
    }

    const isBullet = /^[-*•]\s+/.test(line);
    const stripped = line.replace(/^[-*•]\s+/, "").trim();
    if (!stripped) continue;

    const item = heading && isBullet
      ? `${heading}: ${stripped}`
      : stripped;
    const normalized = normalizeItem(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(item);

    if (limit && items.length >= limit) break;
  }

  return items;
}

export function formatSummaryItems(section: string | null | undefined, maxLen: number): string | null {
  const items = extractSummaryItems(section);
  if (items.length === 0) return null;
  const cleaned = items.map((item) => `- ${item}`).join("\n");
  if (cleaned.length <= maxLen) return cleaned;
  const truncated = cleaned.slice(0, maxLen).trimEnd();
  const lastBreak = Math.max(truncated.lastIndexOf("\n"), truncated.lastIndexOf(" "));
  const safe = lastBreak > maxLen * 0.5 ? truncated.slice(0, lastBreak) : truncated;
  return `${safe.trimEnd()}…`;
}

function stripSectionPrefix(value: string): string {
  return value
    .replace(/^(request|investigated|learned|completed|next steps|summary):\s*/i, "")
    .trim();
}

function parseHeading(value: string): string | null {
  const boldMatch = value.match(/^\*{1,2}\s*(.+?)\s*:\*{1,2}$/);
  if (boldMatch?.[1]) {
    return boldMatch[1].trim().replace(/\s+/g, " ");
  }
  const plainMatch = value.match(/^(.+?):$/);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim().replace(/\s+/g, " ");
  }
  return null;
}

function normalizeItem(value: string): string {
  return value
    .toLowerCase()
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
