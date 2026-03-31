import { describe, expect, test } from "bun:test";
import { resolveSyncTarget, isFleetProjectName, hasFleetTarget } from "./targets.js";

const baseConfig = {
  candengo_api_key: "cvk_org",
  namespace: "org-ns",
  site_id: "site-1",
  fleet: {
    project_name: "huginn-fleet",
    namespace: "fleet-ns",
    api_key: "cvk_fleet",
  },
} as any;

describe("sync targets", () => {
  test("detects the reserved fleet project name", () => {
    expect(isFleetProjectName("huginn-fleet", baseConfig)).toBe(true);
    expect(isFleetProjectName("HUGINN-FLEET", baseConfig)).toBe(true);
    expect(isFleetProjectName("huginn", baseConfig)).toBe(false);
  });

  test("reports whether fleet routing is configured", () => {
    expect(hasFleetTarget(baseConfig)).toBe(true);
    expect(hasFleetTarget({ ...baseConfig, fleet: { ...baseConfig.fleet, namespace: "" } })).toBe(false);
  });

  test("routes fleet projects to the fleet namespace and key", () => {
    const target = resolveSyncTarget(baseConfig, "huginn-fleet");
    expect(target.isFleet).toBe(true);
    expect(target.namespace).toBe("fleet-ns");
    expect(target.apiKey).toBe("cvk_fleet");
  });

  test("keeps non-fleet projects on the org namespace", () => {
    const target = resolveSyncTarget(baseConfig, "huginn");
    expect(target.isFleet).toBe(false);
    expect(target.namespace).toBe("org-ns");
    expect(target.apiKey).toBe("cvk_org");
  });
});
