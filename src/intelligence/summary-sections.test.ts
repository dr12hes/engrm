import { describe, expect, test } from "bun:test";
import { extractSummaryItems, formatSummaryItems, normalizeSummarySection } from "./summary-sections.js";

describe("summary section normalization", () => {
  test("splits headed bullet blocks into reusable items and dedupes repeated paste", () => {
    const section = `**Deployment:**
- Pushed commit 5fc897c to staging branch
- Ansible deployment completed successfully

**Background processing impact:**
- Bedford Hotel will now be skipped by intelligence_briefing_loop
- Bedford Hotel will now be skipped by vulnerability_scheduler_loop

**Deployment:**
- Pushed commit 5fc897c to staging branch
- Ansible deployment completed successfully`;

    expect(extractSummaryItems(section)).toEqual([
      "Deployment: Pushed commit 5fc897c to staging branch",
      "Deployment: Ansible deployment completed successfully",
      "Background processing impact: Bedford Hotel will now be skipped by intelligence_briefing_loop",
      "Background processing impact: Bedford Hotel will now be skipped by vulnerability_scheduler_loop",
    ]);
  });

  test("formats normalized items into bullet text", () => {
    const section = `Completed:
- Added context-aware growth insight messaging
- Exposed per-project insights as REST API endpoint`;

    expect(formatSummaryItems(section, 200)).toBe(
      "- Added context-aware growth insight messaging\n- Exposed per-project insights as REST API endpoint"
    );
  });

  test("normalizes headed duplicate section text for storage", () => {
    const section = `**Deployment:**
- Pushed commit 5fc897c to staging branch

**Deployment:**
- Pushed commit 5fc897c to staging branch`;

    expect(normalizeSummarySection(section)).toBe(
      "- Deployment: Pushed commit 5fc897c to staging branch"
    );
  });
});
