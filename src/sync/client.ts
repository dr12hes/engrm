/**
 * Candengo Vector REST client.
 *
 * Wraps the Vector API for ingest, search, and delete operations.
 * Uses Bun's built-in fetch — no external HTTP dependencies.
 */

import type { Config } from "../config.js";
import { getApiKey, getBaseUrl } from "./auth.js";

// --- Types ---

export interface VectorDocument {
  site_id: string;
  namespace: string;
  source_type: string;
  source_id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface VectorSearchResult {
  source_id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorSearchResponse {
  results: VectorSearchResult[];
  total?: number;
}

export interface VectorChangeFeedResponse {
  changes: VectorSearchResult[];
  cursor: string;
  has_more: boolean;
}

export interface VectorClientOverrides {
  apiKey?: string;
  siteId?: string;
  namespace?: string;
}

// --- Client ---

export class VectorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly siteId: string;
  readonly namespace: string;

  constructor(config: Config, overrides: VectorClientOverrides = {}) {
    const baseUrl = getBaseUrl(config);
    const apiKey = overrides.apiKey ?? getApiKey(config);

    if (!baseUrl || !apiKey) {
      throw new Error(
        "VectorClient requires candengo_url and candengo_api_key"
      );
    }

    this.baseUrl = baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.apiKey = apiKey;
    this.siteId = overrides.siteId ?? config.site_id;
    this.namespace = overrides.namespace ?? config.namespace;
  }

  /**
   * Check if the client has valid configuration.
   */
  static isConfigured(config: Config): boolean {
    return getApiKey(config) !== null && getBaseUrl(config) !== null;
  }

  /**
   * Ingest a single document.
   */
  async ingest(doc: VectorDocument): Promise<void> {
    await this.request("POST", "/v1/ingest", doc);
  }

  /**
   * Batch ingest multiple documents.
   */
  async batchIngest(docs: VectorDocument[]): Promise<void> {
    if (docs.length === 0) return;
    await this.request("POST", "/v1/ingest/batch", { documents: docs });
  }

  /**
   * Semantic search with optional metadata filters.
   */
  async search(
    query: string,
    metadataFilter?: Record<string, string>,
    limit: number = 10
  ): Promise<VectorSearchResponse> {
    const body: Record<string, unknown> = { query: query, limit: limit };
    if (metadataFilter) {
      body.metadata_filter = metadataFilter;
    }
    return this.request("POST", "/v1/search", body);
  }

  /**
   * Delete documents by source IDs.
   */
  async deleteBySourceIds(sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.request("POST", "/v1/documents/delete", {
      source_ids: sourceIds,
    });
  }

  /**
   * Pull changes from the sync change feed.
   */
  async pullChanges(
    cursor?: string,
    limit: number = 50
  ): Promise<VectorChangeFeedResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    params.set("namespace", this.namespace);
    params.set("limit", String(limit));
    return this.request("GET", `/v1/sync/changes?${params.toString()}`);
  }

  /**
   * Send a telemetry beacon.
   */
  async sendTelemetry(beacon: unknown): Promise<void> {
    await this.request("POST", "/v1/mem/telemetry", beacon);
  }

  /**
   * Fetch user settings from the server.
   * Returns null if the endpoint is unavailable or returns an error.
   */
  async fetchSettings(): Promise<Record<string, unknown> | null> {
    try {
      return await this.request("GET", "/v1/mem/user-settings");
    } catch {
      return null;
    }
  }

  /**
   * Health check.
   */
  async health(): Promise<boolean> {
    try {
      await this.request("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }

  // --- Internal ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const init: RequestInit = { method, headers };
    if (body && method !== "GET") {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new VectorApiError(response.status, text, path);
    }

    // Some endpoints (DELETE, ingest) may return 204 with no body
    if (
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    ) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}

export class VectorApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string
  ) {
    super(`Vector API error ${status} on ${path}: ${body}`);
    this.name = "VectorApiError";
  }
}
