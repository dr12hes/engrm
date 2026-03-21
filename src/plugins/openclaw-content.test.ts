import { describe, expect, test } from "bun:test";
import { reduceOpenClawContentToMemory } from "./openclaw-content.js";

describe("reduceOpenClawContentToMemory", () => {
  test("reduces posted and researched content work into memory", () => {
    const memory = reduceOpenClawContentToMemory({
      title: "Thursday teaser thread and competitive scan",
      posted: [
        "Posted Thursday teaser thread about observation capture latency",
      ],
      researched: [
        "Reviewed competitor positioning around context loss and cross-device memory",
      ],
      outcomes: [
        "Prepared stronger launch copy for the next content slot",
      ],
      next_actions: [
        "Follow up with an authority thread on cross-agent memory",
      ],
      links: [
        "https://x.com/engrm_dev/status/123",
      ],
    });

    expect(memory.plugin_id).toBe("engrm.openclaw-content");
    expect(memory.type).toBe("decision");
    expect(memory.tags).toContain("posted");
    expect(memory.tags).toContain("researched");
    expect(memory.source).toBe("openclaw");
    expect(memory.source_refs).toEqual([
      { kind: "thread", value: "https://x.com/engrm_dev/status/123" },
    ]);
    expect(memory.summary).toContain("Posted:");
    expect(memory.summary).toContain("Researched:");
    expect(memory.summary).toContain("Next Actions:");
  });
});
