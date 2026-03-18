import { describe, expect, test } from "bun:test";
import { composeEmbeddingText, EMBEDDING_DIMS } from "./embedder.js";

describe("composeEmbeddingText", () => {
  test("title only", () => {
    const text = composeEmbeddingText({
      title: "Fix auth bug",
      narrative: null,
      facts: null,
      concepts: null,
    });
    expect(text).toBe("Fix auth bug");
  });

  test("title + narrative", () => {
    const text = composeEmbeddingText({
      title: "Fix auth bug",
      narrative: "Token refresh was broken",
      facts: null,
      concepts: null,
    });
    expect(text).toContain("Fix auth bug");
    expect(text).toContain("Token refresh was broken");
  });

  test("title + facts as JSON array", () => {
    const text = composeEmbeddingText({
      title: "Choose PostgreSQL",
      narrative: null,
      facts: JSON.stringify(["Supports JSONB", "Better indexing"]),
      concepts: null,
    });
    expect(text).toContain("Choose PostgreSQL");
    expect(text).toContain("- Supports JSONB");
    expect(text).toContain("- Better indexing");
  });

  test("title + concepts", () => {
    const text = composeEmbeddingText({
      title: "Database decision",
      narrative: null,
      facts: null,
      concepts: JSON.stringify(["postgres", "database"]),
    });
    expect(text).toContain("Database decision");
    expect(text).toContain("postgres, database");
  });

  test("all fields combined", () => {
    const text = composeEmbeddingText({
      title: "Fix auth",
      narrative: "Token expired",
      facts: JSON.stringify(["Fact 1"]),
      concepts: JSON.stringify(["auth"]),
    });
    expect(text).toContain("Fix auth");
    expect(text).toContain("Token expired");
    expect(text).toContain("- Fact 1");
    expect(text).toContain("auth");
  });

  test("handles malformed facts JSON gracefully", () => {
    const text = composeEmbeddingText({
      title: "Test",
      narrative: null,
      facts: "not valid json",
      concepts: null,
    });
    expect(text).toContain("Test");
    expect(text).toContain("not valid json");
  });

  test("EMBEDDING_DIMS is 384", () => {
    expect(EMBEDDING_DIMS).toBe(384);
  });
});
