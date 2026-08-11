'use strict';

// Single choke point for every outbound Bitrix24 REST request.
//
// Why this exists: from 2026-08-05 to 08-11 every call to mountain.bitrix24.kz
// stalled at the TLS handshake — TCP connected in ~50ms, then zero bytes back.
// Nothing on our side had changed. What we eventually found: the portal's edge
// addresses had moved, and the addresses we were reaching (46.235.53.x,
// 195.208.185.4) were being drained while DNS had already published a different
// set (194.31.159.x, 195.49.210.x) that answered fine. Manually pinning an IP in
// /etc/hosts — the workaround used during the outage — made it permanent, since
// a pin cannot follow a migration.
//
// Hence this module owns three things no caller should have to think about:
//   1. Address selection with per-IP health and failover, from live DNS.
//   2. Connection reuse — Node's default agent is keepAlive:false, so we were
//      opening ~1000 fresh TCP+TLS handshakes a day, dozens within seconds
//      during a burst. Connection rate is what edge protection counts.
//   3. A per-call log (bitrix_api_log) so "which subsystem is generating this
//      traffic" is a query, not a guess.
// Phase 2 adds a token-bucket rate limiter and a circuit breaker here, and
// every caller gets them for free because everything already flows through.

const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const pool = require('../db/pool');

// maxSockets caps how many connections we can ever hold open against one portal
// IP at once — the hard ceiling on our connection footprint, independent of how
// many webhooks or jobs fire concurrently.
const agentOpts = {
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 4,
  maxFreeSockets: 2,
  timeout: 60000,
};
const httpAgent = new http.Agent(agentOpts);

// ── Per-IP health tracking and failover ─────────────────────────────────────
//
// mountain.bitrix24.kz answers on several edge IPs, and individual ones go deaf
// at the TLS layer independently: TCP connects in ~50ms, then the handshake
// hangs forever. Node's default resolution picks one address and stays on it,
// so a single rotten IP takes the whole sync down with it.
//
// So: resolve all addresses ourselves, keep a health map, and fail over the
// moment a handshake stalls. CONNECT_TIMEOUT_MS is short on purpose — a healthy
// handshake completes in ~200ms, so 8s without one means dead, not slow.
// Re-resolving hourly is what lets us follow an edge migration on our own.
const CONNECT_TIMEOUT_MS = 8000;
const IP_COOLDOWN_MS = 5 * 60 * 1000;  // how long a failed IP stays benched
const DNS_REFRESH_MS = 60 * 60 * 1000;
const MAX_IP_ATTEMPTS = 3;

const agentsByIp = new Map();     // ip -> https.Agent (one connection pool per IP)
const deadUntil = new Map();      // ip -> timestamp
let cachedIps = [];
let cachedIpsHost = null;
let cachedIpsAt = 0;

function agentForIp(ip) {
  if (!agentsByIp.has(ip)) agentsByIp.set(ip, new https.Agent(agentOpts));
  return agentsByIp.get(ip);
}

async function resolveIps(hostname) {
  const fresh = cachedIpsHost === hostname && Date.now() - cachedIpsAt < DNS_REFRESH_MS;
  if (fresh && cachedIps.length) return cachedIps;
  try {
    const ips = await dns.resolve4(hostname);
    if (ips.length) {
      cachedIps = ips;
      cachedIpsHost = hostname;
      cachedIpsAt = Date.now();
    }
  } catch (e) {
    console.warn(`[bitrix] DNS resolve failed for ${hostname}: ${e.message}`);
  }
  return cachedIps;
}

// Sticky, not round-robin: always prefer the same healthy IP so its keep-alive
// pool actually gets reused. Spreading calls across IPs would mean a fresh TLS
// handshake every time — exactly the connection churn we are trying to kill.
// We only move to the next IP when the current one is benched. Benched IPs stay
// at the end of the list as a last resort, since "everything looks dead" is
// often just a stale cooldown.
function orderCandidates(ips) {
  const now = Date.now();
  const sorted = [...ips].sort(); // stable across DNS reorderings
  const healthy = sorted.filter(ip => !(deadUntil.get(ip) > now));
  const benched = sorted.filter(ip => deadUntil.get(ip) > now);
  return healthy.length ? [...healthy, ...benched] : sorted;
}

function markDead(ip, reason) {
  deadUntil.set(ip, Date.now() + IP_COOLDOWN_MS);
  console.warn(`[bitrix] edge IP ${ip} benched for ${IP_COOLDOWN_MS / 60000}min (${reason})`);
  const agent = agentsByIp.get(ip);
  if (agent) agent.destroy(); // drop any pooled sockets to the dead IP
}

function markAlive(ip) {
  if (deadUntil.has(ip)) {
    deadUntil.delete(ip);
    console.log(`[bitrix] edge IP ${ip} healthy again`);
  }
}

const LOG_RETENTION_DAYS = 14;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bitrix_api_log (
      id            BIGSERIAL PRIMARY KEY,
      at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      method        TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'unknown',
      http_method   TEXT NOT NULL DEFAULT 'GET',
      duration_ms   INTEGER,
      ok            BOOLEAN NOT NULL,
      reused_socket BOOLEAN,
      entity_id     INTEGER,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS bitrix_api_log_at_idx     ON bitrix_api_log(at DESC);
    CREATE INDEX IF NOT EXISTS bitrix_api_log_source_idx ON bitrix_api_log(source);
  `);
  // Keep the table bounded — this is diagnostics, not an audit trail.
  await pool.query(
    `DELETE FROM bitrix_api_log WHERE at < NOW() - ($1 || ' days')::interval`,
    [LOG_RETENTION_DAYS]
  );
}

// Fire-and-forget: a logging failure must never break a sync or a webhook.
function logCall(row) {
  pool.query(
    `INSERT INTO bitrix_api_log
       (method, source, http_method, duration_ms, ok, reused_socket, entity_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.method, row.source, row.httpMethod, row.durationMs,
      row.ok, row.reusedSocket, row.entityId, row.error ? String(row.error).slice(0, 300) : null,
    ]
  ).catch(() => {});
}

// One attempt against one specific edge IP. `ip` is null for plain http or when
// DNS gave us nothing, in which case Node resolves the hostname itself.
function doRequest({ url, httpMethod, body, timeoutMs, ip }) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body == null ? null : JSON.stringify(body);

    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};

    const opts = {
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: httpMethod,
      headers,
    };
    if (isHttps && ip) {
      // Connect to the chosen IP but keep SNI + cert validation + Host on the
      // real hostname, so this stays a normal, fully-verified TLS session.
      opts.host = ip;
      opts.servername = urlObj.hostname;
      opts.headers = { ...headers, Host: urlObj.hostname };
      opts.agent = agentForIp(ip);
    } else {
      opts.hostname = urlObj.hostname;
      opts.agent = isHttps ? agentForIp('default') : httpAgent;
    }

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ json: JSON.parse(data), reusedSocket: !!req.reusedSocket });
        } catch (e) {
          reject(Object.assign(new Error(`JSON parse error: ${e.message}`),
            { reusedSocket: !!req.reusedSocket }));
        }
      });
      res.on('error', (e) => {
        e.reusedSocket = !!req.reusedSocket;
        reject(e);
      });
    });

    // Separate, much shorter budget for getting the connection up. A dead edge
    // IP hangs here forever; a healthy one clears in ~130ms. Reused sockets are
    // already connected, so they skip this entirely.
    let connectTimer = null;
    req.on('socket', (socket) => {
      if (!socket.connecting && !(isHttps && socket.authorized === undefined)) return;
      connectTimer = setTimeout(() => {
        const err = new Error(`Connect/TLS stalled after ${CONNECT_TIMEOUT_MS}ms`);
        err.connectStalled = true;
        req.destroy(err);
      }, CONNECT_TIMEOUT_MS);
      const clear = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } };
      socket.once(isHttps ? 'secureConnect' : 'connect', clear);
      socket.once('close', clear);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (e) => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      e.reusedSocket = !!req.reusedSocket;
      reject(e);
    });
    req.on('close', () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Connection-level failures mean "this IP is bad, try another". A JSON parse
// error or an HTTP error means the server answered — different IP won't help.
function isConnectionFailure(err) {
  return err.connectStalled ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']
      .includes(err.code) ||
    /timed out/i.test(err.message || '');
}

/**
 * Perform one Bitrix24 REST call. Returns the parsed JSON body; throws on
 * network error, timeout, or unparseable response — same contract the old
 * httpGet/httpPost had, so callers keep their existing retry logic.
 *
 * @param {object}  opts
 * @param {string}  opts.url         Fully built request URL
 * @param {string}  opts.method      Bitrix method name, for logging (e.g. 'crm.lead.get')
 * @param {string}  opts.source      Which subsystem is calling (e.g. 'webhook:leadUpdated')
 * @param {string} [opts.httpMethod] 'GET' (default) or 'POST'
 * @param {object} [opts.body]       JSON body for POST
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.entityId]   Entity being fetched, for spotting repeat fetches
 */
async function call({ url, method, source = 'unknown', httpMethod = 'GET', body = null, timeoutMs = 30000, entityId = null }) {
  const startedAt = Date.now();
  const urlObj = new URL(url);
  const ips = urlObj.protocol === 'https:' ? await resolveIps(urlObj.hostname) : [];
  const candidates = ips.length ? orderCandidates(ips).slice(0, MAX_IP_ATTEMPTS) : [null];

  let lastErr = null;
  for (const ip of candidates) {
    try {
      const { json, reusedSocket } = await doRequest({ url, httpMethod, body, timeoutMs, ip });
      if (ip) markAlive(ip);
      logCall({ method, source, httpMethod, durationMs: Date.now() - startedAt, ok: true, reusedSocket, entityId, error: null });
      return json;
    } catch (err) {
      lastErr = err;
      if (!isConnectionFailure(err)) break; // server answered — another IP won't help
      // A pooled socket the server closed while idle fails on first use. That's
      // the socket's fault, not the IP's — retry the same IP once, fresh.
      if (err.reusedSocket && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
        try {
          const retry = await doRequest({ url, httpMethod, body, timeoutMs, ip });
          if (ip) markAlive(ip);
          logCall({ method, source, httpMethod, durationMs: Date.now() - startedAt, ok: true, reusedSocket: retry.reusedSocket, entityId, error: null });
          return retry.json;
        } catch (err2) {
          lastErr = err2;
          if (!isConnectionFailure(err2)) break;
        }
      }
      if (ip) markDead(ip, err.message);
    }
  }

  logCall({
    method, source, httpMethod, durationMs: Date.now() - startedAt,
    ok: false, reusedSocket: !!(lastErr && lastErr.reusedSocket), entityId,
    error: lastErr ? lastErr.message : 'unknown error',
  });
  throw lastErr || new Error('Bitrix request failed');
}

/** Current per-IP health, for /api/dashboard/bitrix-stats. */
function edgeHealth() {
  const now = Date.now();
  return cachedIps.map(ip => ({
    ip,
    healthy: !(deadUntil.get(ip) > now),
    benched_for_sec: deadUntil.get(ip) > now
      ? Math.round((deadUntil.get(ip) - now) / 1000) : 0,
  }));
}

module.exports = { call, ensureSchema, edgeHealth };
