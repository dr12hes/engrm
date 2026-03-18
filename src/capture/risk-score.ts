/**
 * Session risk score calculator.
 *
 * Computes a 0-100 risk score for a coding session based on:
 *   - Security findings (weighted by severity)
 *   - Files modified without corresponding test files
 *   - Decisions made without narrative (unclear rationale)
 *
 * Score interpretation:
 *   0-25:  Low risk (green)
 *   26-50: Moderate risk (yellow)
 *   51-75: High risk (orange)
 *   76-100: Critical risk (red)
 */

import type { ObservationRow, SecurityFindingRow } from "../storage/sqlite.js";

export interface RiskInput {
  observations: ObservationRow[];
  securityFindings: SecurityFindingRow[];
  filesTouchedCount: number;
  toolCallsCount: number;
}

export interface RiskResult {
  score: number;
  level: "low" | "moderate" | "high" | "critical";
  breakdown: {
    security: number;
    untested: number;
    unclear_decisions: number;
  };
}

// Severity weights for security findings
const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
};

/**
 * Compute a risk score for a session.
 */
export function computeRiskScore(input: RiskInput): RiskResult {
  const { observations, securityFindings, filesTouchedCount } = input;

  // --- Security component (0-50 max) ---
  let securityScore = 0;
  for (const finding of securityFindings) {
    securityScore += SEVERITY_WEIGHT[finding.severity] ?? 5;
  }
  securityScore = Math.min(50, securityScore);

  // --- Untested changes component (0-30 max) ---
  // Check if modified files have corresponding test modifications
  const modifiedFiles = new Set<string>();
  const testFiles = new Set<string>();
  for (const obs of observations) {
    if (obs.files_modified) {
      try {
        const files = JSON.parse(obs.files_modified) as string[];
        for (const f of files) {
          if (isTestFile(f)) {
            testFiles.add(f);
          } else {
            modifiedFiles.add(f);
          }
        }
      } catch {
        // malformed JSON
      }
    }
  }

  const untestedFiles = [...modifiedFiles].filter(
    (f) => !hasCorrespondingTest(f, testFiles)
  );
  const untestedRatio =
    modifiedFiles.size > 0 ? untestedFiles.length / modifiedFiles.size : 0;
  const untestedScore = Math.min(30, Math.round(untestedRatio * 30));

  // --- Unclear decisions component (0-20 max) ---
  const decisions = observations.filter((o) => o.type === "decision");
  const unclearDecisions = decisions.filter(
    (d) => !d.narrative || d.narrative.trim().length < 20
  );
  const unclearRatio =
    decisions.length > 0 ? unclearDecisions.length / decisions.length : 0;
  const unclearScore = Math.min(20, Math.round(unclearRatio * 20));

  const total = Math.min(100, securityScore + untestedScore + unclearScore);

  return {
    score: total,
    level: scoreToLevel(total),
    breakdown: {
      security: securityScore,
      untested: untestedScore,
      unclear_decisions: unclearScore,
    },
  };
}

function scoreToLevel(
  score: number
): "low" | "moderate" | "high" | "critical" {
  if (score <= 25) return "low";
  if (score <= 50) return "moderate";
  if (score <= 75) return "high";
  return "critical";
}

function isTestFile(path: string): boolean {
  return /\.(test|spec|_test)\.(ts|tsx|js|jsx|py|go|rs)$/.test(path) ||
    path.includes("__tests__/") ||
    path.includes("/test/") ||
    path.includes("/tests/");
}

function hasCorrespondingTest(file: string, testFiles: Set<string>): boolean {
  // Check if any test file matches this source file
  const base = file.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "");
  for (const t of testFiles) {
    if (t.includes(base)) return true;
  }
  return false;
}

/**
 * Format risk score as a traffic light for terminal output.
 */
export function formatRiskTrafficLight(result: RiskResult): string {
  const icons: Record<string, string> = {
    low: "🟢",
    moderate: "🟡",
    high: "🟠",
    critical: "🔴",
  };
  const icon = icons[result.level] ?? "⚪";
  return `${icon} Risk: ${result.score}/100 (${result.level})`;
}
