import { describe, expect, test } from "bun:test";
import { reduceRepoScanToMemory } from "./repo-scan.js";

describe("reduceRepoScanToMemory", () => {
  test("reduces risk-heavy findings into pattern memory", () => {
    const memory = reduceRepoScanToMemory({
      findings: [
        {
          kind: "risk",
          title: "Missing auth guard on destructive endpoint",
          severity: "high",
          file: "src/routes/admin.ts",
        },
        {
          kind: "discovery",
          title: "Admin route uses shared middleware stack",
          file: "src/routes/admin.ts",
        },
      ],
    });

    expect(memory.plugin_id).toBe("engrm.repo-scan");
    expect(memory.type).toBe("pattern");
    expect(memory.tags).toContain("risk-finding");
    expect(memory.tags).toContain("severity:high");
    expect(memory.files_read).toContain("src/routes/admin.ts");
  });

  test("reduces discovery-heavy scans into discovery memory", () => {
    const memory = reduceRepoScanToMemory({
      summary: "Mapped auth and billing boundaries across the repo",
      findings: [
        {
          kind: "discovery",
          title: "Billing and auth both flow through account router",
          file: "src/routes/account.ts",
        },
      ],
    });

    expect(memory.type).toBe("discovery");
    expect(memory.title).toContain("Mapped auth and billing boundaries");
    expect(memory.summary).toContain("Mapped auth and billing boundaries");
  });
});
