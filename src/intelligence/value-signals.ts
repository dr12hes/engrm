import type { ObservationRow, SecurityFindingRow } from "../storage/sqlite.js";

export interface SessionValueSignals {
  decisions_count: number;
  lessons_count: number;
  discoveries_count: number;
  features_count: number;
  refactors_count: number;
  repeated_patterns_count: number;
  security_findings_count: number;
  critical_security_findings_count: number;
  delivery_review_ready: boolean;
  vibe_guardian_active: boolean;
}

const LESSON_TYPES = new Set(["bugfix", "decision", "pattern"]);

export function computeSessionValueSignals(
  observations: ObservationRow[],
  securityFindings: SecurityFindingRow[] = []
): SessionValueSignals {
  const decisionsCount = observations.filter((o) => o.type === "decision").length;
  const lessonsCount = observations.filter((o) => LESSON_TYPES.has(o.type)).length;
  const discoveriesCount = observations.filter((o) => o.type === "discovery").length;
  const featuresCount = observations.filter((o) => o.type === "feature").length;
  const refactorsCount = observations.filter((o) => o.type === "refactor").length;
  const repeatedPatternsCount = observations.filter((o) => o.type === "pattern").length;

  const hasRequestSignal = observations.some((o) =>
    ["feature", "decision", "change", "bugfix", "discovery"].includes(o.type)
  );
  const hasCompletionSignal = observations.some((o) =>
    ["feature", "change", "refactor", "bugfix"].includes(o.type)
  );

  return {
    decisions_count: decisionsCount,
    lessons_count: lessonsCount,
    discoveries_count: discoveriesCount,
    features_count: featuresCount,
    refactors_count: refactorsCount,
    repeated_patterns_count: repeatedPatternsCount,
    security_findings_count: securityFindings.length,
    critical_security_findings_count: securityFindings.filter((f) => f.severity === "critical").length,
    delivery_review_ready: hasRequestSignal && hasCompletionSignal,
    vibe_guardian_active: securityFindings.length > 0,
  };
}
