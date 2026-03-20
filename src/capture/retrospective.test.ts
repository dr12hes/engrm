import { describe, expect, test } from "bun:test";
import { extractRetrospective } from "./retrospective.js";
import type { ObservationRow } from "../storage/sqlite.js";

function makeObs(overrides: Partial<ObservationRow>): ObservationRow {
  return {
    id: 1,
    session_id: "sess-001",
    project_id: 1,
    type: "change",
    title: "Test observation",
    narrative: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    quality: 0.5,
    lifecycle: "active",
    sensitivity: "shared",
    user_id: "david",
    device_id: "laptop-abc",
    agent: "claude-code",
    created_at: new Date().toISOString(),
    created_at_epoch: Math.floor(Date.now() / 1000),
    archived_at_epoch: null,
    compacted_into: null,
    superseded_by: null,
    remote_source_id: null,
    ...overrides,
  };
}

describe("extractRetrospective", () => {
  test("returns null for empty observations", () => {
    const result = extractRetrospective([], "sess-001", 1, "david");
    expect(result).toBeNull();
  });

  test("extracts request from first observation", () => {
    const obs = [makeObs({ title: "Fix auth bug", type: "bugfix" })];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result).not.toBeNull();
    expect(result!.request).toBe("Fix auth bug");
  });

  test("request prefers meaningful work over file-operation boilerplate", () => {
    const obs = [
      makeObs({ id: 1, type: "change", title: "Modified auth.ts" }),
      makeObs({ id: 2, type: "decision", title: "Add token rotation support" }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.request).toBe("Add token rotation support");
  });

  test("groups discoveries into investigated", () => {
    const obs = [
      makeObs({ id: 1, type: "discovery", title: "Found memory leak" }),
      makeObs({ id: 2, type: "discovery", title: "Traced to connection pool" }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.investigated).toContain("Found memory leak");
    expect(result!.investigated).toContain("Traced to connection pool");
  });

  test("groups bugfix/decision/pattern into learned", () => {
    const obs = [
      makeObs({ id: 1, type: "bugfix", title: "Fixed timeout" }),
      makeObs({ id: 2, type: "decision", title: "Use retry logic" }),
      makeObs({ id: 3, type: "pattern", title: "Exponential backoff" }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.learned).toContain("Fixed timeout");
    expect(result!.learned).toContain("Use retry logic");
    expect(result!.learned).toContain("Exponential backoff");
  });

  test("learned prefers richer observations with useful facts", () => {
    const obs = [
      makeObs({
        id: 1,
        type: "bugfix",
        title: "Fixed timeout",
        facts: JSON.stringify(["Retries were skipped when the cached auth header was stale"]),
      }),
      makeObs({
        id: 2,
        type: "bugfix",
        title: "Updated timeout.ts",
        facts: JSON.stringify(["timeout.ts"]),
      }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.learned).toContain("Fixed timeout");
    expect(result!.learned).toContain("Retries were skipped when the cached auth header was stale");
  });

  test("groups change/feature/refactor into completed", () => {
    const obs = [
      makeObs({ id: 1, type: "change", title: "Modified config.ts" }),
      makeObs({ id: 2, type: "feature", title: "Added auth" }),
      makeObs({ id: 3, type: "refactor", title: "Cleaned up router" }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.completed).toContain("Modified config.ts");
    expect(result!.completed).toContain("Added auth");
    expect(result!.completed).toContain("Cleaned up router");
  });

  test("dedupes repetitive completed file operations and keeps meaningful facts", () => {
    const obs = [
      makeObs({
        id: 1,
        type: "change",
        title: "Modified mem_insights.py",
        files_modified: JSON.stringify(["app/services/mem_insights.py"]),
        facts: JSON.stringify(["Introduced per-project insights function for multi-level analysis"]),
      }),
      makeObs({
        id: 2,
        type: "change",
        title: "Modified mem_insights.py (mem_insights.py)",
        files_modified: JSON.stringify(["app/services/mem_insights.py"]),
        facts: JSON.stringify(["mem_insights.py"]),
      }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.completed).toContain("Updated implementation in mem_insights.py");
    expect(result!.completed).toContain("Introduced per-project insights function for multi-level analysis");
    expect(result!.completed!.match(/Updated implementation in mem_insights\.py/g)?.length).toBe(1);
  });

  test("extracts next steps from late bugfix errors", () => {
    const obs = [
      makeObs({ id: 1, type: "change", title: "Step 1" }),
      makeObs({ id: 2, type: "change", title: "Step 2" }),
      makeObs({ id: 3, type: "change", title: "Step 3" }),
      makeObs({
        id: 4,
        type: "bugfix",
        title: "Build failure",
        narrative: "Error: module not found",
      }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.next_steps).toContain("Investigate: Build failure");
  });

  test("includes late-session decisions as follow-through next steps", () => {
    const obs = [
      makeObs({ id: 1, type: "change", title: "Started auth rewrite" }),
      makeObs({ id: 2, type: "feature", title: "Added token parser" }),
      makeObs({ id: 3, type: "decision", title: "Ship refresh-token rotation in the next pass" }),
      makeObs({ id: 4, type: "decision", title: "Add admin audit trail after auth hardening" }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.next_steps).toContain("Follow through: Ship refresh-token rotation in the next pass");
    expect(result!.next_steps).toContain("Follow through: Add admin audit trail after auth hardening");
  });

  test("does not promote already-completed work into next steps", () => {
    const obs = [
      makeObs({ id: 1, type: "change", title: "Started insights improvements" }),
      makeObs({ id: 2, type: "change", title: "Fixed team ID field reference in insights page initialization" }),
      makeObs({ id: 3, type: "bugfix", title: "Fixed team ID field reference in insights page initialization", narrative: "Error: team_id was undefined" }),
    ];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    expect(result!.completed).toContain("Fixed team ID field reference in insights page initialization");
    expect(result!.next_steps).toBeNull();
  });

  test("sets session metadata correctly", () => {
    const obs = [makeObs({ type: "change", title: "Something" })];
    const result = extractRetrospective(obs, "sess-abc", 42, "alice");
    expect(result!.session_id).toBe("sess-abc");
    expect(result!.project_id).toBe(42);
    expect(result!.user_id).toBe("alice");
  });

  test("returns null when no meaningful content extracted", () => {
    // digest type doesn't map to any category
    const obs = [makeObs({ type: "digest", title: "" })];
    const result = extractRetrospective(obs, "sess-001", 1, "david");
    // request will be empty string, no other fields populated
    // extractRequest returns "" which is falsy but not null
    // This should still produce a summary with just the request
    // Actually, first.title is "" which is falsy, so request will be ""
    // The function checks !request which is true for ""
    expect(result).toBeNull();
  });
});
