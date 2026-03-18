import { describe, test, expect } from "bun:test";
import { computeRiskScore, formatRiskTrafficLight } from "./risk-score.js";
import type { ObservationRow, SecurityFindingRow } from "../storage/sqlite.js";

function makeObs(overrides: Partial<ObservationRow> = {}): ObservationRow {
  return {
    id: 1,
    session_id: "s1",
    project_id: 1,
    type: "change",
    title: "test",
    narrative: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    quality: 0.5,
    lifecycle: "active",
    sensitivity: "shared",
    user_id: "u1",
    device_id: "d1",
    agent: "claude-code",
    created_at: "2026-01-01T00:00:00.000Z",
    created_at_epoch: 1735689600,
    archived_at_epoch: null,
    compacted_into: null,
    superseded_by: null,
    remote_source_id: null,
    ...overrides,
  };
}

function makeFinding(severity: string): SecurityFindingRow {
  return {
    id: 1,
    session_id: "s1",
    project_id: 1,
    finding_type: "secret_detected",
    severity,
    pattern_name: "test",
    file_path: null,
    snippet: null,
    tool_name: "Edit",
    user_id: "u1",
    device_id: "d1",
    created_at_epoch: 1735689600,
  };
}

describe("risk score", () => {
  test("clean session has zero risk", () => {
    const result = computeRiskScore({
      observations: [],
      securityFindings: [],
      filesTouchedCount: 0,
      toolCallsCount: 0,
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe("low");
  });

  test("security findings increase score", () => {
    const result = computeRiskScore({
      observations: [],
      securityFindings: [makeFinding("critical"), makeFinding("high")],
      filesTouchedCount: 5,
      toolCallsCount: 10,
    });
    expect(result.breakdown.security).toBe(40); // 25 + 15
    expect(result.score).toBeGreaterThanOrEqual(40);
  });

  test("untested files increase score", () => {
    const obs = makeObs({
      files_modified: JSON.stringify(["src/main.ts", "src/utils.ts"]),
    });
    const result = computeRiskScore({
      observations: [obs],
      securityFindings: [],
      filesTouchedCount: 2,
      toolCallsCount: 5,
    });
    expect(result.breakdown.untested).toBe(30); // all untested
  });

  test("test files reduce untested score", () => {
    const obs = makeObs({
      files_modified: JSON.stringify(["src/main.ts", "src/main.test.ts"]),
    });
    const result = computeRiskScore({
      observations: [obs],
      securityFindings: [],
      filesTouchedCount: 2,
      toolCallsCount: 5,
    });
    expect(result.breakdown.untested).toBe(0);
  });

  test("decisions without narrative increase score", () => {
    const obs = makeObs({ type: "decision", narrative: null });
    const result = computeRiskScore({
      observations: [obs],
      securityFindings: [],
      filesTouchedCount: 0,
      toolCallsCount: 0,
    });
    expect(result.breakdown.unclear_decisions).toBe(20);
  });

  test("decisions with narrative don't increase score", () => {
    const obs = makeObs({
      type: "decision",
      narrative: "We chose this approach because it provides better performance and maintainability.",
    });
    const result = computeRiskScore({
      observations: [obs],
      securityFindings: [],
      filesTouchedCount: 0,
      toolCallsCount: 0,
    });
    expect(result.breakdown.unclear_decisions).toBe(0);
  });

  test("score is capped at 100", () => {
    const result = computeRiskScore({
      observations: [
        makeObs({ type: "decision", narrative: null }),
        makeObs({ type: "decision", narrative: null }),
        makeObs({ files_modified: JSON.stringify(["a.ts", "b.ts", "c.ts"]) }),
      ],
      securityFindings: [
        makeFinding("critical"),
        makeFinding("critical"),
        makeFinding("high"),
        makeFinding("high"),
      ],
      filesTouchedCount: 10,
      toolCallsCount: 50,
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test("formatRiskTrafficLight shows correct level", () => {
    const low = computeRiskScore({
      observations: [],
      securityFindings: [],
      filesTouchedCount: 0,
      toolCallsCount: 0,
    });
    expect(formatRiskTrafficLight(low)).toContain("🟢");
    expect(formatRiskTrafficLight(low)).toContain("low");
  });
});
