'use strict';

// JWT (HS256) verification middleware — mirrors the FastAPI backend's auth
// (backend/app/core/auth.py). The Python service issues the tokens; this
// middleware only verifies them, using the same JWT_SECRET, so the Node-served
// API routes (/api/campaigns, /api/dashboard, /api/reja, /api/marketing) are
// protected by the same login instead of being left open when auth is on.
//
// Enabled only when AUTH_ENABLED=true and JWT_SECRET is set — otherwise a
// no-op, preserving existing behaviour.

const crypto = require('crypto');

const AUTH_ENABLED = (process.env.AUTH_ENABLED || 'false').toLowerCase() === 'true';
const JWT_SECRET   = process.env.JWT_SECRET || '';

// Paths that must stay reachable without a token:
//  - /webhook/*                     Facebook + Bitrix24 incoming webhooks
//  - /health                        uptime checks
//  - POST /api/dashboard/payments   Bitrix24 outgoing webhook (ONCRMDYNAMICITEM*)
function isPublic(req) {
  const p = req.path;
  if (!p.startsWith('/api/')) return true;
  if (p === '/api/dashboard/payments' && req.method === 'POST') return true;
  return false;
}

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try {
    header  = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actual = b64urlDecode(sigB64);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function authMiddleware(req, res, next) {
  if (!AUTH_ENABLED || !JWT_SECRET) return next();
  if (isPublic(req)) return next();
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ detail: 'Auth required' });
  }
  const payload = verifyJwt(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ detail: 'Invalid or expired token' });
  }
  req.auth = payload;
  return next();
}

module.exports = { authMiddleware };
