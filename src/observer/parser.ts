/**
 * Parse XML observations from the observer agent's response.
 *
 * The observer responds with either:
 *   <observation>...</observation>  — a meaningful observation
 *   <skip/>                        — event was trivial/noise
 */

export interface ParsedObservation {
  type: string;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
}

/**
 * Parse an observation from the observer's XML response.
 * Returns null if the response is a <skip/> or unparseable.
 */
export function parseObservationXml(text: string): ParsedObservation | null {
  // Check for skip
  if (/<skip\s*\/?>/i.test(text)) {
    return null;
  }

  // Extract <observation>...</observation>
  const obsMatch = text.match(/<observation>([\s\S]*?)<\/observation>/i);
  if (!obsMatch) return null;

  const inner = obsMatch[1]!;

  const type = extractTag(inner, "type");
  const title = extractTag(inner, "title");
  const narrative = extractTag(inner, "narrative");

  if (!type || !title) return null;

  const facts = extractTags(inner, "fact");
  const concepts = extractTags(inner, "concept");

  return {
    type: type.toLowerCase().trim(),
    title: title.trim(),
    narrative: (narrative ?? "").trim(),
    facts,
    concepts,
  };
}

/**
 * Extract the content of a single XML tag.
 */
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1]!.trim() : null;
}

/**
 * Extract all instances of a repeated XML tag.
 */
function extractTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const value = match[1]!.trim();
    if (value.length > 0) {
      results.push(value);
    }
  }
  return results;
}
