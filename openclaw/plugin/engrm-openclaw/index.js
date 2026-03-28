import { createHash, randomBytes } from "node:crypto";
import { execSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

const ENGRM_DIR = join(homedir(), ".engrm");
const SETTINGS_PATH = join(ENGRM_DIR, "settings.json");
const DB_PATH = join(ENGRM_DIR, "engrm.db");
const IMPLEMENTATION_TYPES = new Set(["feature", "bugfix", "change", "refactor"]);

let db = null;
let logger = console;
let pluginConfig = {
  enabled: true,
  autoStartupBrief: true,
  autoSessionDigest: true,
  baseUrl: "https://engrm.dev",
  maxRelevantObservations: 4,
};

const recentUserPrompts = new Map();
const lastSavedDigestHashes = new Map();
let connectFlow = null;
const CALLBACK_TIMEOUT_MS = 120_000;

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function replyText(text) {
  return { text };
}

function truncate(text, max = 240) {
  if (!text) return "";
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}...`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderConnectCallbackPage({ title, message, tone = "success" }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const primary = tone === "error" ? "#ef4444" : "#00d4ff";
  const secondary = tone === "error" ? "#f97316" : "#7b2cbf";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    :root {
      --primary: ${primary};
      --secondary: ${secondary};
      --bg-dark: #06060e;
      --text: #ffffff;
      --text-secondary: rgba(255,255,255,0.76);
      --border: rgba(255,255,255,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg-dark);
      color: var(--text);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      background:
        radial-gradient(ellipse at 30% 20%, rgba(0,212,255,0.10) 0%, transparent 50%),
        radial-gradient(ellipse at 70% 80%, rgba(123,44,191,0.10) 0%, transparent 50%);
    }
    .card {
      width: 100%;
      max-width: 520px;
      padding: 36px;
      border-radius: 18px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
      backdrop-filter: blur(18px);
      box-shadow: 0 18px 60px rgba(0,0,0,0.26);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
      font-weight: 700;
      font-size: 1.18rem;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.72rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--primary);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 1.55rem;
    }
    p {
      margin: 0;
      color: var(--text-secondary);
      line-height: 1.6;
      font-size: 0.96rem;
    }
    .tip {
      margin-top: 22px;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
      color: var(--text-secondary);
      font-size: 0.88rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:36px;height:36px;">
        <rect width="40" height="40" rx="10" fill="#0c0c1e"/>
        <rect x="0.5" y="0.5" width="39" height="39" rx="9.5" stroke="rgba(255,255,255,0.08)"/>
        <path d="M12 12h10M12 20h8M12 28h10M12 12v16" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="13" cy="7" r="3" fill="${primary}"/>
        <circle cx="33" cy="33" r="3" fill="${secondary}"/>
      </svg>
      <span>Engrm</span>
      <span class="badge">OpenClaw</span>
    </div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <div class="tip">You can close this tab and return to OpenClaw.</div>
  </div>
</body>
</html>`;
}

function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function ensureConfigDir() {
  mkdirSync(ENGRM_DIR, { recursive: true });
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function generateDeviceId() {
  const host = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "");
  const suffix = createHash("sha256").update(`${host}:openclaw`).digest("hex").slice(0, 8);
  return `${host}-${suffix}`;
}

function getDb() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  db = new BetterSqlite3(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function buildSourceId(settings, localId, type = "obs") {
  return `${settings.user_id}-${settings.device_id}-${type}-${localId}`;
}

function parseJsonSafe(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function engrmRequest(settings, path, { method = "GET", body } = {}) {
  const baseUrl = String(settings.candengo_url || pluginConfig.baseUrl || "https://engrm.dev").replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${settings.candengo_api_key}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function bootstrapSchema(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      local_path TEXT,
      remote_url TEXT,
      first_seen_epoch INTEGER NOT NULL,
      last_active_epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      narrative TEXT,
      facts TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      quality REAL DEFAULT 0.5,
      lifecycle TEXT DEFAULT 'active',
      sensitivity TEXT DEFAULT 'shared',
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      agent TEXT DEFAULT 'openclaw',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      archived_at_epoch INTEGER,
      compacted_into INTEGER,
      superseded_by INTEGER,
      remote_source_id TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project_id INTEGER REFERENCES projects(id),
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      agent TEXT DEFAULT 'openclaw',
      status TEXT DEFAULT 'active',
      observation_count INTEGER DEFAULT 0,
      started_at_epoch INTEGER,
      completed_at_epoch INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project_id INTEGER REFERENCES projects(id),
      user_id TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      created_at_epoch INTEGER
    );
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_type TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 10,
      last_error TEXT,
      created_at_epoch INTEGER NOT NULL,
      synced_at_epoch INTEGER,
      next_retry_epoch INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, narrative, facts, concepts, content='',
      tokenize='porter unicode61'
    );
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch);
    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status, next_retry_epoch);
  `);
}

function sanitiseFtsQuery(query) {
  const normalised = String(query ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return "";
  const terms = normalised
    .split(" ")
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 16);
  if (terms.length === 0) return "";
  return terms.map((term) => `"${term}"`).join(" ");
}

function normaliseGitRemoteUrl(remoteUrl) {
  let url = String(remoteUrl).trim();
  url = url.replace(/^(?:https?|ssh|git):\/\//, "");
  url = url.replace(/^[^@]+@/, "");
  url = url.replace(/^([^/:]+):(?!\d)/, "$1/");
  url = url.replace(/\.git$/, "");
  url = url.replace(/\/+$/, "");
  const slashIndex = url.indexOf("/");
  if (slashIndex !== -1) {
    url = `${url.slice(0, slashIndex).toLowerCase()}${url.slice(slashIndex)}`;
  } else {
    url = url.toLowerCase();
  }
  return url;
}

function detectProject(directory) {
  const dir = directory || process.cwd();
  let remoteUrl = null;
  try {
    remoteUrl = execSync("git remote get-url origin", {
      cwd: dir,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    remoteUrl = null;
  }

  if (remoteUrl) {
    const canonicalId = normaliseGitRemoteUrl(remoteUrl);
    return {
      canonical_id: canonicalId,
      name: canonicalId.split("/").pop() || canonicalId,
      remote_url: remoteUrl,
      local_path: dir,
    };
  }

  return {
    canonical_id: `local/${basename(dir)}`,
    name: basename(dir),
    remote_url: null,
    local_path: dir,
  };
}

function findProjectForWorkspace(conn, workspaceDir) {
  if (!workspaceDir) {
    return (
      conn
        .prepare("SELECT * FROM projects ORDER BY last_active_epoch DESC LIMIT 1")
        .get() || null
    );
  }

  const byPath =
    conn
      .prepare(
        `SELECT *
         FROM projects
         WHERE local_path IS NOT NULL
           AND (? = local_path OR ? LIKE local_path || '/%')
         ORDER BY length(local_path) DESC
         LIMIT 1`
      )
      .get(workspaceDir, workspaceDir) || null;

  if (byPath) return byPath;

  const detected = detectProject(workspaceDir);
  return (
    conn
      .prepare("SELECT * FROM projects WHERE canonical_id = ? LIMIT 1")
      .get(detected.canonical_id) || null
  );
}

function ensureProject(conn, workspaceDir) {
  const detected = detectProject(workspaceDir || process.cwd());
  const now = Math.floor(Date.now() / 1000);
  const existing =
    conn
      .prepare("SELECT * FROM projects WHERE canonical_id = ? LIMIT 1")
      .get(detected.canonical_id) || null;

  if (existing) {
    conn
      .prepare(
        `UPDATE projects
         SET local_path = COALESCE(?, local_path),
             remote_url = COALESCE(?, remote_url),
             last_active_epoch = ?
         WHERE id = ?`
      )
      .run(detected.local_path, detected.remote_url, now, existing.id);
    return { ...existing, ...detected, id: existing.id, last_active_epoch: now };
  }

  const result = conn
    .prepare(
      `INSERT INTO projects (canonical_id, name, local_path, remote_url, first_seen_epoch, last_active_epoch)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      detected.canonical_id,
      detected.name,
      detected.local_path,
      detected.remote_url,
      now,
      now
    );

  return conn.prepare("SELECT * FROM projects WHERE id = ?").get(Number(result.lastInsertRowid));
}

function getRecentSummaries(conn, projectId, userId, limit = 2) {
  return conn
    .prepare(
      `SELECT *
       FROM session_summaries
       WHERE (? IS NULL OR project_id = ?)
         AND (? IS NULL OR user_id = ?)
       ORDER BY created_at_epoch DESC
       LIMIT ?`
    )
    .all(projectId, projectId, userId, userId, limit);
}

function getRecentObservations(conn, { projectId, userId, limit = 5, type = null }) {
  return conn
    .prepare(
      `SELECT observations.*, projects.name AS project_name
       FROM observations
       LEFT JOIN projects ON projects.id = observations.project_id
       WHERE lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         AND (? IS NULL OR project_id = ?)
         AND (? IS NULL OR type = ?)
         AND (? IS NULL OR sensitivity != 'personal' OR user_id = ?)
       ORDER BY created_at_epoch DESC
       LIMIT ?`
    )
    .all(projectId, projectId, type, type, userId, userId, limit);
}

function getPendingOutboxEntries(conn, limit = 50) {
  const now = nowEpoch();
  return conn
    .prepare(
      `SELECT *
       FROM sync_outbox
       WHERE status = 'pending'
          OR (status = 'failed' AND retry_count < max_retries AND (next_retry_epoch IS NULL OR next_retry_epoch <= ?))
       ORDER BY created_at_epoch ASC
       LIMIT ?`
    )
    .all(now, limit);
}

function markOutboxSyncing(conn, id) {
  conn.prepare("UPDATE sync_outbox SET status = 'syncing' WHERE id = ?").run(id);
}

function markOutboxSynced(conn, id) {
  conn
    .prepare("UPDATE sync_outbox SET status = 'synced', synced_at_epoch = ? WHERE id = ?")
    .run(nowEpoch(), id);
}

function markOutboxFailed(conn, id, error) {
  const now = nowEpoch();
  conn
    .prepare(
      `UPDATE sync_outbox SET
         status = 'failed',
         retry_count = retry_count + 1,
         last_error = ?,
         next_retry_epoch = ? + MIN(30 * (1 << retry_count), 3600)
       WHERE id = ?`
    )
    .run(String(error).slice(0, 500), now, id);
}

function buildCloudObservationDocument(settings, obs, project) {
  const parts = [obs.title];
  if (obs.narrative) parts.push(obs.narrative);
  const facts = parseJsonSafe(obs.facts, []);
  if (Array.isArray(facts) && facts.length > 0) {
    parts.push(`Facts:\n${facts.map((item) => `- ${item}`).join("\n")}`);
  }

  return {
    site_id: settings.site_id,
    namespace: settings.namespace,
    source_type: obs.type,
    source_id: buildSourceId(settings, obs.id),
    content: parts.join("\n\n"),
    metadata: {
      project_canonical: project.canonical_id,
      project_name: project.name,
      user_id: obs.user_id,
      device_id: obs.device_id,
      device_name: hostname(),
      agent: obs.agent || "openclaw",
      title: obs.title,
      narrative: obs.narrative,
      type: obs.type,
      quality: obs.quality,
      facts,
      concepts: parseJsonSafe(obs.concepts, []),
      files_read: parseJsonSafe(obs.files_read, []),
      files_modified: parseJsonSafe(obs.files_modified, []),
      session_id: obs.session_id,
      created_at_epoch: obs.created_at_epoch,
      created_at: obs.created_at,
      sensitivity: obs.sensitivity,
      local_id: obs.id,
    },
  };
}

function buildCloudSummaryDocument(settings, summary, project) {
  const parts = [];
  if (summary.request) parts.push(`Request: ${summary.request}`);
  if (summary.investigated) parts.push(`Investigated: ${summary.investigated}`);
  if (summary.learned) parts.push(`Learned: ${summary.learned}`);
  if (summary.completed) parts.push(`Completed: ${summary.completed}`);
  if (summary.next_steps) parts.push(`Next steps: ${summary.next_steps}`);

  return {
    site_id: settings.site_id,
    namespace: settings.namespace,
    source_type: "summary",
    source_id: buildSourceId(settings, summary.id, "summary"),
    content: parts.join("\n\n"),
    metadata: {
      project_canonical: project.canonical_id,
      project_name: project.name,
      user_id: summary.user_id,
      device_id: settings.device_id,
      device_name: hostname(),
      agent: "openclaw",
      title: summary.completed || summary.request || `Session brief for ${project.name || "current context"}`,
      session_id: summary.session_id,
      created_at_epoch: summary.created_at_epoch,
      local_id: summary.id,
      type: "summary",
    },
  };
}

async function flushPendingToCloud(conn, settings, batchSize = 50) {
  if (!settings?.candengo_api_key || settings?.sync?.enabled === false) return { pushed: 0, failed: 0, skipped: 0 };

  const entries = getPendingOutboxEntries(conn, batchSize);
  if (entries.length === 0) return { pushed: 0, failed: 0, skipped: 0 };

  const docs = [];
  const meta = [];
  let skipped = 0;

  for (const entry of entries) {
    try {
      if (entry.record_type === "summary") {
        const summary = conn.prepare("SELECT * FROM session_summaries WHERE id = ?").get(entry.record_id);
        if (!summary || !summary.project_id) {
          markOutboxSynced(conn, entry.id);
          skipped += 1;
          continue;
        }
        const project = conn.prepare("SELECT * FROM projects WHERE id = ?").get(summary.project_id);
        if (!project) {
          markOutboxSynced(conn, entry.id);
          skipped += 1;
          continue;
        }
        markOutboxSyncing(conn, entry.id);
        docs.push(buildCloudSummaryDocument(settings, summary, project));
        meta.push({ entryId: entry.id });
        continue;
      }

      if (entry.record_type !== "observation") {
        markOutboxSynced(conn, entry.id);
        skipped += 1;
        continue;
      }

      const obs = conn.prepare("SELECT * FROM observations WHERE id = ?").get(entry.record_id);
      if (!obs || obs.lifecycle === "archived" || obs.lifecycle === "purged" || obs.sensitivity === "secret") {
        markOutboxSynced(conn, entry.id);
        skipped += 1;
        continue;
      }
      const project = conn.prepare("SELECT * FROM projects WHERE id = ?").get(obs.project_id);
      if (!project) {
        markOutboxSynced(conn, entry.id);
        skipped += 1;
        continue;
      }
      markOutboxSyncing(conn, entry.id);
      docs.push(buildCloudObservationDocument(settings, obs, project));
      meta.push({ entryId: entry.id });
    } catch (error) {
      markOutboxFailed(conn, entry.id, error?.message || error);
    }
  }

  if (docs.length === 0) return { pushed: 0, failed: 0, skipped };

  try {
    await engrmRequest(settings, "/v1/ingest/batch", { method: "POST", body: { documents: docs } });
    for (const item of meta) markOutboxSynced(conn, item.entryId);
    return { pushed: meta.length, failed: 0, skipped };
  } catch {
    let pushed = 0;
    let failed = 0;
    for (let i = 0; i < docs.length; i += 1) {
      try {
        await engrmRequest(settings, "/v1/ingest", { method: "POST", body: docs[i] });
        markOutboxSynced(conn, meta[i].entryId);
        pushed += 1;
      } catch (error) {
        markOutboxFailed(conn, meta[i].entryId, error?.message || error);
        failed += 1;
      }
    }
    return { pushed, failed, skipped };
  }
}

async function searchCloudMemory(settings, { query, limit = 6 }) {
  if (!settings?.candengo_api_key || !query) return [];
  const response = await engrmRequest(settings, "/v1/search", {
    method: "POST",
    body: {
      query,
      site_id: settings.site_id,
      limit: Math.max(1, Math.min(Number(limit || 6), 12)),
      source_types: ["decision", "discovery", "bugfix", "feature", "refactor", "change", "digest", "summary"],
    },
  });
  return Array.isArray(response?.results) ? response.results : [];
}

function normaliseCloudResults(results) {
  return results.map((row) => ({
    title: row?.metadata?.title || row?.content?.split("\n")[0] || "Untitled",
    type: row?.metadata?.type || row?.source_type || "memory",
    narrative: row?.metadata?.narrative || row?.content || "",
  }));
}

function mergeRelevantMemory(localRows, cloudRows, limit = 6) {
  const merged = [];
  const seen = new Set();
  for (const row of [...localRows, ...cloudRows]) {
    const key = `${String(row.title || "").toLowerCase()}|${String(row.type || "").toLowerCase()}`;
    if (!row?.title || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return merged;
}

async function sendSessionTelemetry(conn, settings, sessionId, metrics = {}) {
  if (!settings?.candengo_api_key) return;
  const session =
    conn
      .prepare("SELECT * FROM sessions WHERE session_id = ? LIMIT 1")
      .get(sessionId) || null;
  if (!session) return;

  const observations = getSessionObservations(conn, sessionId, settings.user_id || null);
  const byType = {};
  for (const obs of observations) {
    byType[obs.type] = (byType[obs.type] || 0) + 1;
  }
  const filesTouched = new Set();
  for (const obs of observations) {
    for (const file of parseJsonSafe(obs.files_modified, [])) filesTouched.add(file);
  }
  const duration = Math.max(
    0,
    Number(session.completed_at_epoch || nowEpoch()) - Number(session.started_at_epoch || nowEpoch())
  );
  const stacks = Array.from(filesTouched)
    .map((file) => {
      if (String(file).endsWith(".ts") || String(file).endsWith(".tsx")) return "typescript";
      if (String(file).endsWith(".py")) return "python";
      if (String(file).endsWith(".rb")) return "ruby";
      if (String(file).endsWith(".go")) return "go";
      return null;
    })
    .filter(Boolean);

  await engrmRequest(settings, "/v1/mem/telemetry", {
    method: "POST",
    body: {
      device_id: settings.device_id,
      agent: "openclaw",
      session_duration_s: duration,
      observation_count: observations.length,
      observations_by_type: byType,
      tool_calls_count: 0,
      files_touched_count: filesTouched.size,
      searches_performed: Number(metrics.searchCount || 0),
      observer_events: 0,
      observer_observations: 0,
      observer_skips: 0,
      sentinel_used: false,
      risk_score: 0,
      stacks_detected: [...new Set(stacks)],
      client_version: "0.4.3-openclaw",
      context_observations_injected: Number(metrics.contextObsInjected || 0),
      context_total_available: Number(metrics.contextTotalAvailable || 0),
      recall_attempts: Number(metrics.recallAttempts || 0),
      recall_hits: Number(metrics.recallHits || 0),
      search_count: Number(metrics.searchCount || 0),
      search_results_total: Number(metrics.searchResultsTotal || 0),
    },
  });
}

function searchObservations(conn, { query, projectId, userId, limit = 5 }) {
  const safeQuery = sanitiseFtsQuery(query);
  if (!safeQuery) return [];
  return conn
    .prepare(
      `SELECT observations.*, bm25(observations_fts) AS score
       FROM observations_fts
       JOIN observations ON observations.id = observations_fts.rowid
       WHERE observations_fts MATCH ?
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         AND (? IS NULL OR project_id = ?)
         AND (? IS NULL OR sensitivity != 'personal' OR user_id = ?)
       ORDER BY score
       LIMIT ?`
    )
    .all(safeQuery, projectId, projectId, userId, userId, limit);
}

function getSessionObservations(conn, sessionId, userId) {
  return conn
    .prepare(
      `SELECT *
       FROM observations
       WHERE session_id = ?
         AND (? IS NULL OR sensitivity != 'personal' OR user_id = ?)
       ORDER BY created_at_epoch ASC`
    )
    .all(sessionId, userId, userId);
}

function getStaleDecisions(conn, projectId, userId, limit = 3) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 30 * 86400;
  const staleThreshold = now - 3 * 86400;

  const decisions = conn
    .prepare(
      `SELECT *
       FROM observations
       WHERE type = 'decision'
         AND created_at_epoch >= ?
         AND created_at_epoch <= ?
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         AND (? IS NULL OR project_id = ?)
         AND (? IS NULL OR sensitivity != 'personal' OR user_id = ?)
       ORDER BY created_at_epoch DESC
       LIMIT 25`
    )
    .all(windowStart, staleThreshold, projectId, projectId, userId, userId);

  const implementations = conn
    .prepare(
      `SELECT *
       FROM observations
       WHERE type IN ('feature', 'bugfix', 'change', 'refactor')
         AND created_at_epoch >= ?
         AND lifecycle IN ('active', 'aging', 'pinned')
         AND superseded_by IS NULL
         AND (? IS NULL OR sensitivity != 'personal' OR user_id = ?)
       ORDER BY created_at_epoch DESC
       LIMIT 200`
    )
    .all(windowStart, userId, userId);

  const stale = [];
  for (const decision of decisions) {
    let bestScore = 0;
    let bestMatch = null;
    for (const impl of implementations) {
      if (impl.created_at_epoch <= decision.created_at_epoch) continue;
      const score = jaccard(decision.title, impl.title);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = impl;
      }
    }
    if (bestScore < 0.25) {
      stale.push({
        title: decision.title,
        ageDays: Math.floor((now - decision.created_at_epoch) / 86400),
        bestMatch: bestMatch?.title ?? null,
      });
    }
  }
  return stale.slice(0, limit);
}

function jaccard(a, b) {
  const tokensA = new Set(String(a).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((x) => x.length > 2));
  const tokensB = new Set(String(b).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((x) => x.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : overlap / union;
}

function formatStartupBrief({ project, summaries, relevant, staleDecisions }) {
  const lines = [
    "Engrm memory brief:",
    project ? `Current context: ${project.name}` : "Current context: recent shared memory",
  ];

  if (summaries.length > 0) {
    const latest = summaries[0];
    lines.push("");
    lines.push("Latest session brief:");
    if (latest.request) lines.push(`- Asked: ${truncate(latest.request, 180)}`);
    if (latest.investigated) lines.push(`- Investigated: ${truncate(latest.investigated, 180)}`);
    if (latest.learned) lines.push(`- Learned: ${truncate(latest.learned, 180)}`);
    if (latest.completed) lines.push(`- Completed: ${truncate(latest.completed, 180)}`);
    if (latest.next_steps) lines.push(`- Next steps: ${truncate(latest.next_steps, 180)}`);
  }

  if (relevant.length > 0) {
    lines.push("");
    lines.push("Relevant memory for this run:");
    for (const obs of relevant) {
      const suffix = obs.type ? ` (${obs.type})` : "";
      lines.push(`- ${truncate(obs.title, 120)}${suffix}`);
    }
  }

  if (staleDecisions.length > 0) {
    lines.push("");
    lines.push("Decisions or intended next steps that may not have been followed through:");
    for (const item of staleDecisions) {
      lines.push(`- ${truncate(item.title, 120)} (${item.ageDays}d old)`);
    }
  }

  return lines.join("\n");
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function extractLatestAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      return extractTextContent(msg.content);
    }
  }
  return "";
}

function extractLatestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user") {
      return extractTextContent(msg.content);
    }
  }
  return "";
}

function cleanWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function stripFencedBlocks(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, " ").trim();
}

function isOpenClawBootstrapPrompt(text) {
  const clean = cleanWhitespace(text);
  if (!clean) return false;
  return (
    /A new session was started via \/new or \/reset/i.test(clean) ||
    /Execute your Session Startup sequence now/i.test(clean) ||
    /read the required files before responding/i.test(clean)
  );
}

function isMetadataBlob(text) {
  const clean = cleanWhitespace(text);
  if (!clean) return false;
  return (
    /Conversation info \(untrusted metadata\)/i.test(clean) ||
    /Sender \(untrusted metadata\)/i.test(clean) ||
    /"message_id"\s*:/i.test(clean)
  );
}

function isOpenClawGreeting(text) {
  const clean = cleanWhitespace(text);
  if (!clean) return false;
  return (
    /^hey\b/i.test(clean) &&
    (/fresh session/i.test(clean) || /what are we doing\?/i.test(clean))
  );
}

function extractMarkdownHeading(text) {
  const lines = String(text || "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) {
      return line.replace(/^#{1,6}\s+/, "").trim();
    }
    if (/^\*\*.+\*\*$/.test(line) && line.length < 160) {
      return line.replace(/^\*\*|\*\*$/g, "").trim();
    }
  }
  return "";
}

function firstUsefulParagraph(text) {
  const paragraphs = stripFencedBlocks(text)
    .split(/\n\s*\n/)
    .map((part) => cleanWhitespace(part))
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    if (isOpenClawGreeting(paragraph) || isMetadataBlob(paragraph)) continue;
    return paragraph;
  }
  return "";
}

function extractBulletItems(text, limit = 3) {
  const items = [];
  const lines = stripFencedBlocks(text).split("\n");
  for (const raw of lines) {
    const line = cleanWhitespace(raw.replace(/^[-*]\s+/, ""));
    if (!line) continue;
    if (isOpenClawGreeting(line) || isMetadataBlob(line)) continue;
    if (!/^[-*]\s+/.test(raw.trim()) && !/^#{1,6}\s+/.test(raw.trim())) continue;
    items.push(line);
    if (items.length >= limit) break;
  }
  return items;
}

function extractSection(text, label) {
  const pattern = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Za-z ]+:|$)`, "i");
  const match = String(text).match(pattern);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function startCallbackServer(expectedState) {
  let resolveCallback;
  let rejectCallback;
  const waitForCallback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      rejectCallback(new Error(url.searchParams.get("error_description") || "Authorization denied"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        renderConnectCallbackPage({
          title: "Engrm connection failed",
          message: "The OpenClaw connect flow was cancelled or denied. Please return to OpenClaw and try again.",
          tone: "error",
        })
      );
      return;
    }

    if (!code || !state || state !== expectedState) {
      rejectCallback(new Error("Invalid callback parameters"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        renderConnectCallbackPage({
          title: "Engrm connection failed",
          message: "The login flow could not be verified. Please return to OpenClaw and try connecting again.",
          tone: "error",
        })
      );
      return;
    }

    resolveCallback({ code, state });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      renderConnectCallbackPage({
        title: "Engrm connected",
        message: "This OpenClaw machine is now linked to your Engrm memory, so future sessions can start with project context instead of a cold start.",
      })
    );
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const timeout = setTimeout(() => {
        rejectCallback(new Error("Authorization timed out"));
      }, CALLBACK_TIMEOUT_MS);
      resolve({
        port,
        waitForCallback,
        stop() {
          clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

async function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  return new Promise((resolve) => {
    execFile(cmd, args, (error) => resolve(!error));
  });
}

async function provision(baseUrl, request) {
  const response = await fetch(`${String(baseUrl).replace(/\/$/, "")}/v1/mem/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {}
    throw new Error(detail);
  }

  const data = await response.json();
  if (!data.api_key || !data.site_id || !data.namespace || !data.user_id) {
    throw new Error("Provisioning returned incomplete credentials");
  }
  return data;
}

function saveSettings(baseUrl, result) {
  ensureConfigDir();

  let existing = null;
  try {
    existing = loadSettings();
  } catch {}

  const config = {
    candengo_url: baseUrl,
    candengo_api_key: result.api_key,
    site_id: result.site_id,
    namespace: result.namespace,
    user_id: result.user_id,
    user_email: result.user_email || "",
    device_id: existing?.device_id || generateDeviceId(),
    teams: result.teams || [],
    sync: existing?.sync || { enabled: true, interval_seconds: 30, batch_size: 50 },
    search: existing?.search || { default_limit: 10, local_boost: 1.2, scope: "all" },
    scrubbing: existing?.scrubbing || {
      enabled: true,
      custom_patterns: [],
      default_sensitivity: "shared",
    },
    sentinel: existing?.sentinel || {
      enabled: false,
      mode: "advisory",
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "",
      base_url: "",
      skip_patterns: [],
      daily_limit: 100,
      tier: "free",
    },
    observer: existing?.observer || {
      enabled: true,
      mode: "per_event",
      model: "haiku",
    },
    transcript_analysis: existing?.transcript_analysis || { enabled: false },
  };

  writeFileSync(SETTINGS_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (!db) {
    db = new BetterSqlite3(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  bootstrapSchema(db);
  return config;
}

async function beginConnectFlow(baseUrl) {
  if (connectFlow?.status === "pending") {
    return connectFlow;
  }

  const state = randomBytes(16).toString("hex");
  const server = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const authUrl = new URL("/connect/mem", baseUrl);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("source", "openclaw");

  connectFlow = {
    status: "pending",
    startedAt: Date.now(),
    message: `Browser auth started for ${baseUrl}`,
    authUrl: authUrl.toString(),
    stop: server.stop,
  };

  server.waitForCallback
    .then(async ({ code }) => {
      const deviceId = loadSettings()?.device_id || generateDeviceId();
      const result = await provision(baseUrl, {
        code,
        device_name: hostname(),
        device_id: deviceId,
      });
      saveSettings(baseUrl, result);
      connectFlow = {
        status: "success",
        startedAt: connectFlow?.startedAt || Date.now(),
        finishedAt: Date.now(),
        message: `Connected as ${result.user_email || result.user_id}`,
        authUrl: authUrl.toString(),
      };
      logger.info(`engrm: connected as ${result.user_email || result.user_id}`);
    })
    .catch((error) => {
      connectFlow = {
        status: "error",
        startedAt: connectFlow?.startedAt || Date.now(),
        finishedAt: Date.now(),
        message: error?.message || String(error),
        authUrl: authUrl.toString(),
      };
      logger.warn(`engrm: connect failed: ${error?.message || error}`);
    })
    .finally(() => {
      server.stop();
    });

  const opened = await openBrowser(authUrl.toString());
  if (!opened) {
    connectFlow.status = "error";
    connectFlow.message = "Could not open the browser for Engrm sign-in.";
    server.stop();
  }

  return connectFlow;
}

function currentConnectStatus() {
  if (connectFlow) return connectFlow;
  if (loadSettings() && existsSync(DB_PATH)) {
    return { status: "success", message: "Engrm is connected on this machine." };
  }
  return { status: "disconnected", message: "Engrm is not connected on this machine." };
}

function buildDigestSummary(prompt, assistantText) {
  const cleanedPrompt = isOpenClawBootstrapPrompt(prompt) || isMetadataBlob(prompt)
    ? ""
    : cleanWhitespace(stripFencedBlocks(prompt));
  const investigated = extractSection(assistantText, "Investigated");
  const learned = extractSection(assistantText, "Learned");
  const completed = extractSection(assistantText, "Completed");
  const nextSteps = extractSection(assistantText, "Next Steps");
  const heading = extractMarkdownHeading(assistantText);
  const paragraph = firstUsefulParagraph(assistantText);
  const bullets = extractBulletItems(assistantText, 3);
  const fallbackCompleted = cleanWhitespace([heading, ...bullets].filter(Boolean).join("; ")) || paragraph;
  const requestFallback = heading && !isOpenClawGreeting(heading) ? heading : paragraph;

  return {
    request: truncate(cleanedPrompt || requestFallback || "", 240) || null,
    investigated: truncate(investigated || "", 500) || null,
    learned: truncate(learned || "", 500) || null,
    completed: truncate(completed || fallbackCompleted || "", 500) || null,
    next_steps: truncate(nextSteps || "", 320) || null,
  };
}

function ensureSessionRow(conn, sessionId, projectId, settings, status = "active") {
  const existing =
    conn.prepare("SELECT * FROM sessions WHERE session_id = ? LIMIT 1").get(sessionId) || null;
  const now = Math.floor(Date.now() / 1000);

  if (existing) {
    conn
      .prepare(
        `UPDATE sessions
         SET project_id = COALESCE(?, project_id),
             status = ?,
             completed_at_epoch = CASE WHEN ? = 'completed' THEN ? ELSE completed_at_epoch END
         WHERE session_id = ?`
      )
      .run(projectId, status, status, now, sessionId);
    return;
  }

  conn
    .prepare(
      `INSERT INTO sessions (
         session_id, project_id, user_id, device_id, agent, status,
         observation_count, started_at_epoch, completed_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      sessionId,
      projectId,
      settings.user_id || "unknown",
      settings.device_id || "unknown",
      "openclaw",
      status,
      now,
      status === "completed" ? now : null
    );
}

function addOutboxRow(conn, recordType, recordId) {
  conn
    .prepare(
      `INSERT INTO sync_outbox (record_type, record_id, status, retry_count, max_retries, created_at_epoch)
       VALUES (?, ?, 'pending', 0, 10, ?)`
    )
    .run(recordType, recordId, Math.floor(Date.now() / 1000));
}

function insertObservation(conn, projectId, sessionId, settings, title, narrative, type = "digest") {
  const now = nowEpoch();
  const createdAt = new Date(now * 1000).toISOString();
  const result = conn
    .prepare(
      `INSERT INTO observations (
         session_id, project_id, type, title, narrative, facts, concepts,
         files_read, files_modified, quality, lifecycle, sensitivity,
         user_id, device_id, agent, created_at, created_at_epoch
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0.75, 'active', 'shared', ?, ?, 'openclaw', ?, ?)`
    )
    .run(
      sessionId,
      projectId,
      type,
      title,
      narrative,
      settings.user_id || "unknown",
      settings.device_id || "unknown",
      createdAt,
      now
    );
  const observationId = Number(result.lastInsertRowid);

  conn
    .prepare(
      `INSERT INTO observations_fts(rowid, title, narrative, facts, concepts)
       VALUES (?, ?, ?, '', '')`
    )
    .run(observationId, title, narrative || "");

  addOutboxRow(conn, "observation", observationId);
  conn
    .prepare(
      "UPDATE sessions SET observation_count = observation_count + 1 WHERE session_id = ?"
    )
    .run(sessionId);

  return observationId;
}

function upsertSessionSummary(conn, sessionId, projectId, settings, summary) {
  const now = Math.floor(Date.now() / 1000);
  const existing =
    conn.prepare("SELECT id FROM session_summaries WHERE session_id = ? LIMIT 1").get(sessionId) || null;
  if (existing) {
    conn
      .prepare(
        `UPDATE session_summaries
         SET project_id = ?,
             user_id = ?,
             request = ?,
             investigated = ?,
             learned = ?,
             completed = ?,
             next_steps = ?,
             created_at_epoch = ?
         WHERE session_id = ?`
      )
      .run(
        projectId,
        settings.user_id || "unknown",
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.next_steps,
        now,
        sessionId
      );
    return existing.id;
  }

  const result = conn
    .prepare(
      `INSERT INTO session_summaries (
         session_id, project_id, user_id, request, investigated, learned, completed, next_steps, created_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      projectId,
      settings.user_id || "unknown",
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      now
    );
  addOutboxRow(conn, "summary", Number(result.lastInsertRowid));
  return Number(result.lastInsertRowid);
}

function insertStructuredSessionObservations(conn, projectId, sessionId, settings, summary) {
  const structured = [];

  for (const line of splitSummaryItems(summary.investigated, 2)) {
    structured.push({
      type: "discovery",
      title: truncate(line, 120),
      narrative: `Investigated: ${line}`,
    });
  }

  for (const line of splitSummaryItems(summary.learned, 2)) {
    structured.push({
      type: classifyLearnedType(line),
      title: truncate(line, 120),
      narrative: `Learned: ${line}`,
    });
  }

  for (const line of splitSummaryItems(summary.completed, 3)) {
    structured.push({
      type: classifyCompletedType(line),
      title: truncate(line, 120),
      narrative: `Completed: ${line}`,
    });
  }

  for (const line of splitSummaryItems(summary.next_steps, 2)) {
    structured.push({
      type: "decision",
      title: truncate(`Next: ${line}`, 120),
      narrative: `Next steps agreed: ${line}`,
    });
  }

  for (const item of structured) {
    insertObservation(conn, projectId, sessionId, settings, item.title, item.narrative, item.type);
  }
}

function splitSummaryItems(text, limit = 3) {
  return String(text || "")
    .split(/\n|;\s+/)
    .map((line) => cleanWhitespace(line.replace(/^[-*]\s+/, "")))
    .filter((line) => line && !isOpenClawGreeting(line) && !isMetadataBlob(line))
    .filter((line, idx, arr) => arr.findIndex((item) => item.toLowerCase() === line.toLowerCase()) === idx)
    .slice(0, limit);
}

function classifyCompletedType(text) {
  const value = cleanWhitespace(text).toLowerCase();
  if (/\b(fixed|resolved|patched|corrected)\b/.test(value)) return "bugfix";
  if (/\b(refactor|cleanup|restructured|reorganized)\b/.test(value)) return "refactor";
  if (/\b(added|introduced|implemented|launched|deployed|published|exposed|created)\b/.test(value)) return "feature";
  return "change";
}

function classifyLearnedType(text) {
  const value = cleanWhitespace(text).toLowerCase();
  if (/\b(decided|decision|agreed|use |switch to|chose)\b/.test(value)) return "decision";
  if (/\b(pattern|always|never|should|must|avoid)\b/.test(value)) return "pattern";
  return "bugfix";
}

function buildDeliveryReview(conn, sessionId, userId) {
  const observations = getSessionObservations(conn, sessionId, userId);
  if (observations.length === 0) {
    return {
      status: "No captured evidence yet",
      explanation: "Engrm has not stored observations for this session yet.",
      decisions: [],
      implementations: [],
    };
  }

  const decisions = observations.filter((obs) => obs.type === "decision");
  const implementations = observations.filter((obs) => IMPLEMENTATION_TYPES.has(obs.type));
  const refactors = observations.filter((obs) => obs.type === "refactor");

  let status = "Delivered as planned";
  let explanation = "This session has both a decision trail and implementation evidence.";

  if (decisions.length > 0 && implementations.length === 0) {
    status = "Planned, not delivered";
    explanation = "This session captured intent, but Engrm has little implementation evidence after it.";
  } else if (decisions.length === 0 && implementations.length > 0) {
    status = "Built without a clear decision trail";
    explanation = "Work shipped here, but the reasoning was not captured clearly enough to help future sessions reuse it.";
  } else if (refactors.length >= 2 && implementations.length === refactors.length) {
    status = "Refactor-heavy";
    explanation = "Most of the captured implementation evidence here looks like restructuring rather than clear delivery against a brief.";
  }

  return {
    status,
    explanation,
    decisions: decisions.slice(0, 5).map((obs) => obs.title),
    implementations: implementations.slice(0, 5).map((obs) => obs.title),
  };
}

const plugin = {
  id: "engrm",
  name: "Engrm",
  description: "Persistent project memory, startup briefs, and delivery review for OpenClaw.",
  version: "0.1.0",

  register(api) {
    logger = api.logger;
    pluginConfig = {
      ...pluginConfig,
      ...(api.pluginConfig || {}),
    };

    if (pluginConfig.enabled === false) {
      logger.info("engrm: plugin disabled by config");
      return;
    }

    let startupSettings = loadSettings();
    if (!startupSettings || !existsSync(DB_PATH)) {
      logger.warn("engrm: local Engrm settings/db not found, startup hooks will stay idle until Engrm is connected");
    }

    api.on("message_received", (event, ctx) => {
      const content = typeof event?.content === "string" ? event.content.trim() : "";
      if (!content) return;
      const sessionKey = ctx?.conversationId || ctx?.sessionId || ctx?.channelId || "unknown";
      recentUserPrompts.set(sessionKey, content);
    });

    api.on("before_prompt_build", async (event, ctx) => {
      if (!pluginConfig.autoStartupBrief) return;
      try {
        const conn = getDb();
        if (!conn) return;
        const settings = loadSettings();
        if (!settings) return;

        const project = findProjectForWorkspace(conn, ctx.workspaceDir);
        const summaries = getRecentSummaries(conn, project?.id ?? null, settings.user_id || null, 2);
        const localRelevant = event?.prompt
          ? searchObservations(conn, {
              query: event.prompt,
              projectId: project?.id ?? null,
              userId: settings.user_id || null,
              limit: Number(pluginConfig.maxRelevantObservations || 4),
            })
          : getRecentObservations(conn, {
              projectId: project?.id ?? null,
              userId: settings.user_id || null,
              limit: Number(pluginConfig.maxRelevantObservations || 4),
            });
        const cloudQuery = event?.prompt || project?.canonical_id || project?.name || "";
        let cloudRelevant = [];
        if (cloudQuery) {
          try {
            const cloudResults = await searchCloudMemory(settings, {
              query: cloudQuery,
              limit: Number(pluginConfig.maxRelevantObservations || 4),
            });
            cloudRelevant = normaliseCloudResults(cloudResults);
          } catch (error) {
            logger.debug(`engrm: cloud recall unavailable: ${error?.message || error}`);
          }
        }
        const relevant = mergeRelevantMemory(
          localRelevant,
          cloudRelevant,
          Number(pluginConfig.maxRelevantObservations || 4)
        );
        const staleDecisions = getStaleDecisions(conn, project?.id ?? null, settings.user_id || null, 3);
        const brief = formatStartupBrief({
          project,
          summaries,
          relevant,
          staleDecisions,
        });

        return { prependSystemContext: brief };
      } catch (error) {
        logger.warn(`engrm: startup brief failed: ${error?.message || error}`);
        return;
      }
    });

    api.on("agent_end", async (event, ctx) => {
      if (!pluginConfig.autoSessionDigest || !event?.success) return;
      try {
        const conn = getDb();
        if (!conn) return;
        const settings = loadSettings();
        if (!settings) return;

        const assistantText = extractLatestAssistantText(event.messages);
        if (!assistantText || assistantText === "NO_REPLY") return;

        const sessionId = ctx.sessionId || ctx.sessionKey || `openclaw-${Date.now()}`;
        const sessionKey = ctx.sessionKey || ctx.sessionId || "unknown";
        const prompt =
          recentUserPrompts.get(sessionKey) || extractLatestUserText(event.messages) || "";
        const digestHash = createHash("sha256")
          .update(`${sessionId}\n${prompt}\n${assistantText}`)
          .digest("hex");

        if (lastSavedDigestHashes.get(sessionId) === digestHash) {
          return;
        }
        lastSavedDigestHashes.set(sessionId, digestHash);

        const project = ensureProject(conn, ctx.workspaceDir || process.cwd());
        ensureSessionRow(conn, sessionId, project.id, settings, "completed");

        const summary = buildDigestSummary(prompt, assistantText);
        upsertSessionSummary(conn, sessionId, project.id, settings, summary);
        insertStructuredSessionObservations(conn, project.id, sessionId, settings, summary);

        const digestTitle = truncate(
          summary.completed || summary.request || `Session review for ${project.name}`,
          120
        );
        const digestBody = [
          summary.request ? `Asked: ${summary.request}` : "",
          summary.investigated ? `Investigated: ${summary.investigated}` : "",
          summary.learned ? `Learned: ${summary.learned}` : "",
          summary.completed ? `Completed: ${summary.completed}` : "",
          summary.next_steps ? `Next steps: ${summary.next_steps}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        insertObservation(conn, project.id, sessionId, settings, digestTitle, digestBody);
        await flushPendingToCloud(conn, settings, Number(settings?.sync?.batch_size || 50));
        await sendSessionTelemetry(conn, settings, sessionId, {
          contextObsInjected: 0,
          contextTotalAvailable: 0,
          recallAttempts: 0,
          recallHits: 0,
          searchCount: 0,
          searchResultsTotal: 0,
        });
      } catch (error) {
        logger.warn(`engrm: session digest failed: ${error?.message || error}`);
      }
    });

    api.registerTool({
      name: "engrm_status",
      description: "Report whether local Engrm memory is connected and what is available.",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        const currentSettings = loadSettings();
        const conn = getDb();
        if (!currentSettings || !conn) {
          return textResult("Engrm is not connected in this environment.");
        }
        const counts =
          conn
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM observations WHERE lifecycle IN ('active', 'aging', 'pinned')) AS observation_count,
                 (SELECT COUNT(*) FROM session_summaries) AS summary_count,
                 (SELECT COUNT(*) FROM projects) AS project_count`
            )
            .get() || {};
        return textResult(
          [
            "Engrm is connected.",
            `Namespace: ${currentSettings.namespace || "unknown"}`,
            `Observations: ${counts.observation_count ?? 0}`,
            `Session briefs: ${counts.summary_count ?? 0}`,
            `Projects: ${counts.project_count ?? 0}`,
            "Cloud sync: enabled for OpenClaw session digests and memory recall",
          ].join("\n")
        );
      },
    });

    api.registerTool({
      name: "engrm_connect",
      description: "Open native browser auth and connect this OpenClaw machine to Engrm.",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        const flow = await beginConnectFlow(pluginConfig.baseUrl || "https://engrm.dev");
        if (flow.status === "error") {
          return textResult(`Engrm connect failed: ${flow.message}`);
        }
        return textResult("Opened browser for Engrm sign-in. Finish login in the browser, then ask for Engrm status.");
      },
    });

    api.registerTool({
      name: "engrm_recent",
      description: "Show recent Engrm observations for the current workspace or across all projects.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum observations to return" },
          projectScoped: { type: "boolean", description: "Scope to the current workspace project" },
        },
      },
      async execute(_id, params = {}) {
        const conn = getDb();
        const settings = loadSettings();
        if (!conn || !settings) return textResult("Engrm is not connected in this environment.");
        const workspaceDir = process.cwd();
        const project = params.projectScoped === false ? null : findProjectForWorkspace(conn, workspaceDir);
        const localRows = getRecentObservations(conn, {
          projectId: project?.id ?? null,
          userId: settings.user_id || null,
          limit: Math.max(1, Math.min(Number(params.limit || 6), 12)),
        });
        let rows = localRows;
        if (rows.length < Math.max(2, Math.floor(Number(params.limit || 6) / 2))) {
          try {
            const cloudQuery = project?.canonical_id || project?.name || "recent project work";
            const cloudRows = normaliseCloudResults(
              await searchCloudMemory(settings, {
                query: cloudQuery,
                limit: Math.max(1, Math.min(Number(params.limit || 6), 12)),
              })
            );
            rows = mergeRelevantMemory(localRows, cloudRows, Math.max(1, Math.min(Number(params.limit || 6), 12)));
          } catch (error) {
            logger.debug(`engrm: cloud recent unavailable: ${error?.message || error}`);
          }
        }
        if (rows.length === 0) {
          return textResult("No recent Engrm observations were found.");
        }
        return textResult(
          rows
            .map((row) => `- ${row.title} (${row.type}${row.project_name || project?.name ? `, ${row.project_name || project?.name}` : ""})`)
            .join("\n")
        );
      },
    });

    api.registerTool({
      name: "engrm_search",
      description: "Search Engrm memory for related prior work, decisions, and fixes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language query" },
          limit: { type: "number", description: "Maximum results to return" },
          projectScoped: { type: "boolean", description: "Scope to the current workspace project" },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        const conn = getDb();
        const settings = loadSettings();
        if (!conn || !settings) return textResult("Engrm is not connected in this environment.");
        const project = params.projectScoped === false ? null : findProjectForWorkspace(conn, process.cwd());
        const localRows = searchObservations(conn, {
          query: params.query,
          projectId: project?.id ?? null,
          userId: settings.user_id || null,
          limit: Math.max(1, Math.min(Number(params.limit || 6), 12)),
        });
        let rows = localRows;
        try {
          const cloudRows = normaliseCloudResults(
            await searchCloudMemory(settings, {
              query: [project?.canonical_id, project?.name, params.query].filter(Boolean).join(" "),
              limit: Math.max(1, Math.min(Number(params.limit || 6), 12)),
            })
          );
          rows = mergeRelevantMemory(localRows, cloudRows, Math.max(1, Math.min(Number(params.limit || 6), 12)));
        } catch (error) {
          logger.debug(`engrm: cloud search unavailable: ${error?.message || error}`);
        }
        if (rows.length === 0) {
          return textResult("No Engrm memory matched that query.");
        }
        return textResult(
          rows
            .map(
              (row) =>
                `- ${row.title} (${row.type})${row.narrative ? `\n  ${truncate(row.narrative, 180)}` : ""}`
            )
            .join("\n")
        );
      },
    });

    api.registerTool({
      name: "engrm_delivery_review",
      description: "Review what Engrm captured for a session and whether delivery matched the visible decision trail.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Specific session id to review" },
        },
      },
      async execute(_id, params = {}) {
        const conn = getDb();
        const settings = loadSettings();
        if (!conn || !settings) return textResult("Engrm is not connected in this environment.");
        let sessionId = params.sessionId || null;
        if (!sessionId) {
          const latest =
            conn
              .prepare(
                `SELECT session_id
                 FROM session_summaries
                 ORDER BY created_at_epoch DESC
                 LIMIT 1`
              )
              .get() || null;
          sessionId = latest?.session_id || null;
        }
        if (!sessionId) {
          return textResult("No Engrm session summaries are available yet.");
        }
        const review = buildDeliveryReview(conn, sessionId, settings.user_id || null);
        return textResult(
          [
            `Session: ${sessionId}`,
            `Status: ${review.status}`,
            review.explanation,
            review.decisions.length ? `Decisions: ${review.decisions.join("; ")}` : "",
            review.implementations.length
              ? `Implementation evidence: ${review.implementations.join("; ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
      },
    });

    api.registerCommand({
      name: "engrm",
      description: "Connect Engrm and check Engrm memory status for this OpenClaw machine.",
      acceptsArgs: true,
      requireAuth: false,
      async handler(ctx) {
        const subcommand = String(ctx.args || "").trim().split(/\s+/, 1)[0] || "status";

        if (subcommand === "status") {
          const status = currentConnectStatus();
          return replyText(`Engrm status: ${status.status}\n${status.message}`);
        }

        if (subcommand === "connect") {
          const flow = await beginConnectFlow(pluginConfig.baseUrl || "https://engrm.dev");
          if (flow.status === "error") {
            return replyText(`Engrm connect failed: ${flow.message}`);
          }
          return replyText("Opened browser for Engrm sign-in. Finish login there, then run /engrm status if you want to confirm.");
        }

        if (subcommand === "disconnect") {
          try {
            if (existsSync(SETTINGS_PATH)) {
              writeFileSync(SETTINGS_PATH, "", "utf8");
            }
          } catch {}
          connectFlow = null;
          return replyText("Cleared local Engrm connection state for this machine.");
        }

        return replyText("Use /engrm connect, /engrm status, or /engrm disconnect.");
      },
    });

    logger.info("engrm: OpenClaw plugin registered");
  },
};

export default plugin;
