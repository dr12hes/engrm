import { describe, expect, test } from "bun:test";
import { __testables } from "./stop.js";

describe("stop hook assistant checkpoint extraction", () => {
  test("extracts a useful assistant checkpoint from substantial output", () => {
    const checkpoint = __testables.extractAssistantCheckpoint(`Completed: Deployment
- Pushed commit 5fc897c to staging branch
- Ansible deployment completed successfully with 18 tasks OK and 0 failures
- Bedford Hotel now appears as inactive in the site list

Next Steps:
- Watch logs for Bedford being skipped in the next intelligence briefing cycle
- Compare token usage over the next few days`);

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.title).toContain("Pushed commit 5fc897c");
    expect(checkpoint?.facts).toContain("Ansible deployment completed successfully with 18 tasks OK and 0 failures");
  });

  test("ignores short assistant replies", () => {
    const checkpoint = __testables.extractAssistantCheckpoint("Done. Fixed it.");
    expect(checkpoint).toBeNull();
  });
});
