import { describe, test, expect } from "bun:test";
import { listRulePacks, loadRulePack } from "./rules.js";

describe("sentinel rule packs", () => {
  test("lists all 5 rule packs", () => {
    const packs = listRulePacks();
    expect(packs).toContain("security");
    expect(packs).toContain("auth");
    expect(packs).toContain("api");
    expect(packs).toContain("react");
    expect(packs).toContain("database");
    expect(packs.length).toBe(5);
  });

  test("loads security rule pack with observations", () => {
    const pack = loadRulePack("security");
    expect(pack).not.toBeNull();
    expect(pack!.name).toBe("security");
    expect(pack!.observations.length).toBeGreaterThan(10);
  });

  test("all rule pack observations are type 'standard'", () => {
    for (const name of listRulePacks()) {
      const pack = loadRulePack(name);
      expect(pack).not.toBeNull();
      for (const obs of pack!.observations) {
        expect(obs.type).toBe("standard");
        expect(obs.title.length).toBeGreaterThan(10);
        expect(obs.facts).toBeDefined();
        expect(obs.facts!.length).toBeGreaterThan(0);
      }
    }
  });

  test("returns null for unknown pack", () => {
    expect(loadRulePack("nonexistent")).toBeNull();
  });
});
