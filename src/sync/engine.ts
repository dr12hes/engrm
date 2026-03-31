/**
 * Sync engine orchestrator.
 *
 * Manages push/pull timers and startup backfill.
 * If sync is not configured (no API key), the engine is a no-op.
 *
 * Timers:
 *   - Push: every config.sync.interval_seconds (default 30s)
 *   - Pull: every 60s
 */

import type { MemDatabase } from "../storage/sqlite.js";
import type { Config } from "../config.js";
import { VectorClient } from "./client.js";
import { pushOutbox } from "./push.js";
import { pullFromVector, pullSettings } from "./pull.js";
import { hasFleetTarget } from "./targets.js";

const DEFAULT_PULL_INTERVAL = 60_000; // 60 seconds

export class SyncEngine {
  private client: VectorClient | null = null;
  private fleetClient: VectorClient | null = null;
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private _pushing = false;
  private _pulling = false;
  private _running = false;

  constructor(
    private readonly db: MemDatabase,
    private readonly config: Config
  ) {
    if (VectorClient.isConfigured(config)) {
      try {
        this.client = new VectorClient(config);
        if (hasFleetTarget(config)) {
          this.fleetClient = new VectorClient(config, {
            apiKey: config.fleet.api_key,
            namespace: config.fleet.namespace,
            siteId: config.site_id,
          });
        }
      } catch {
        // Configuration invalid — stay in offline mode
      }
    }
  }

  /**
   * Start the sync engine.
   * Runs startup backfill, then sets up push/pull timers.
   */
  start(): void {
    if (!this.client || !this.config.sync.enabled) {
      this._running = false;
      return;
    }

    this._running = true;

    // Startup backfill: push any pending outbox items
    this.pushNow().catch(() => {});

    // Push timer
    const pushInterval = this.config.sync.interval_seconds * 1000;
    this.pushTimer = setInterval(() => {
      this.pushNow().catch(() => {});
    }, pushInterval);

    // Pull timer
    this.pullTimer = setInterval(() => {
      this.pullNow().catch(() => {});
    }, DEFAULT_PULL_INTERVAL);
  }

  /**
   * Stop all timers and clean up.
   */
  stop(): void {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
    this._running = false;
  }

  /**
   * Force an immediate push of pending outbox items.
   */
  async pushNow(): Promise<void> {
    if (!this.client || this._pushing) return;
    this._pushing = true;
    try {
      await pushOutbox(
        this.db,
        this.config,
        this.config.sync.batch_size
      );
    } finally {
      this._pushing = false;
    }
  }

  /**
   * Force an immediate pull from Candengo Vector.
   */
  async pullNow(): Promise<void> {
    if (!this.client || this._pulling) return;
    this._pulling = true;
    try {
      await pullFromVector(this.db, this.client, this.config);
      if (this.fleetClient) {
        await pullFromVector(this.db, this.fleetClient, this.config);
      }
      await pullSettings(this.client, this.config);
    } finally {
      this._pulling = false;
    }
  }

  /**
   * Is the sync engine running?
   */
  isRunning(): boolean {
    return this._running;
  }

  /**
   * Is the client configured for remote sync?
   */
  isConfigured(): boolean {
    return this.client !== null;
  }
}
