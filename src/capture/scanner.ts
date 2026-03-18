/**
 * L1 regex-based secret scanner.
 *
 * Reuses the same pattern definitions from scrubber.ts but instead of
 * replacing secrets, it detects and reports them as security findings.
 * The snippet is redacted to avoid storing the actual secret.
 */

import { DEFAULT_PATTERNS, type ScrubPatternDef } from "./scrubber.js";

export interface SecurityFinding {
  finding_type: string;
  severity: string;
  pattern_name: string;
  snippet: string;
}

/**
 * Scan text for secrets using scrubber patterns.
 * Returns findings with redacted context snippets.
 */
export function scanForSecrets(
  text: string,
  customPatterns: string[] = []
): SecurityFinding[] {
  if (!text) return [];

  const allPatterns: ScrubPatternDef[] = [
    ...DEFAULT_PATTERNS,
    ...compileCustomScanPatterns(customPatterns),
  ];

  const findings: SecurityFinding[] = [];

  for (const pattern of allPatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const snippet = buildRedactedSnippet(text, match.index, match[0].length, pattern.replacement);
      findings.push({
        finding_type: pattern.category,
        severity: pattern.severity,
        pattern_name: pattern.description,
        snippet,
      });

      // Avoid infinite loop on zero-length matches
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }
  }

  return findings;
}

/**
 * Build a context snippet around a match, replacing the actual secret
 * with the redacted placeholder.
 */
function buildRedactedSnippet(
  text: string,
  matchStart: number,
  matchLength: number,
  replacement: string
): string {
  const CONTEXT_CHARS = 30;
  const start = Math.max(0, matchStart - CONTEXT_CHARS);
  const end = Math.min(text.length, matchStart + matchLength + CONTEXT_CHARS);

  const before = text.slice(start, matchStart);
  const after = text.slice(matchStart + matchLength, end);

  let snippet = before + replacement + after;
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  return snippet;
}

function compileCustomScanPatterns(patterns: string[]): ScrubPatternDef[] {
  const compiled: ScrubPatternDef[] = [];
  for (const pattern of patterns) {
    try {
      new RegExp(pattern);
      compiled.push({
        source: pattern,
        flags: "g",
        replacement: "[REDACTED_CUSTOM]",
        description: `Custom pattern: ${pattern}`,
        category: "custom",
        severity: "medium",
      });
    } catch {
      // Skip invalid regex
    }
  }
  return compiled;
}
