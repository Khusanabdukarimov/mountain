'use strict';

/**
 * Minimal Google Sheets v4 client for a service account.
 *
 * Deliberately hand-rolled instead of pulling in `googleapis`: that package and
 * its auth stack are ~40MB of dependencies for three REST calls, and the deploy
 * runs `npm ci` on the server, so every added dependency is weight on every
 * deploy. A service-account JWT is 20 lines of node crypto; axios is already a
 * dependency here.
 *
 * Auth: RS256-signed JWT → Google's token endpoint → bearer token, cached until
 * a minute before it expires.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

let credsCache = null;
let tokenCache = null; // { token, expiresAt }

/** Reads the service-account JSON. Path from env, relative to the app root. */
function loadCredentials() {
  if (credsCache) return credsCache;

  const rel = process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json';
  const file = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);

  if (!fs.existsSync(file)) {
    throw new Error(`Google service-account file not found: ${file} (set GOOGLE_CREDENTIALS_PATH)`);
  }

  const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!creds.client_email || !creds.private_key) {
    throw new Error(`${file} is not a service-account key (client_email/private_key missing)`);
  }

  credsCache = creds;
  return creds;
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signedJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: creds.token_uri,
    exp: now + 3600,
    iat: now,
  }));

  const signature = crypto.createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(creds.private_key)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${header}.${claim}.${signature}`;
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const creds = loadCredentials();
  const res = await axios.post(
    creds.token_uri,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt(creds),
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );

  tokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

async function authHeaders() {
  return { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' };
}

/**
 * Reads a range. `range` is A1 notation; a bare tab name ("Leads") returns the
 * whole tab. Trailing empty cells are omitted by the API, so rows come back
 * ragged — callers must index defensively.
 */
async function getValues(spreadsheetId, range) {
  const url = `${API}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await axios.get(url, { headers: await authHeaders(), timeout: 20000 });
  return res.data.values || [];
}

/** Writes one range. */
async function updateValues(spreadsheetId, range, values) {
  const url = `${API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await axios.put(url, { values }, { headers: await authHeaders(), timeout: 20000 });
  return res.data;
}

/**
 * Writes several ranges in one request.
 * `data` — [{ range: 'Leads!J2', values: [[31240]] }, ...]
 */
async function batchUpdateValues(spreadsheetId, data) {
  if (!data.length) return null;
  const url = `${API}/${spreadsheetId}/values:batchUpdate`;
  const res = await axios.post(
    url,
    { valueInputOption: 'RAW', data },
    { headers: await authHeaders(), timeout: 30000 }
  );
  return res.data;
}

/** 0-based column index → A1 letter. 0 → A, 25 → Z, 26 → AA. */
function columnLetter(index) {
  let n = index + 1;
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

module.exports = { getValues, updateValues, batchUpdateValues, columnLetter, getAccessToken };
