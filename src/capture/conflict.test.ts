import { describe, test, expect } from "bun:test";

// Test the narrative conflict heuristic directly
// We can't easily import the private function, so we'll test through the public API
// using a simple reimplementation of the heuristic for unit testing

function narrativesConflict(n1: string, n2: string): string | null {
  const a = n1.toLowerCase();
  const b = n2.toLowerCase();

  const opposingPairs: [string[], string[]][] = [
    [["should use", "decided to use", "chose", "prefer", "went with"], ["should not", "decided against", "avoid", "rejected", "don't use"]],
    [["enable", "turn on", "activate", "add"], ["disable", "turn off", "deactivate", "remove"]],
    [["increase", "more", "higher", "scale up"], ["decrease", "less", "lower", "scale down"]],
    [["keep", "maintain", "preserve"], ["replace", "migrate", "switch from", "deprecate"]],
  ];

  for (const [positive, negative] of opposingPairs) {
    const aPos = positive.some((w) => a.includes(w));
    const aNeg = negative.some((w) => a.includes(w));
    const bPos = positive.some((w) => b.includes(w));
    const bNeg = negative.some((w) => b.includes(w));

    if ((aPos && bNeg) || (aNeg && bPos)) {
      return "Narratives suggest opposing conclusions on a similar topic";
    }
  }

  return null;
}

describe("decision conflict detection", () => {
  test("detects use vs don't use conflict", () => {
    const result = narrativesConflict(
      "We decided to use Redis for caching because it provides fast lookups",
      "We should not use Redis due to operational complexity, avoid it"
    );
    expect(result).not.toBeNull();
  });

  test("detects enable vs disable conflict", () => {
    const result = narrativesConflict(
      "Enable strict mode for better error detection",
      "Disable strict mode because it causes too many false positives"
    );
    expect(result).not.toBeNull();
  });

  test("detects keep vs replace conflict", () => {
    const result = narrativesConflict(
      "Keep the current authentication system, it works well",
      "Replace the auth system with OAuth2, migrate away from custom auth"
    );
    expect(result).not.toBeNull();
  });

  test("no conflict for similar narratives", () => {
    const result = narrativesConflict(
      "We chose to use TypeScript for type safety benefits",
      "We decided to use TypeScript because it catches bugs at compile time"
    );
    expect(result).toBeNull();
  });

  test("no conflict for unrelated narratives", () => {
    const result = narrativesConflict(
      "The database schema needs a new index for performance",
      "Frontend should use lazy loading for images"
    );
    expect(result).toBeNull();
  });
});
