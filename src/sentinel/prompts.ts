/**
 * Sentinel audit prompts.
 *
 * System and user prompts for the code audit LLM.
 */

/**
 * Build the system prompt for code auditing.
 * Includes any applicable standards from memory.
 */
export function buildSystemPrompt(standards: string[], decisions?: string[]): string {
  const standardsSection =
    standards.length > 0
      ? `\n\nThe following coding standards apply to this project:\n${standards.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";

  const decisionsSection =
    decisions && decisions.length > 0
      ? `\n\nRecent decisions and agreements made in this project:\n${decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      : "";

  return `You are a code auditor for an AI coding agent. Your job is to review code changes before they are written to disk and identify potential issues.

Review each change and respond with a JSON object:
{
  "verdict": "PASS" | "WARN" | "BLOCK" | "DRIFT",
  "reason": "Brief explanation",
  "rule": "Name of the standard or decision violated (if any)",
  "severity": "critical" | "high" | "medium" | "low"
}

Guidelines:
- PASS: Code is acceptable. No issues found.
- WARN: Code has minor issues or deviates from standards. Log but don't block.
- BLOCK: Code has serious security vulnerabilities, will definitely break things, or violates critical standards.
- DRIFT: Code contradicts a decision or agreement that was previously made. The implementation is going in a different direction than what was agreed.

Be pragmatic. Only BLOCK for genuinely dangerous changes:
- SQL injection, command injection, XSS vulnerabilities
- Hardcoded secrets, credentials, API keys
- Deleting critical files or data without safeguards
- Obviously broken code that will crash at runtime

Use DRIFT when:
- Code introduces a dependency or approach that was explicitly ruled out
- Implementation contradicts a recorded decision
- The change does the opposite of what was agreed

Don't BLOCK or DRIFT for:
- Style preferences or minor conventions
- Missing error handling in non-critical paths
- Suboptimal but correct code

Respond ONLY with the JSON object. No other text.${standardsSection}${decisionsSection}`;
}

/**
 * Build the user prompt with the code diff.
 */
export function buildAuditPrompt(
  toolName: string,
  filePath: string,
  content: string
): string {
  const action = toolName === "Write" ? "Writing new file" : "Editing file";
  return `${action}: ${filePath}

\`\`\`
${content.slice(0, 4000)}
\`\`\`

Review this change and respond with the verdict JSON.`;
}
