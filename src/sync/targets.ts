import type { Config } from "../config.js";

export interface SyncTarget {
  key: string;
  apiKey: string;
  namespace: string;
  siteId: string;
  isFleet: boolean;
}

export function isFleetProjectName(projectName: string | null | undefined, config: Config): boolean {
  const fleetProjectName = config.fleet?.project_name ?? "huginn-fleet";
  if (!projectName || !fleetProjectName) return false;
  return projectName.trim().toLowerCase() === fleetProjectName.trim().toLowerCase();
}

export function hasFleetTarget(config: Config): boolean {
  return Boolean(
    config.fleet?.namespace?.trim() &&
    config.fleet?.api_key?.trim() &&
    (config.fleet?.project_name ?? "huginn-fleet").trim()
  );
}

export function resolveSyncTarget(
  config: Config,
  projectName: string | null | undefined
): SyncTarget {
  if (isFleetProjectName(projectName, config) && hasFleetTarget(config)) {
    return {
      key: `fleet:${config.fleet.namespace}`,
      apiKey: config.fleet.api_key,
      namespace: config.fleet.namespace,
      siteId: config.site_id,
      isFleet: true,
    };
  }

  return {
    key: `default:${config.namespace}`,
    apiKey: config.candengo_api_key,
    namespace: config.namespace,
    siteId: config.site_id,
    isFleet: false,
  };
}
