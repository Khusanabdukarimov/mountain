require('dotenv').config();
const https = require('https');
const http = require('http');

const WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const PAGE_DELAY_MS = 600; // 600ms between batch calls ≈ 1.67 req/s (safe under 2 req/s limit)
const MAX_CONSEC_FAILURES = 3; // abort fetchAll if this many chunks fail in a row
const BATCH_SIZE = 50; // Bitrix batch max commands per call

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

function buildUrl(method, params) {
  const base = `${WEBHOOK_URL}/${method}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      v.forEach((item, i) => qs.append(`${k}[${i}]`, item));
    } else if (typeof v === 'object' && v !== null) {
      for (const [fk, fv] of Object.entries(v)) {
        qs.append(`${k}[${fk}]`, fv);
      }
    } else {
      qs.append(k, v);
    }
  }
  return `${base}?${qs.toString()}`;
}

/**
 * Fetch all pages of a Bitrix24 list method sequentially.
 * @param {string} method  e.g. "crm.lead.list"
 * @param {object} filter  Bitrix filter object
 * @param {string[]} select  Fields to select
 * @returns {Promise<object[]>} All records across all pages
 */
async function fetchAll(method, filter = {}, select = []) {
  const params = { start: 0 };
  if (Object.keys(filter).length) params.filter = filter;
  if (select.length) params.select = select;

  const firstUrl = buildUrl(method, params);
  // First page gets the same retry+backoff treatment as later pages — a wide
  // SELECT (many UF_CRM_* fields) can legitimately take Bitrix >30s to build,
  // and this call previously had zero retries, unlike every page after it.
  let firstPage = null;
  {
    const delays = [5000, 15000, 45000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        firstPage = await httpGet(firstUrl, 35000);
        if (firstPage.result) break;
        firstPage = null;
        await sleep(delays[attempt]);
      } catch (err) {
        console.warn(`[bitrix] ${method} first page attempt=${attempt + 1} error: ${err.message}`);
        if (attempt < delays.length - 1) await sleep(delays[attempt]);
      }
    }
  }

  if (!firstPage || !firstPage.result) {
    console.error(`[bitrix] ${method} returned no result after retries`);
    return [];
  }

  const all = [...firstPage.result];
  const total = firstPage.total || 0;

  if (total <= 50) return all;

  const offsets = [];
  for (let start = 50; start < total; start += 50) {
    offsets.push(start);
  }

  // Group remaining pages into Bitrix `batch` calls (up to 50 sub-requests per
  // call) instead of one HTTP/TLS connection per page — this is the difference
  // between e.g. 6 separate connections and 1 for a 300-record fetch. Fewer,
  // bundled connections from our one server IP is kinder to whatever's on the
  // other end throttling/blocking bursty traffic (see PAGE_DELAY_MS above).
  const chunks = [];
  for (let i = 0; i < offsets.length; i += BATCH_SIZE) {
    chunks.push(offsets.slice(i, i + BATCH_SIZE));
  }

  console.log(`[bitrix] ${method}: total=${total}, pages=${offsets.length + 1}, batches=${chunks.length}`);

  function cmdForStart(start) {
    const qs = new URLSearchParams();
    for (const [fk, fv] of Object.entries(filter)) qs.append(`filter[${fk}]`, fv);
    select.forEach((f, i) => qs.append(`select[${i}]`, f));
    qs.append('start', start);
    return `${method}?${qs.toString()}`;
  }

  let consecFailures = 0;
  for (const chunk of chunks) {
    await sleep(PAGE_DELAY_MS);
    const cmd = {};
    chunk.forEach((start, i) => { cmd[`p${i}`] = cmdForStart(start); });

    let success = false;
    const delays = [5000, 15000, 45000]; // exponential backoff
    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        const res = await httpPost(`${WEBHOOK_URL}/batch`, { halt: 0, cmd }, 35000);
        const batchResult = res.result && res.result.result;
        if (batchResult) {
          for (const key of Object.keys(cmd)) {
            const rows = batchResult[key];
            if (Array.isArray(rows)) all.push(...rows);
          }
          success = true;
          break;
        }
        await sleep(delays[attempt]);
      } catch (err) {
        console.warn(`[bitrix] ${method} batch@${chunk[0]} attempt=${attempt + 1} error: ${err.message}`);
        if (attempt < delays.length - 1) await sleep(delays[attempt]);
      }
    }
    if (!success) {
      consecFailures++;
      console.error(`[bitrix] ${method} batch@${chunk[0]} failed after all retries (consec=${consecFailures})`);
      if (consecFailures >= MAX_CONSEC_FAILURES) {
        console.error(`[bitrix] ${method}: ${consecFailures} consecutive batch failures — aborting fetch, returning partial ${all.length}/${total}`);
        break;
      }
    } else {
      consecFailures = 0;
    }
  }

  console.log(`[bitrix] ${method}: fetched ${all.length}/${total}`);
  return all;
}

/**
 * Fetch a single Bitrix24 entity by ID.
 */
async function fetchOne(method, id) {
  const url = buildUrl(method, { id });
  const res = await httpGet(url);
  return res.result || null;
}

/**
 * Call a single Bitrix24 method with arbitrary params (GET-style).
 */
async function bitrixCall(method, params = {}) {
  const url = buildUrl(method, params);
  return httpGet(url);
}

/**
 * POST request to Bitrix24 (for crm.lead.add, crm.lead.update, etc.)
 */
function httpPost(url, data, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function bitrixPost(method, params = {}) {
  const url = `${WEBHOOK_URL}/${method}`;
  return httpPost(url, params);
}

module.exports = { fetchAll, fetchOne, bitrixCall, bitrixPost };
