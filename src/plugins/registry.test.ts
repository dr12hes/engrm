import { describe, expect, test } from "bun:test";
import { getPluginManifest, listPluginManifests, validatePluginId } from "./registry.js";

describe("plugin registry", () => {
  test("lists built-in plugin manifests", () => {
    const manifests = listPluginManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(3);
    expect(manifests.some((manifest) => manifest.id === "engrm.git-diff")).toBe(true);
    expect(manifests.some((manifest) => manifest.id === "engrm.openclaw-content")).toBe(true);
  });

  test("filters manifests by surface", () => {
    const manifests = listPluginManifests("sentinel");
    expect(manifests.every((manifest) => manifest.surfaces.includes("sentinel"))).toBe(true);
    expect(manifests.some((manifest) => manifest.id === "engrm.repo-scan")).toBe(true);
  });

  test("gets a manifest by id", () => {
    const manifest = getPluginManifest("engrm.git-diff");
    expect(manifest?.name).toBe("Git Diff");
  });

  test("validates plugin ids", () => {
    expect(validatePluginId("engrm.git-diff")).toBeNull();
    expect(validatePluginId("")).toContain("required");
    expect(validatePluginId("bad id")).toContain("stable dotted identifier");
  });
});
