import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normaliseGitRemoteUrl,
  projectNameFromCanonicalId,
  detectProject,
  detectProjectFromTouchedPaths,
} from "./projects.js";

let repoDir: string;

function normalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "engrm-project-test-"));
  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync("git remote add origin https://github.com/dr12hes/engrm.git", {
    cwd: repoDir,
    stdio: "pipe",
  });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("normaliseGitRemoteUrl", () => {
  test("SSH-style git@github.com", () => {
    expect(normaliseGitRemoteUrl("git@github.com:unimpossible/aimy-agent.git")).toBe(
      "github.com/unimpossible/aimy-agent"
    );
  });

  test("HTTPS with .git suffix", () => {
    expect(
      normaliseGitRemoteUrl("https://github.com/unimpossible/aimy-agent.git")
    ).toBe("github.com/unimpossible/aimy-agent");
  });

  test("HTTPS without .git suffix", () => {
    expect(
      normaliseGitRemoteUrl("https://github.com/unimpossible/aimy-agent")
    ).toBe("github.com/unimpossible/aimy-agent");
  });

  test("HTTPS with auth credentials", () => {
    expect(
      normaliseGitRemoteUrl(
        "https://david@github.com/unimpossible/aimy-agent"
      )
    ).toBe("github.com/unimpossible/aimy-agent");
  });

  test("SSH protocol URL", () => {
    expect(
      normaliseGitRemoteUrl(
        "ssh://git@github.com/unimpossible/aimy-agent.git"
      )
    ).toBe("github.com/unimpossible/aimy-agent");
  });

  test("all forms normalise to the same canonical ID", () => {
    const forms = [
      "git@github.com:unimpossible/aimy-agent.git",
      "https://github.com/unimpossible/aimy-agent.git",
      "https://david@github.com/unimpossible/aimy-agent",
      "ssh://git@github.com/unimpossible/aimy-agent.git",
    ];
    const ids = forms.map(normaliseGitRemoteUrl);
    const unique = new Set(ids);
    expect(unique.size).toBe(1);
    expect(ids[0]).toBe("github.com/unimpossible/aimy-agent");
  });

  test("lowercase host", () => {
    expect(normaliseGitRemoteUrl("git@GitHub.COM:Org/Repo.git")).toBe(
      "github.com/Org/Repo"
    );
  });

  test("preserves path case", () => {
    expect(
      normaliseGitRemoteUrl("https://github.com/MyOrg/MyRepo.git")
    ).toBe("github.com/MyOrg/MyRepo");
  });

  test("strips trailing slashes", () => {
    expect(
      normaliseGitRemoteUrl("https://github.com/org/repo/")
    ).toBe("github.com/org/repo");
  });

  test("handles git:// protocol", () => {
    expect(
      normaliseGitRemoteUrl("git://github.com/org/repo.git")
    ).toBe("github.com/org/repo");
  });

  test("does not replace port-like colons", () => {
    // github.com:443/org/repo should NOT treat :443 as SSH-style
    expect(
      normaliseGitRemoteUrl("https://github.com:443/org/repo")
    ).toBe("github.com:443/org/repo");
  });

  test("handles whitespace", () => {
    expect(
      normaliseGitRemoteUrl("  https://github.com/org/repo.git  ")
    ).toBe("github.com/org/repo");
  });

  test("non-GitHub hosts work", () => {
    expect(
      normaliseGitRemoteUrl("git@gitlab.com:team/project.git")
    ).toBe("gitlab.com/team/project");
  });

  test("self-hosted GitLab", () => {
    expect(
      normaliseGitRemoteUrl("git@git.internal.company.com:team/project.git")
    ).toBe("git.internal.company.com/team/project");
  });
});

describe("projectNameFromCanonicalId", () => {
  test("extracts repo name from canonical ID", () => {
    expect(
      projectNameFromCanonicalId("github.com/unimpossible/aimy-agent")
    ).toBe("aimy-agent");
  });

  test("handles single-segment ID", () => {
    expect(projectNameFromCanonicalId("my-project")).toBe("my-project");
  });

  test("handles local/ prefix", () => {
    expect(projectNameFromCanonicalId("local/my-dir")).toBe("my-dir");
  });
});

describe("detectProject", () => {
  test("detects a git repo from its remote", () => {
    const result = detectProject(repoDir);
    expect(result.canonical_id).toBe("github.com/dr12hes/engrm");
    expect(result.name).toBe("engrm");
    expect(normalizePath(result.local_path)).toBe(normalizePath(repoDir));
  });

  test("uses git repo root as local path for nested directories", () => {
    const nested = join(repoDir, "src", "feature");
    mkdirSync(nested, { recursive: true });
    const result = detectProject(nested);
    expect(result.canonical_id).toBe("github.com/dr12hes/engrm");
    expect(normalizePath(result.local_path)).toBe(normalizePath(repoDir));
  });

  test("falls back to directory name for non-git directory", () => {
    const dir = join(tmpdir(), "engrm-non-git");
    mkdirSync(dir, { recursive: true });
    const result = detectProject(dir);
    expect(result.canonical_id).toBe("local/engrm-non-git");
    expect(result.name).toBe("engrm-non-git");
    expect(result.remote_url).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("detectProjectFromTouchedPaths", () => {
  test("prefers the repo owning touched files over fallback cwd", () => {
    const otherRepo = mkdtempSync(join(tmpdir(), "engrm-project-test-other-"));
    execSync("git init", { cwd: otherRepo, stdio: "pipe" });
    execSync("git remote add origin https://github.com/dr12hes/huginn.git", {
      cwd: otherRepo,
      stdio: "pipe",
    });
    mkdirSync(join(otherRepo, "AIServer", "app"), { recursive: true });

    const result = detectProjectFromTouchedPaths(
      [join(otherRepo, "AIServer", "app", "routers.py")],
      repoDir
    );

    expect(result.canonical_id).toBe("github.com/dr12hes/huginn");
    expect(normalizePath(result.local_path)).toBe(normalizePath(otherRepo));

    rmSync(otherRepo, { recursive: true, force: true });
  });
});
