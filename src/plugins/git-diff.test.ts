import { describe, expect, test } from "bun:test";
import { reduceGitDiffToMemory } from "./git-diff.js";

describe("reduceGitDiffToMemory", () => {
  test("reduces a bugfix diff into plugin memory", () => {
    const memory = reduceGitDiffToMemory({
      summary: "Fix token refresh retry path",
      diff: `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,7 @@
-const token = staleToken;
+const token = refreshedToken;
+if (!token) {
+  throw new Error("missing token");
+}
`,
    });

    expect(memory.plugin_id).toBe("engrm.git-diff");
    expect(memory.type).toBe("bugfix");
    expect(memory.title).toContain("Fix token refresh retry path");
    expect(memory.files_modified).toContain("src/auth.ts");
    expect(memory.facts?.some((fact) => fact.includes("Diff footprint"))).toBe(true);
  });

  test("detects refactor-oriented diffs", () => {
    const memory = reduceGitDiffToMemory({
      diff: `diff --git a/src/old.ts b/src/new.ts
similarity index 98%
rename from src/old.ts
rename to src/new.ts`,
    });

    expect(memory.type).toBe("refactor");
    expect(memory.title).toContain("Refactor");
  });

  test("detects feature additions from new files", () => {
    const memory = reduceGitDiffToMemory({
      diff: `diff --git a/src/new-feature.ts b/src/new-feature.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new-feature.ts
@@ -0,0 +1,5 @@
+export function enableDashboardFeature() {
+  return true;
+}`,
    });

    expect(memory.type).toBe("feature");
    expect(memory.files_modified).toContain("src/new-feature.ts");
  });
});
