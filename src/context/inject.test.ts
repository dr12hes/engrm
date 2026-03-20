import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemDatabase } from "../storage/sqlite.js";
import {
  buildSessionContext,
  formatContextForInjection,
  estimateTokens,
  parseFacts,
  computeBlendedScore,
  computeObservationPriority,
  observationTypeBoost,
} from "./inject.js";

let db: MemDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engrm-inject-test-"));
  db = new MemDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- estimateTokens ---

describe("estimateTokens", () => {
  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("null/undefined returns 0", () => {
    expect(estimateTokens(null as any)).toBe(0);
    expect(estimateTokens(undefined as any)).toBe(0);
  });

  test("short string estimates correctly", () => {
    // "hello" = 5 chars → ceil(5/4) = 2 tokens
    expect(estimateTokens("hello")).toBe(2);
  });

  test("longer text estimates within expected range", () => {
    const text = "This is a longer piece of text that should be around 15 tokens";
    const estimate = estimateTokens(text);
    // 62 chars → ceil(62/4) = 16
    expect(estimate).toBeGreaterThan(10);
    expect(estimate).toBeLessThan(25);
  });
});

// --- parseFacts ---

describe("parseFacts", () => {
  test("parses valid JSON array", () => {
    const facts = parseFacts('["fact one", "fact two"]');
    expect(facts).toEqual(["fact one", "fact two"]);
  });

  test("returns empty for null/empty", () => {
    expect(parseFacts("")).toEqual([]);
    expect(parseFacts(null as any)).toEqual([]);
  });

  test("handles malformed JSON gracefully", () => {
    const facts = parseFacts("not valid json");
    expect(facts).toEqual(["not valid json"]);
  });

  test("filters out non-string entries", () => {
    const facts = parseFacts('[123, "valid", null, "also valid"]');
    expect(facts).toEqual(["valid", "also valid"]);
  });

  test("filters out empty strings", () => {
    const facts = parseFacts('["good", "", "also good"]');
    expect(facts).toEqual(["good", "also good"]);
  });
});

// --- buildSessionContext ---

describe("buildSessionContext", () => {
  test("returns empty for unknown project", () => {
    const ctx = buildSessionContext(db, "/tmp/nonexistent");
    expect(ctx).not.toBeNull();
    expect(ctx!.observations).toEqual([]);
    expect(ctx!.total_active).toBe(0);
  });

  test("returns pinned observations first", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Regular change",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop",
    });

    const pinned = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Use PostgreSQL for all data",
      quality: 0.9,
      lifecycle: "pinned",
      user_id: "david",
      device_id: "laptop",
    });

    const ctx = buildSessionContext(db, "/tmp/testproject");
    expect(ctx).not.toBeNull();
    expect(ctx!.observations.length).toBe(2);
    expect(ctx!.observations[0]!.id).toBe(pinned.id);
  });

  test("filters out low-quality observations", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Minor tweak",
      quality: 0.1,
      user_id: "david",
      device_id: "laptop",
    });

    db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Fix critical auth bug",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const ctx = buildSessionContext(db, "/tmp/testproject");
    // Both show up: high-quality via candidates, low-quality via recent-always slot
    expect(ctx!.observations.length).toBe(2);
    // High-quality observation should be listed (pinned or candidate)
    expect(ctx!.observations.some((o) => o.title === "Fix critical auth bug")).toBe(true);
  });

  test("respects legacy maxCount limit", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    for (let i = 0; i < 20; i++) {
      db.insertObservation({
        project_id: project.id,
        type: "bugfix",
        title: `Fix ${i}`,
        quality: 0.5,
        user_id: "david",
        device_id: "laptop",
      });
    }

    // Legacy number argument
    const ctx = buildSessionContext(db, "/tmp/testproject", 5);
    expect(ctx!.observations.length).toBeLessThanOrEqual(5);
  });

  test("respects maxCount via options object", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    for (let i = 0; i < 20; i++) {
      db.insertObservation({
        project_id: project.id,
        type: "bugfix",
        title: `Fix ${i}`,
        quality: 0.5,
        user_id: "david",
        device_id: "laptop",
      });
    }

    const ctx = buildSessionContext(db, "/tmp/testproject", { maxCount: 5 });
    expect(ctx!.observations.length).toBeLessThanOrEqual(5);
  });

  test("deduplicates pinned and recent", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Architecture decision",
      quality: 0.9,
      lifecycle: "pinned",
      user_id: "david",
      device_id: "laptop",
    });

    const ctx = buildSessionContext(db, "/tmp/testproject");
    const titles = ctx!.observations.map((o) => o.title);
    const unique = new Set(titles);
    expect(titles.length).toBe(unique.size);
  });

  test("includes total_active count", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    for (let i = 0; i < 10; i++) {
      db.insertObservation({
        project_id: project.id,
        type: "bugfix",
        title: `Fix ${i}`,
        quality: 0.5,
        user_id: "david",
        device_id: "laptop",
      });
    }

    // Low quality — still counted in total_active
    db.insertObservation({
      project_id: project.id,
      type: "change",
      title: "Minor",
      quality: 0.1,
      user_id: "david",
      device_id: "laptop",
    });

    const ctx = buildSessionContext(db, "/tmp/testproject");
    // total_active counts all active/aging/pinned regardless of quality
    expect(ctx!.total_active).toBe(11);
  });

  test("includes facts in context observations", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Use SQLite",
      facts: '["SQLite is fast", "Works offline"]',
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const ctx = buildSessionContext(db, "/tmp/testproject");
    expect(ctx!.observations[0]!.facts).toBe(
      '["SQLite is fast", "Works offline"]'
    );
  });
});

// --- Token budget ---

describe("token budget", () => {
  test("respects token budget — stops adding when exhausted", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    // Insert 30 observations with long narratives
    for (let i = 0; i < 30; i++) {
      db.insertObservation({
        project_id: project.id,
        type: "discovery",
        title: `Discovery about component ${i} and its various interactions`,
        narrative: `This is a detailed narrative about discovery ${i}. `.repeat(
          5
        ),
        quality: 0.5,
        user_id: "david",
        device_id: "laptop",
      });
    }

    const ctx = buildSessionContext(db, "/tmp/testproject", {
      tokenBudget: 200,
    });
    // With a very tight budget, should include fewer than 30
    expect(ctx!.observations.length).toBeLessThan(30);
    expect(ctx!.observations.length).toBeGreaterThan(0);
  });

  test("always includes pinned even if they consume most budget", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    // A pinned observation with long content
    db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Critical architecture decision that must always be shown",
      narrative: "Very important details. ".repeat(20),
      quality: 0.9,
      lifecycle: "pinned",
      user_id: "david",
      device_id: "laptop",
    });

    // A regular observation
    db.insertObservation({
      project_id: project.id,
      type: "bugfix",
      title: "Minor fix",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop",
    });

    const ctx = buildSessionContext(db, "/tmp/testproject", {
      tokenBudget: 50,
    });
    // Pinned should always be included
    expect(
      ctx!.observations.some(
        (o) => o.title === "Critical architecture decision that must always be shown"
      )
    ).toBe(true);
  });

  test("default budget is 3000 tokens", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    // Create observations with realistic content that will hit budget
    for (let i = 0; i < 200; i++) {
      db.insertObservation({
        project_id: project.id,
        type: "bugfix",
        title: `Fix critical authentication issue in component ${i} affecting all users`,
        narrative: `Discovered that the authentication token was not being refreshed correctly in component ${i}. The root cause was a race condition in the token refresh logic. Fixed by adding proper mutex locking around the refresh operation.`,
        facts: JSON.stringify([
          `Component ${i} had a race condition`,
          `Token refresh was failing silently`,
          `Added mutex locking to fix`,
        ]),
        quality: 0.5,
        user_id: "david",
        device_id: "laptop",
      });
    }

    // Default options (no maxCount, no explicit tokenBudget)
    const ctx = buildSessionContext(db, "/tmp/testproject");
    // Should include some but not all 200
    expect(ctx!.observations.length).toBeLessThan(200);
    expect(ctx!.observations.length).toBeGreaterThan(0);

    // Verify the formatted output is roughly within budget
    const formatted = formatContextForInjection(ctx!);
    const tokens = estimateTokens(formatted);
    // Should be within budget range (3000 + some margin for header/footer)
    expect(tokens).toBeLessThan(4000);
  });

  test("includes recent prompts in context for the current project", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    db.insertUserPrompt({
      session_id: "sess-prompts",
      project_id: project.id,
      prompt: "Investigate the startup brief mismatch against claude-mem",
      cwd: "/tmp/testproject",
      user_id: "david",
      device_id: "laptop",
    });

    const ctx = buildSessionContext(db, "/tmp/testproject");
    expect(ctx?.recentPrompts?.[0]?.prompt).toContain("startup brief mismatch");
  });

  test("includes recent session rollups and project type counts for the current project", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });
    db.upsertSession("sess-ctx", project.id, "david", "laptop", "claude-code");
    db.insertUserPrompt({
      session_id: "sess-ctx",
      project_id: project.id,
      prompt: "Fix auth flow",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertToolEvent({
      session_id: "sess-ctx",
      project_id: project.id,
      tool_name: "Edit",
      file_path: "src/auth.ts",
      user_id: "david",
      device_id: "laptop",
    });
    db.insertObservation({
      session_id: "sess-ctx",
      project_id: project.id,
      type: "bugfix",
      title: "Fixed auth redirect",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });
    db.insertSessionSummary({
      session_id: "sess-ctx",
      project_id: project.id,
      user_id: "david",
      request: "Fix auth flow",
      investigated: null,
      learned: null,
      completed: "Added retry",
      next_steps: null,
    });

    const ctx = buildSessionContext(db, "/tmp/testproject");
    expect(ctx?.recentSessions?.[0]?.session_id).toBe("sess-ctx");
    expect(ctx?.projectTypeCounts?.bugfix).toBe(1);
  });
});

// --- formatContextForInjection (tiered + facts-first) ---

describe("formatContextForInjection", () => {
  test("formats empty context", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [],
      session_count: 0,
      total_active: 0,
    });
    expect(text).toContain("myproject");
    expect(text).toContain("no prior observations");
  });

  test("top-tier observations show facts as bullet points", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [
        {
          id: 1,
          type: "decision",
          title: "Use SQLite",
          narrative: "We chose SQLite for local storage",
          facts: '["SQLite is fast", "Works offline", "No server needed"]',
          quality: 0.9,
          created_at: "2026-03-10T10:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 1,
    });

    // Should show facts as bullets, not narrative
    expect(text).toContain("  - SQLite is fast");
    expect(text).toContain("  - Works offline");
    expect(text).toContain("  - No server needed");
  });

  test("formats recent prompts ahead of observations when available", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [
        {
          id: 1,
          type: "decision",
          title: "Use SQLite",
          narrative: null,
          facts: '["Fast local reads"]',
          quality: 0.9,
          created_at: "2026-03-10T10:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 1,
      recentPrompts: [
        {
          id: 11,
          session_id: "sess-1",
          project_id: 1,
          prompt_number: 3,
          prompt: "Investigate why startup context feels too shallow compared with claude-mem",
          prompt_hash: "hash",
          cwd: "/tmp/myproject",
          user_id: "david",
          device_id: "laptop",
          agent: "claude-code",
          created_at_epoch: 1,
        },
      ],
    });

    expect(text).toContain("## Recent Requests");
    expect(text).toContain("#3: Investigate why startup context feels too shallow");
  });

  test("filters malformed prompt fragments from recent requests", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [],
      session_count: 0,
      total_active: 0,
      recentPrompts: [
        {
          id: 11,
          session_id: "sess-1",
          project_id: 1,
          prompt_number: 3,
          prompt: "[;ease",
          prompt_hash: "hash",
          cwd: "/tmp/myproject",
          user_id: "david",
          device_id: "laptop",
          agent: "claude-code",
          created_at_epoch: 1,
        },
      ],
    });

    expect(text).not.toContain("## Recent Requests");
    expect(text).not.toContain("[;ease");
  });

  test("formats recent tool chronology when available", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [],
      session_count: 0,
      total_active: 0,
      recentToolEvents: [
        {
          id: 21,
          session_id: "sess-1",
          project_id: 1,
          tool_name: "Edit",
          tool_input_json: "{\"file_path\":\"src/auth.ts\"}",
          tool_response_preview: "Edited src/auth.ts",
          file_path: "src/auth.ts",
          command: null,
          user_id: "david",
          device_id: "laptop",
          agent: "claude-code",
          created_at_epoch: 1,
        },
      ],
    });

    expect(text).toContain("## Recent Tools");
    expect(text).toContain("Edit: src/auth.ts");
  });

  test("formats recent sessions and project signals when available", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [],
      session_count: 0,
      total_active: 0,
      recentSessions: [
        {
          id: 1,
          session_id: "sess-1",
          project_id: 1,
          user_id: "david",
          device_id: "laptop",
          agent: "claude-code",
          status: "active",
          observation_count: 3,
          started_at_epoch: 1,
          completed_at_epoch: 2,
          project_name: "myproject",
          request: "Modified auth.ts",
          completed: "Added retry logic to auth flow",
          prompt_count: 1,
          tool_event_count: 2,
        },
      ],
      recentOutcomes: [
        "Added retry logic to auth flow",
      ],
      projectTypeCounts: {
        bugfix: 3,
        decision: 1,
      },
    });

    expect(text).toContain("## Recent Sessions");
    expect(text).toContain("sess-1: Added retry logic to auth flow");
    expect(text).toContain("## Recent Outcomes");
    expect(text).toContain("Added retry logic to auth flow");
    expect(text).toContain("## Project Signals");
    expect(text).toContain("Top memory types: bugfix 3");
  });

  test("suppresses empty recent sessions with no request or completed summary", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [],
      session_count: 0,
      total_active: 0,
      recentSessions: [
        {
          id: 1,
          session_id: "sess-1",
          project_id: 1,
          user_id: "david",
          device_id: "laptop",
          agent: "claude-code",
          status: "active",
          observation_count: 0,
          started_at_epoch: 1,
          completed_at_epoch: 2,
          project_name: "myproject",
          request: null,
          completed: null,
          prompt_count: 1,
          tool_event_count: 0,
        },
      ],
    });

    expect(text).not.toContain("## Recent Sessions");
    expect(text).not.toContain("(no summary)");
  });

  test("falls back to narrative when no facts", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [
        {
          id: 1,
          type: "bugfix",
          title: "Fix auth",
          narrative: "Token was expiring during long requests",
          facts: null,
          quality: 0.8,
          created_at: "2026-03-10T10:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 1,
    });

    expect(text).toContain("Token was expiring");
  });

  test("lower-tier observations show title only (no detail)", () => {
    const observations = [];
    for (let i = 0; i < 6; i++) {
      observations.push({
        id: i + 1,
        type: "bugfix",
        title: `Fix number ${i}`,
        narrative: `Detailed narrative for fix ${i} that should not appear for lower tier`,
        facts: `["Fact for fix ${i}"]`,
        quality: 0.5,
        created_at: "2026-03-10T10:00:00Z",
      });
    }

    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations,
      session_count: 6,
      total_active: 10,
    });

    // Observations 0-4 (top tier) should have detail
    expect(text).toContain("Fact for fix 0");
    expect(text).toContain("Fact for fix 1");
    expect(text).toContain("Fact for fix 2");
    expect(text).toContain("Fact for fix 3");
    expect(text).toContain("Fact for fix 4");

    // Observation 5 (lower tier) should NOT have detail
    expect(text).not.toContain("Fact for fix 5");

    // But their titles should be present
    expect(text).toContain("Fix number 3");
    expect(text).toContain("Fix number 4");
    expect(text).toContain("Fix number 5");
  });

  test("shows footer with remaining count", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [
        {
          id: 1,
          type: "bugfix",
          title: "Fix something",
          narrative: null,
          facts: null,
          quality: 0.5,
          created_at: "2026-03-10T10:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 15,
    });

    expect(text).toContain("14 more observation(s) available via search");
  });

  test("no footer when all observations shown", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [
        {
          id: 1,
          type: "bugfix",
          title: "Fix",
          narrative: null,
          facts: null,
          quality: 0.5,
          created_at: "2026-03-10T10:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 1,
    });

    expect(text).not.toContain("more observation(s) available");
  });

  test("with ≤3 observations all get detailed format", () => {
    const observations = [
      {
        id: 1,
        type: "decision",
        title: "Decision one",
        narrative: null,
        facts: '["Fact A"]',
        quality: 0.9,
        created_at: "2026-03-10T10:00:00Z",
      },
      {
        id: 2,
        type: "bugfix",
        title: "Bugfix two",
        narrative: "Fixed a bug",
        facts: null,
        quality: 0.7,
        created_at: "2026-03-10T10:00:00Z",
      },
    ];

    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations,
      session_count: 2,
      total_active: 2,
    });

    expect(text).toContain("Fact A");
    expect(text).toContain("Fixed a bug");
  });

  test("handles malformed facts JSON gracefully", () => {
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [
        {
          id: 1,
          type: "bugfix",
          title: "Fix",
          narrative: null,
          facts: "not valid json but still useful",
          quality: 0.5,
          created_at: "2026-03-10T10:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 1,
    });

    // Should treat as single fact, not crash
    expect(text).toContain("not valid json but still useful");
  });

  test("caps facts at 4 per observation", () => {
    const manyFacts = JSON.stringify([
      "Fact 1",
      "Fact 2",
      "Fact 3",
      "Fact 4",
      "Fact 5 should not appear",
      "Fact 6 should not appear",
    ]);
    const text = formatContextForInjection({
      project_name: "myproject",
      canonical_id: "local/myproject",
      observations: [
        {
          id: 1,
          type: "decision",
          title: "Decision",
          narrative: null,
          facts: manyFacts,
          quality: 0.9,
          created_at: "2026-03-10T10:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 1,
    });

    expect(text).toContain("Fact 1");
    expect(text).toContain("Fact 4");
    expect(text).not.toContain("Fact 5");
    expect(text).not.toContain("Fact 6");
  });

  test("truncates long narratives in fallback", () => {
    const longNarrative = "x".repeat(200);
    const text = formatContextForInjection({
      project_name: "test",
      canonical_id: "local/test",
      observations: [
        {
          id: 1,
          type: "bugfix",
          title: "Fix",
          narrative: longNarrative,
          facts: null,
          quality: 0.5,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      session_count: 1,
      total_active: 1,
    });
    // Narrative truncated to 120 chars
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(longNarrative.length + 200);
  });
});

// --- computeBlendedScore ---

describe("computeBlendedScore", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const ONE_DAY = 86400;

  test("recent medium-quality beats old high-quality", () => {
    // 2 days old, q=0.5
    const recentScore = computeBlendedScore(0.5, NOW - 2 * ONE_DAY, NOW);
    // 25 days old, q=0.7
    const oldScore = computeBlendedScore(0.7, NOW - 25 * ONE_DAY, NOW);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  test("very old observations get near-zero recency boost", () => {
    // 60 days old — well past the 30-day window
    const score = computeBlendedScore(0.5, NOW - 60 * ONE_DAY, NOW);
    // Should be roughly quality * 0.6 = 0.3 (no recency contribution)
    expect(score).toBeCloseTo(0.3, 1);
  });

  test("brand new observation gets full recency boost", () => {
    const score = computeBlendedScore(0.5, NOW, NOW);
    // quality * 0.6 + 1.0 * 0.4 = 0.3 + 0.4 = 0.7
    expect(score).toBeCloseTo(0.7, 1);
  });

  test("same-age observations sort by quality", () => {
    const age = NOW - 5 * ONE_DAY;
    const highQ = computeBlendedScore(0.9, age, NOW);
    const lowQ = computeBlendedScore(0.3, age, NOW);
    expect(highQ).toBeGreaterThan(lowQ);
  });

  test("score is always between 0 and 1", () => {
    // Extreme cases
    expect(computeBlendedScore(0, NOW - 100 * ONE_DAY, NOW)).toBeGreaterThanOrEqual(0);
    expect(computeBlendedScore(1, NOW, NOW)).toBeLessThanOrEqual(1);
    expect(computeBlendedScore(0.5, NOW + ONE_DAY, NOW)).toBeLessThanOrEqual(1); // future timestamp
  });

  test("future timestamps clamp recency to 1", () => {
    // Created "in the future" — shouldn't produce score > 1
    const score = computeBlendedScore(1.0, NOW + 10 * ONE_DAY, NOW);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

describe("observationTypeBoost", () => {
  test("prefers higher-value memory object types", () => {
    expect(observationTypeBoost("decision")).toBeGreaterThan(observationTypeBoost("change"));
    expect(observationTypeBoost("pattern")).toBeGreaterThan(observationTypeBoost("digest"));
    expect(observationTypeBoost("bugfix")).toBeGreaterThan(observationTypeBoost("refactor"));
  });

  test("unknown types get no boost", () => {
    expect(observationTypeBoost("unknown")).toBe(0);
  });
});

describe("computeObservationPriority", () => {
  const NOW = Math.floor(Date.now() / 1000);

  test("structured decision outranks generic change with same age and quality", () => {
    const base = {
      id: 1,
      project_id: 1,
      source_session_id: null,
      narrative: null,
      facts: null,
      concepts: null,
      quality: 0.6,
      sensitivity: "team",
      lifecycle: "active",
      superseded_by: null,
      supersedes: null,
      user_id: "david",
      device_id: "laptop",
      created_at: "2026-03-19T09:00:00Z",
      created_at_epoch: NOW - 86400,
      updated_at: "2026-03-19T09:00:00Z",
      embedding_id: null,
    };

    const decision = {
      ...base,
      type: "decision",
      title: "Prefer project-scoped memory objects",
    } as any;

    const change = {
      ...base,
      id: 2,
      type: "change",
      title: "Updated files",
    } as any;

    expect(computeObservationPriority(decision, NOW)).toBeGreaterThan(
      computeObservationPriority(change, NOW)
    );
  });
});

// --- Blended scoring integration ---

describe("blended scoring in buildSessionContext", () => {
  test("recent medium-quality observation appears before old high-quality", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    const nowEpoch = Math.floor(Date.now() / 1000);

    // Insert old high-quality observation (25 days ago)
    // We need to directly manipulate created_at_epoch
    db.db
      .query(
        `INSERT INTO observations (project_id, type, title, quality, lifecycle,
         user_id, device_id, created_at, created_at_epoch)
         VALUES (?, 'decision', 'Old important decision', 0.8, 'active',
         'david', 'laptop', datetime('now'), ?)`
      )
      .run(project.id, nowEpoch - 25 * 86400);

    // Insert recent medium-quality observation (1 day ago)
    db.db
      .query(
        `INSERT INTO observations (project_id, type, title, quality, lifecycle,
         user_id, device_id, created_at, created_at_epoch)
         VALUES (?, 'discovery', 'Recent discovery', 0.5, 'active',
         'david', 'laptop', datetime('now'), ?)`
      )
      .run(project.id, nowEpoch - 1 * 86400);

    // Also add to FTS
    db.db.query(
      `INSERT INTO observations_fts (rowid, title, narrative, facts, concepts)
       SELECT id, title, narrative, facts, concepts FROM observations WHERE project_id = ?`
    ).run(project.id);

    const ctx = buildSessionContext(db, "/tmp/testproject", { tokenBudget: 800 });
    expect(ctx!.observations.length).toBe(2);

    // Recent medium-quality should come first due to blended scoring
    expect(ctx!.observations[0]!.title).toBe("Recent discovery");
    expect(ctx!.observations[1]!.title).toBe("Old important decision");
  });
});

// --- Supersession ---

describe("supersession", () => {
  test("superseded observation excluded from session context", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    const old = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Use Express for API",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const replacement = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Migrated from Express to Hono",
      quality: 0.9,
      user_id: "david",
      device_id: "laptop",
    });

    // Supersede the old one
    const result = db.supersedeObservation(old.id, replacement.id);
    expect(result).toBe(true);

    const ctx = buildSessionContext(db, "/tmp/testproject");
    const titles = ctx!.observations.map((o) => o.title);
    expect(titles).toContain("Migrated from Express to Hono");
    expect(titles).not.toContain("Use Express for API");
  });

  test("superseded observation excluded from total_active count", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    const old = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Old decision",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    const replacement = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "New decision",
      quality: 0.9,
      user_id: "david",
      device_id: "laptop",
    });

    db.supersedeObservation(old.id, replacement.id);

    const ctx = buildSessionContext(db, "/tmp/testproject");
    // Only the replacement should count
    expect(ctx!.total_active).toBe(1);
  });

  test("supersedeObservation archives the old one", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    const old = db.insertObservation({
      project_id: project.id,
      type: "discovery",
      title: "Old discovery",
      quality: 0.7,
      user_id: "david",
      device_id: "laptop",
    });

    const newer = db.insertObservation({
      project_id: project.id,
      type: "discovery",
      title: "Updated discovery",
      quality: 0.8,
      user_id: "david",
      device_id: "laptop",
    });

    db.supersedeObservation(old.id, newer.id);

    const archived = db.getObservationById(old.id)!;
    expect(archived.lifecycle).toBe("archived");
    expect(archived.superseded_by).toBe(newer.id);
    expect(archived.archived_at_epoch).not.toBeNull();
  });

  test("supersession chains resolve to the current head", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    const obs1 = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "First",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop",
    });

    const obs2 = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Second",
      quality: 0.6,
      user_id: "david",
      device_id: "laptop",
    });

    const obs3 = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Third",
      quality: 0.7,
      user_id: "david",
      device_id: "laptop",
    });

    // First supersession: #1 superseded by #2
    expect(db.supersedeObservation(obs1.id, obs2.id)).toBe(true);

    // Chain supersession: asking to supersede #1 with #3
    // Should resolve to head (#2) and supersede that instead
    expect(db.supersedeObservation(obs1.id, obs3.id)).toBe(true);

    // #1 is still superseded by #2 (unchanged)
    const check1 = db.getObservationById(obs1.id)!;
    expect(check1.superseded_by).toBe(obs2.id);

    // #2 is now superseded by #3 (the chain resolved)
    const check2 = db.getObservationById(obs2.id)!;
    expect(check2.superseded_by).toBe(obs3.id);
    expect(check2.lifecycle).toBe("archived");

    // #3 is the current head (not superseded)
    const check3 = db.getObservationById(obs3.id)!;
    expect(check3.superseded_by).toBeNull();
  });

  test("cannot self-supersede", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    const obs = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Self",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop",
    });

    expect(db.supersedeObservation(obs.id, obs.id)).toBe(false);
  });

  test("returns false for nonexistent observation IDs", () => {
    expect(db.supersedeObservation(999, 888)).toBe(false);
  });

  test("isSuperseded returns correct state", () => {
    const project = db.upsertProject({
      canonical_id: "local/testproject",
      name: "testproject",
    });

    const old = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "Old",
      quality: 0.5,
      user_id: "david",
      device_id: "laptop",
    });

    const newer = db.insertObservation({
      project_id: project.id,
      type: "decision",
      title: "New",
      quality: 0.7,
      user_id: "david",
      device_id: "laptop",
    });

    expect(db.isSuperseded(old.id)).toBe(false);
    db.supersedeObservation(old.id, newer.id);
    expect(db.isSuperseded(old.id)).toBe(true);
    expect(db.isSuperseded(newer.id)).toBe(false);
  });
});
