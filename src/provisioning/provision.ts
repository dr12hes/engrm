/**
 * Provisioning: exchange a cmt_ token (or OAuth code) for cvk_ API credentials.
 *
 * Calls POST /v1/mem/provision on Candengo Vector.
 * Returns everything needed to write ~/.engrm/settings.json.
 */

export const DEFAULT_CANDENGO_URL = "https://www.candengo.com";

export interface ProvisionRequest {
  /** cmt_ provisioning token from web signup */
  token?: string;
  /** OAuth authorization code from browser flow */
  code?: string;
  /** Device name for identification (e.g. "MacBook Pro") */
  device_name?: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  namespace: string;
}

export interface ProvisionResponse {
  api_key: string; // cvk_...
  site_id: string;
  namespace: string;
  user_id: string;
  user_email: string;
  teams: TeamInfo[];
}

export class ProvisionError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(detail);
    this.name = "ProvisionError";
  }
}

/**
 * Exchange a provisioning token or OAuth code for API credentials.
 */
export async function provision(
  baseUrl: string,
  request: ProvisionRequest
): Promise<ProvisionResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/mem/provision`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? `HTTP ${response.status}`;
    } catch {
      detail = `HTTP ${response.status}`;
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProvisionError(
        response.status,
        "Invalid or expired provisioning token"
      );
    }
    if (response.status === 409) {
      throw new ProvisionError(
        response.status,
        "Token has already been used"
      );
    }
    throw new ProvisionError(response.status, detail);
  }

  const data = (await response.json()) as ProvisionResponse;

  // Validate response
  if (!data.api_key?.startsWith("cvk_")) {
    throw new ProvisionError(0, "Server returned invalid API key format");
  }
  if (!data.site_id || !data.namespace || !data.user_id) {
    throw new ProvisionError(0, "Server returned incomplete credentials");
  }

  return data;
}
