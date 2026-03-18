import { describe, test, expect } from "bun:test";
import { listPacks, loadPack } from "./loader.js";

describe("pack loader", () => {
  test("listPacks returns available packs", () => {
    const packs = listPacks();
    expect(packs).toContain("web-security");
    expect(packs).toContain("react-gotchas");
    expect(packs).toContain("api-best-practices");
  });

  test("loadPack loads a valid pack", () => {
    const pack = loadPack("web-security");
    expect(pack).not.toBeNull();
    expect(pack!.name).toBe("web-security");
    expect(pack!.observations.length).toBeGreaterThan(10);

    // Verify observation structure
    const obs = pack!.observations[0]!;
    expect(obs.type).toBeDefined();
    expect(obs.title).toBeDefined();
    expect(obs.concepts).toBeDefined();
  });

  test("loadPack returns null for unknown pack", () => {
    const pack = loadPack("nonexistent-pack");
    expect(pack).toBeNull();
  });

  test("all packs have valid observation types", () => {
    const validTypes = ["bugfix", "discovery", "decision", "pattern", "change", "feature", "refactor", "digest"];
    for (const packName of listPacks()) {
      const pack = loadPack(packName);
      expect(pack).not.toBeNull();
      for (const obs of pack!.observations) {
        expect(validTypes).toContain(obs.type);
      }
    }
  });
});
