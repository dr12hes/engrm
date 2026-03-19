import { describe, expect, test } from "bun:test";
import { computeSessionValueSignals } from "./value-signals.js";
import type { ObservationRow, SecurityFindingRow } from "../storage/sqlite.js";

function observation(partial: Partial<ObservationRow>): ObservationRow {
  return {
    id: 1,
    session_id: "sess-1",
    project_id: 1,
    type: "change",
    title: "Default title",
    narrative: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    quality: 0.5,
    lifecycle: "active",
    sensitivity: "shared",
    user_id: "david",
    device_id: "mac",
    agent: "claude-code",
    created_at: "2026-03-19T00:00:00Z",
    created_at_epoch: 0,
    archived_at_epoch: null,
    compacted_into: null,
    superseded_by: null,
    remote_source_id: null,
    ...partial,
  };
}

function finding(partial: Partial<SecurityFindingRow>): SecurityFindingRow {
  return {
    id: 1,
    session_id: "sess-1",
    project_id: 1,
    finding_type: "security",
    severity: "high",
    pattern_name: "hardcoded-secret",
    file_path: null,
    snippet: null,
    tool_name: null,
    user_id: "david",
    device_id: "mac",
    created_at_epoch: 0,
    ...partial,
  };
}

describe("computeSessionValueSignals", () => {
  test("counts value signals and marks delivery review readiness", () => {
    const result = computeSessionValueSignals(
      [
        observation({ id: 1, type: "decision", title: "Chose local-first storage" }),
        observation({ id: 2, type: "bugfix", title: "Fixed startup brief duplication" }),
        observation({ id: 3, type: "pattern", title: "Repeated auth mismatch pattern" }),
        observation({ id: 4, type: "discovery", title: "Investigated OpenClaw session cache" }),
        observation({ id: 5, type: "feature", title: "Added grouped session evidence" }),
        observation({ id: 6, type: "refactor", title: "Refactored sync document builder" }),
      ],
      [
        finding({ id: 1, severity: "critical" }),
        finding({ id: 2, severity: "medium" }),
      ]
    );

    expect(result.decisions_count).toBe(1);
    expect(result.lessons_count).toBe(3);
    expect(result.discoveries_count).toBe(1);
    expect(result.features_count).toBe(1);
    expect(result.refactors_count).toBe(1);
    expect(result.repeated_patterns_count).toBe(1);
    expect(result.security_findings_count).toBe(2);
    expect(result.critical_security_findings_count).toBe(1);
    expect(result.delivery_review_ready).toBe(true);
    expect(result.vibe_guardian_active).toBe(true);
  });
});
