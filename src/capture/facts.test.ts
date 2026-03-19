import { describe, expect, test } from "bun:test";
import { buildStructuredFacts } from "./facts.js";

describe("buildStructuredFacts", () => {
  test("preserves supplied facts and dedupes title overlap", () => {
    const result = buildStructuredFacts({
      type: "decision",
      title: "Choose PostgreSQL over MySQL",
      facts: ["Choose PostgreSQL over MySQL", "Supports JSONB indexing"],
    });

    expect(result).toEqual([
      "Choose PostgreSQL over MySQL",
      "Supports JSONB indexing",
    ]);
  });

  test("derives facts from narrative and touched files", () => {
    const result = buildStructuredFacts({
      type: "bugfix",
      title: "Fix authentication token refresh",
      narrative:
        "Token refresh was failing after expiry because the retry path skipped the new credentials. Added a guard to rebuild the auth header before retrying.",
      filesModified: ["src/auth.ts", "src/http/client.ts"],
    });

    expect(result).toContain("Fix authentication token refresh");
    expect(result.some((fact) => fact.includes("Token refresh was failing after expiry"))).toBe(true);
    expect(result.some((fact) => fact.includes("Touched src/auth.ts, src/http/client.ts"))).toBe(true);
  });

  test("ignores low-signal file-operation titles", () => {
    const result = buildStructuredFacts({
      type: "change",
      title: "Modified auth.ts",
      narrative: "Updated request signing to use the rotated key id and cache the header state for retries.",
      filesModified: ["src/auth.ts"],
    });

    expect(result).not.toContain("Modified auth.ts");
    expect(result.some((fact) => fact.includes("Updated request signing"))).toBe(true);
  });
});
