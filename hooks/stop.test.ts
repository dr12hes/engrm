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
    expect(checkpoint?.type).toBe("feature");
  });

  test("ignores short assistant replies", () => {
    const checkpoint = __testables.extractAssistantCheckpoint("Done. Fixed it.");
    expect(checkpoint).toBeNull();
  });

  test("prefers decision classification for plan-heavy outputs", () => {
    const checkpoint = __testables.extractAssistantCheckpoint(`Decision:
We should move to a unified scanner architecture with one Docker image supporting both transports.

Completed:
- Documented the transport split and the required environment variables

Next Steps:
- Update the plan doc
- Implement the OpenVPN startup path
- Validate CentOS 6 compatibility`);

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.type).toBe("decision");
  });

  test("does not use generic status phrases as the checkpoint title", () => {
    const checkpoint = __testables.extractAssistantCheckpoint(`Here's where things stand:

Completed:
- Event Log now uses the existing events feed
- Requested events are now plumbed into the nav item

Next Steps:
- Make the data available to chat for offline alerts`);

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.title).toBe("Event Log now uses the existing events feed");
  });

  test("skips weak summary-wrapper phrases when picking checkpoint titles", () => {
    const checkpoint = __testables.extractAssistantCheckpoint(`All clean. Here's a summary of what was fixed:

Completed:
- IFTTT actions now actually execute
- Alert rules now use the correct event feed

Next Steps:
- Validate on staging`);

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.title).toBe("IFTTT actions now actually execute");
  });

  test("extracts structured assistant summary sections from rich final output", () => {
    const sections = __testables.extractAssistantSummarySections(`Investigated: Examined the automation system architecture including:
- State tracking and event detection mechanism
- Manifest-based plugin architecture

Learned: Key architectural insights:
- Snapshot comparison is used for efficient state transition detection
- ConnectorManifest enables vendor-specific datasources for UI and AI agents

Completed: Phase 1:
- Created vendor connector manifests
- Registered all three manifests

Next Steps:
1. Users can now create threshold rules
2. No further work required unless user requests additional features.`);

    expect(sections).not.toBeNull();
    expect(sections?.investigated).toContain("State tracking and event detection mechanism");
    expect(sections?.learned).toContain("Snapshot comparison is used for efficient state transition detection");
    expect(sections?.completed).toContain("Created vendor connector manifests");
    expect(sections?.next_steps).toContain("Users can now create threshold rules");
  });
});
