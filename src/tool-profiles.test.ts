import { describe, expect, test } from "bun:test";

import { MEMORY_PROFILE_TOOLS, getEnabledToolNames, isToolEnabled } from "./tool-profiles.js";

describe("tool profiles", () => {
  test("full profile enables all tools", () => {
    expect(getEnabledToolNames("full")).toBeNull();
    expect(isToolEnabled("full", "memory_console")).toBe(true);
  });

  test("memory profile exposes only the reduced shared-learning surface", () => {
    const enabled = getEnabledToolNames("memory");
    expect(enabled).not.toBeNull();
    expect(Array.from(enabled ?? [])).toEqual(MEMORY_PROFILE_TOOLS as unknown as string[]);
    expect(isToolEnabled("memory", "save_observation")).toBe(true);
    expect(isToolEnabled("memory", "search_recall")).toBe(true);
    expect(isToolEnabled("memory", "resume_thread")).toBe(true);
    expect(isToolEnabled("memory", "create_handoff")).toBe(false);
    expect(isToolEnabled("memory", "memory_console")).toBe(false);
    expect(isToolEnabled("memory", "capture_repo_scan")).toBe(false);
  });
});
