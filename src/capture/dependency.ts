/**
 * Dependency monitor.
 *
 * Detects package installations in Bash tool output and
 * creates observations tracking dependency changes.
 */

export interface DependencyInstall {
  manager: string;
  packages: string[];
  command: string;
}

/**
 * Patterns for detecting dependency install commands.
 * Each pattern captures the package manager and package names.
 */
const INSTALL_PATTERNS: {
  regex: RegExp;
  manager: string;
  packageExtractor: (match: RegExpMatchArray) => string[];
}[] = [
  {
    // npm install <pkg> [<pkg>...], npm i <pkg>, npm add <pkg>
    regex: /\bnpm\s+(?:install|i|add)\s+([^\s-][\w@/.^~>=<*-]*(?:\s+[^\s-][\w@/.^~>=<*-]*)*)/gm,
    manager: "npm",
    packageExtractor: (m) =>
      m[1]!
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-")),
  },
  {
    // yarn add <pkg> [<pkg>...]
    regex: /\byarn\s+add\s+([^\s-][\w@/.^~>=<*-]*(?:\s+[^\s-][\w@/.^~>=<*-]*)*)/gm,
    manager: "yarn",
    packageExtractor: (m) =>
      m[1]!
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-")),
  },
  {
    // pnpm add <pkg> [<pkg>...]
    regex: /\bpnpm\s+(?:add|install)\s+([^\s-][\w@/.^~>=<*-]*(?:\s+[^\s-][\w@/.^~>=<*-]*)*)/gm,
    manager: "pnpm",
    packageExtractor: (m) =>
      m[1]!
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-")),
  },
  {
    // bun add <pkg> [<pkg>...]
    regex: /\bbun\s+add\s+([^\s-][\w@/.^~>=<*-]*(?:\s+[^\s-][\w@/.^~>=<*-]*)*)/gm,
    manager: "bun",
    packageExtractor: (m) =>
      m[1]!
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-")),
  },
  {
    // pip install <pkg> [<pkg>...]
    regex: /\bpip3?\s+install\s+([^\s-][\w>=<.~!-]*(?:\s+[^\s-][\w>=<.~!-]*)*)/gm,
    manager: "pip",
    packageExtractor: (m) =>
      m[1]!
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-") && !p.startsWith("--")),
  },
  {
    // cargo add <pkg> [<pkg>...]
    regex: /\bcargo\s+add\s+([^\s-][\w-]*(?:\s+[^\s-][\w-]*)*)/gm,
    manager: "cargo",
    packageExtractor: (m) =>
      m[1]!
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-")),
  },
  {
    // go get <pkg>
    regex: /\bgo\s+get\s+([\w./\-@]+)/gm,
    manager: "go",
    packageExtractor: (m) => [m[1]!],
  },
  {
    // gem install <pkg>
    regex: /\bgem\s+install\s+([\w-]+)/gm,
    manager: "gem",
    packageExtractor: (m) => [m[1]!],
  },
  {
    // composer require <pkg>
    regex: /\bcomposer\s+require\s+([\w/.-]+)/gm,
    manager: "composer",
    packageExtractor: (m) => [m[1]!],
  },
];

/**
 * Detect dependency installations from Bash command text.
 * Checks both the command and its output.
 */
export function detectDependencyInstalls(
  command: string,
  output?: string
): DependencyInstall[] {
  const results: DependencyInstall[] = [];
  const textToScan = command;

  for (const pattern of INSTALL_PATTERNS) {
    // Reset regex state for each scan
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(textToScan)) !== null) {
      const packages = pattern.packageExtractor(match);
      if (packages.length > 0) {
        results.push({
          manager: pattern.manager,
          packages,
          command: match[0]!.trim(),
        });
      }
    }
  }

  return results;
}
