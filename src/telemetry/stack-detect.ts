/**
 * Technology stack detection from file paths and project root.
 *
 * Pure function — no side effects, no I/O beyond existsSync checks.
 * Used by the telemetry beacon to report which stacks are active.
 */

import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

/** Extension → stack mapping (most specific first) */
const EXTENSION_MAP: Record<string, string> = {
  ".tsx": "react",
  ".jsx": "react",
  ".ts": "typescript",
  ".js": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".lua": "lua",
  ".dart": "dart",
  ".scala": "scala",
  ".clj": "clojure",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
};

/** Config file patterns → stack (checked at project root) */
const CONFIG_FILE_STACKS: [string, string][] = [
  ["next.config.js", "nextjs"],
  ["next.config.mjs", "nextjs"],
  ["next.config.ts", "nextjs"],
  ["nuxt.config.ts", "nuxt"],
  ["nuxt.config.js", "nuxt"],
  ["vite.config.ts", "vite"],
  ["vite.config.js", "vite"],
  ["vite.config.mjs", "vite"],
  ["svelte.config.js", "svelte"],
  ["astro.config.mjs", "astro"],
  ["remix.config.js", "remix"],
  ["angular.json", "angular"],
  ["tailwind.config.js", "tailwind"],
  ["tailwind.config.ts", "tailwind"],
  ["postcss.config.js", "postcss"],
  ["webpack.config.js", "webpack"],
  ["tsconfig.json", "typescript"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["requirements.txt", "python"],
  ["Pipfile", "python"],
  ["manage.py", "django"],
  ["Gemfile", "ruby"],
  ["composer.json", "php"],
  ["pom.xml", "java"],
  ["build.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["Package.swift", "swift"],
  ["pubspec.yaml", "flutter"],
  ["mix.exs", "elixir"],
  ["deno.json", "deno"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["docker-compose.yml", "docker"],
  ["docker-compose.yaml", "docker"],
  ["Dockerfile", "docker"],
  [".prisma/schema.prisma", "prisma"],
  ["prisma/schema.prisma", "prisma"],
  ["drizzle.config.ts", "drizzle"],
];

/** Path pattern → stack (substring match) */
const PATH_PATTERN_STACKS: [string, string][] = [
  ["/__tests__/", "jest"],
  ["/.storybook/", "storybook"],
  ["/cypress/", "cypress"],
  ["/playwright/", "playwright"],
  ["/terraform/", "terraform"],
  ["/k8s/", "kubernetes"],
  ["/helm/", "helm"],
];

/**
 * Detect technology stacks from observed file paths.
 * Pure function — examines extensions and path patterns only.
 */
export function detectStacks(filePaths: string[]): string[] {
  const stacks = new Set<string>();

  for (const fp of filePaths) {
    const ext = extname(fp).toLowerCase();
    if (ext && EXTENSION_MAP[ext]) {
      stacks.add(EXTENSION_MAP[ext]);
    }

    // Check path patterns
    for (const [pattern, stack] of PATH_PATTERN_STACKS) {
      if (fp.includes(pattern)) {
        stacks.add(stack);
      }
    }
  }

  return Array.from(stacks).sort();
}

/**
 * Enhanced detection — also scans project root for config files.
 * Returns stacks detected + a primary (highest-confidence) stack.
 */
export function detectStacksFromProject(
  projectRoot: string,
  filePaths: string[] = []
): { stacks: string[]; primary: string } {
  const stacks = new Set(detectStacks(filePaths));

  // Scan project root for config files
  for (const [configFile, stack] of CONFIG_FILE_STACKS) {
    try {
      if (existsSync(join(projectRoot, configFile))) {
        stacks.add(stack);
      }
    } catch {
      // permission error, etc.
    }
  }

  const sorted = Array.from(stacks).sort();

  // Primary = most specific framework, or first language
  const frameworks = ["nextjs", "nuxt", "remix", "angular", "django", "flutter", "svelte", "astro"];
  const primary = sorted.find((s) => frameworks.includes(s)) ?? sorted[0] ?? "unknown";

  return { stacks: sorted, primary };
}
