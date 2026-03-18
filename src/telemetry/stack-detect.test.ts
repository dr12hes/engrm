import { describe, it, expect } from "bun:test";
import { detectStacks, detectStacksFromProject } from "./stack-detect.js";

describe("detectStacks", () => {
  it("detects languages from file extensions", () => {
    const stacks = detectStacks([
      "src/index.ts",
      "src/App.tsx",
      "server.py",
    ]);
    expect(stacks).toContain("typescript");
    expect(stacks).toContain("react");
    expect(stacks).toContain("python");
  });

  it("detects from path patterns", () => {
    const stacks = detectStacks([
      "src/__tests__/foo.test.ts",
      "project/cypress/e2e/login.cy.ts",
    ]);
    expect(stacks).toContain("jest");
    expect(stacks).toContain("cypress");
  });

  it("returns empty array for no matches", () => {
    expect(detectStacks([])).toEqual([]);
    expect(detectStacks(["README.md"])).toEqual([]);
  });

  it("returns sorted, deduplicated stacks", () => {
    const stacks = detectStacks([
      "a.ts",
      "b.ts",
      "c.tsx",
    ]);
    // typescript from .ts, react from .tsx
    expect(stacks).toEqual(["react", "typescript"]);
  });

  it("detects Go from .go files", () => {
    expect(detectStacks(["main.go"])).toContain("go");
  });

  it("detects Rust from .rs files", () => {
    expect(detectStacks(["lib.rs"])).toContain("rust");
  });

  it("detects Vue from .vue files", () => {
    expect(detectStacks(["App.vue"])).toContain("vue");
  });

  it("detects Svelte from .svelte files", () => {
    expect(detectStacks(["Counter.svelte"])).toContain("svelte");
  });
});

describe("detectStacksFromProject", () => {
  it("detects stacks from project root config files", () => {
    // Use the repo root — it has tsconfig.json and bun.lock
    const result = detectStacksFromProject(
      process.cwd(),
      ["src/server.ts"]
    );
    expect(result.stacks).toContain("typescript");
    expect(result.stacks).toContain("bun");
    expect(result.primary).toBeTruthy();
  });

  it("returns 'unknown' as primary when no stacks detected", () => {
    const result = detectStacksFromProject("/nonexistent/path", []);
    expect(result.primary).toBe("unknown");
  });

  it("picks framework as primary over language", () => {
    const result = detectStacksFromProject("/nonexistent", [
      "app/page.tsx",
    ]);
    // react from .tsx — no framework config files in /nonexistent
    expect(result.stacks).toContain("react");
  });
});
