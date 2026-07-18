require('dotenv').config();
const https = require('https');

/**
 * OnlinePBX HTTP API client.
 *
 * The current API (unlike the old "HTTP API 1.0" HMAC scheme still shown in most
 * third-party clients) authenticates by posting the panel API key to auth.json,
 * getting back a { key_id, key } pair, and sending it verbatim on every request
 * as `x-pbx-authentication: key_id:key`. There is NO per-request signing.
 *
 * The pair is cached in memory and reused; OnlinePBX explicitly warns that
 * hammering auth.json (4–5×/sec) races and corrupts sessions, so we only
 * re-auth when a call comes back with isNotAuth.
 */

const HOST = 'api.onlinepbx.ru';
const DOMAIN = process.env.ONPBX_DOMAIN || '';
const API_KEY = process.env.ONPBX_API_KEY || '';

let _session = null; // { keyId, key }
let _authInFlight = null;

function assertConfigured() {
  if (!DOMAIN || !API_KEY) {
    throw new Error('ONPBX_DOMAIN / ONPBX_API_KEY not set — copy .env.example to .env');
  }
}

function httpPost(pathOnly, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        path: '/' + pathOnly,
        method: 'POST',
        headers: { Accept: 'application/json', ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* leave null */ }
          resolve({ status: res.statusCode, json, text: data });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`onpbx ${pathOnly} timed out`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const encodeForm = (obj) => new URLSearchParams(obj).toString();

/** POST auth.json, cache the { key_id, key } pair. De-duplicates concurrent callers. */
async function authenticate() {
  assertConfigured();
  if (_authInFlight) return _authInFlight;

  _authInFlight = (async () => {
    const r = await httpPost(
      `${DOMAIN}/auth.json`,
      encodeForm({ auth_key: API_KEY }),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    if (!r.json || String(r.json.status) !== '1' || !r.json.data?.key) {
      throw new Error(`onpbx auth failed: ${r.json?.comment || r.text?.slice(0, 120)}`);
    }
    _session = { keyId: r.json.data.key_id, key: r.json.data.key };
    return _session;
  })();

  try {
    return await _authInFlight;
  } finally {
    _authInFlight = null;
  }
}

async function session() {
  if (_session) return _session;
  return authenticate();
}

/**
 * Call an API method. Re-authenticates once if the session has expired.
 * Returns the parsed `data` payload; throws on a non-1 status.
 */
async function apiCall(path, params = {}, { _retried = false } = {}) {
  const s = await session();
  const r = await httpPost(`${DOMAIN}/${path}`, encodeForm(params), {
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-pbx-authentication': `${s.keyId}:${s.key}`,
  });

  if (r.json?.isNotAuth && !_retried) {
    _session = null; // key expired — get a fresh one and retry once
    return apiCall(path, params, { _retried: true });
  }
  if (!r.json || String(r.json.status) !== '1') {
    throw new Error(`onpbx ${path}: ${r.json?.comment || r.json?.errorCode || r.text?.slice(0, 120)}`);
  }
  return r.json.data;
}

/**
 * Fetch call history for a Unix-second window [fromUnix, toUnix].
 *
 * mongo_history/search.json returns the whole window in one response (no
 * offset pagination), so callers chunk by time to bound each request's size.
 */
async function searchCalls(fromUnix, toUnix) {
  const data = await apiCall('mongo_history/search.json', {
    start_stamp_from: String(fromUnix),
    start_stamp_to: String(toUnix),
  });
  return Array.isArray(data) ? data : [];
}

/** PBX extensions (num, name, enabled). */
async function getUsers() {
  const data = await apiCall('user/get.json', {});
  return Array.isArray(data) ? data : [];
}

module.exports = { authenticate, session, apiCall, searchCalls, getUsers, DOMAIN };
