require('dotenv').config();
const express = require('express');
const pool = require('./db/pool');

const leadCreated = require('./webhooks/leadCreated');
const leadUpdated = require('./webhooks/leadUpdated');
const leadDeleted = require('./webhooks/leadDeleted');
const dealCreated = require('./webhooks/dealCreated');
const dealUpdated = require('./webhooks/dealUpdated');
const dealDeleted = require('./webhooks/dealDeleted');
const { verifyWebhook: fbVerify, receiveWebhook: fbReceive } = require('./webhooks/facebookWebhook');
const taskCreated  = require('./webhooks/taskCreated');
const taskUpdated  = require('./webhooks/taskUpdated');
const taskDeleted  = require('./webhooks/taskDeleted');
const dashboardRouter                    = require('./api/dashboard');
const { startCallsAutoSync }             = require('./api/dashboard');
const campaignsRouter  = require('./api/campaigns');
const { router: rejaRouter, ensureSchema: rejaEnsureSchema } = require('./api/reja');
const marketingRouter  = require('./api/marketing');

const app = express();
const PORT = process.env.PORT || 3001;

app.disable('etag'); // Prevent 304 responses with stale cached API data

// Bitrix24 webhooks come as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// JWT auth for /api/* (no-op unless AUTH_ENABLED=true + JWT_SECRET set)
const { authMiddleware } = require('./middleware/auth');
app.use(authMiddleware);

// ── Webhook routes ────────────────────────────────────────────
app.post('/webhook/lead/created', leadCreated);
app.post('/webhook/lead/updated', leadUpdated);
app.post('/webhook/lead/deleted', leadDeleted);
app.post('/webhook/deal/created', dealCreated);
app.post('/webhook/deal/updated', dealUpdated);
app.post('/webhook/deal/deleted', dealDeleted);

// ── Task webhooks ─────────────────────────────────────────────
app.post('/webhook/task/created', taskCreated);
app.post('/webhook/task/updated', taskUpdated);
app.post('/webhook/task/deleted', taskDeleted);

// ── Facebook Lead Ads webhooks ────────────────────────────────
app.get('/webhook/facebook', fbVerify);
app.post('/webhook/facebook', fbReceive);

// ── Dashboard API ─────────────────────────────────────────────
app.use('/api/dashboard', dashboardRouter);

// ── Campaigns API (Meta Ads, cached) ──────────────────────────
app.use('/api/campaigns', campaignsRouter);
app.use('/api/reja',      rejaRouter);
app.use('/api/marketing', marketingRouter);

// ── Health check ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message });
  }
});

// Run all migrations before accepting connections
Promise.all([
  pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS uf_amo_date TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS leads_uf_amo_date_idx ON leads(uf_amo_date);
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS date_modify      TIMESTAMPTZ;
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS uf_sale_date     TIMESTAMPTZ;
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS uf_bp_sale_date  TIMESTAMPTZ;
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS uf_payment_date  TIMESTAMPTZ;
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS uf_paid_sum      NUMERIC(14,2);
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS uf_remaining_sum NUMERIC(14,2);
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS begindate        TIMESTAMPTZ;
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS uf_service       TEXT;
    ALTER TABLE deals ADD COLUMN IF NOT EXISTS uf_tolandi_sum  NUMERIC(14,2);
    CREATE INDEX IF NOT EXISTS deals_date_modify_idx      ON deals(date_modify);
    CREATE INDEX IF NOT EXISTS deals_uf_sale_date_idx     ON deals(uf_sale_date);
    CREATE INDEX IF NOT EXISTS deals_uf_bp_sale_date_idx  ON deals(uf_bp_sale_date);
    CREATE INDEX IF NOT EXISTS deals_uf_payment_date_idx  ON deals(uf_payment_date);
    CREATE INDEX IF NOT EXISTS deals_begindate_idx        ON deals(begindate);
    CREATE INDEX IF NOT EXISTS deals_uf_service_idx       ON deals(uf_service);
  `).catch(err => console.error('[startup] leads/deals migration failed:', err.message)),
  pool.query(`
    UPDATE stages SET is_won = TRUE, is_final = TRUE
      WHERE entity = 'deal' AND (
        bitrix_id = 'WON' OR bitrix_id LIKE '%:WON'
        OR bitrix_id = 'UC_NV0Y4F' OR bitrix_id LIKE '%:UC_NV0Y4F'
      );
    UPDATE stages SET is_final = TRUE
      WHERE entity = 'deal' AND (bitrix_id = 'LOSE' OR bitrix_id LIKE '%:LOSE');
  `).catch(err => console.error('[startup] stages restore migration failed:', err.message)),
  rejaEnsureSchema().catch(err => console.error('[startup] reja migration failed:', err.message)),
]).then(() => {
  app.listen(PORT, () => {
    startCallsAutoSync();
    console.log(`[bitrix-sync] Server running on port ${PORT}`);

    // Check Meta access token expiry on startup
    (async () => {
      try {
        const appId     = process.env.FB_APP_ID;
        const appSecret = process.env.FB_APP_SECRET;
        const token     = process.env.META_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN;
        if (!appId || !appSecret || !token) {
          console.warn('[meta-token] FB_APP_ID / FB_APP_SECRET / token not set — skipping expiry check');
          return;
        }
        const url = `https://graph.facebook.com/debug_token?input_token=${token}&access_token=${appId}|${appSecret}`;
        const res = await fetch(url);
        const { data } = await res.json();
        if (!data) { console.warn('[meta-token] Could not inspect token'); return; }
        if (data.is_valid === false) {
          console.error('[meta-token] ❌ Token is INVALID — leads will NOT sync. Renew the token!');
          return;
        }
        if (data.expires_at && data.expires_at > 0) {
          const expiresDate = new Date(data.expires_at * 1000).toISOString().split('T')[0];
          const daysLeft = Math.floor((data.expires_at * 1000 - Date.now()) / 86400000);
          if (daysLeft <= 7) {
            console.error(`[meta-token] ⚠️  Token expires in ${daysLeft} day(s) on ${expiresDate} — renew now!`);
          } else {
            console.log(`[meta-token] ✅ Token valid, expires ${expiresDate} (${daysLeft} days)`);
          }
        } else {
          console.log('[meta-token] ✅ Token valid (no expiry — System User or long-lived)');
        }
        if (!process.env.FB_WEBHOOK_VERIFY_TOKEN) {
          console.warn('[meta-token] ⚠️  FB_WEBHOOK_VERIFY_TOKEN not set — webhook verification will fail!');
        } else {
          console.log(`[meta-token] ✅ FB_WEBHOOK_VERIFY_TOKEN set`);
        }
      } catch (e) {
        console.warn('[meta-token] Token check failed:', e.message);
      }
    })();
  console.log(`  POST /webhook/lead/created`);
  console.log(`  POST /webhook/lead/updated`);
  console.log(`  POST /webhook/lead/deleted`);
  console.log(`  POST /webhook/deal/created`);
  console.log(`  POST /webhook/deal/updated`);
  console.log(`  POST /webhook/deal/deleted`);
  console.log(`  GET  /api/dashboard/stats`);
  console.log(`  GET  /api/dashboard/responsibles`);
  console.log(`  GET  /api/dashboard/funnel`);
  console.log(`  GET  /api/dashboard/leads`);
  console.log(`  GET  /api/dashboard/tasks-summary`);
  console.log(`  POST /webhook/task/created`);
  console.log(`  POST /webhook/task/updated`);
  console.log(`  POST /webhook/task/deleted`);
  console.log(`  GET  /webhook/facebook  (FB verification)`);
  console.log(`  POST /webhook/facebook  (FB leadgen events)`);
  console.log(`  GET  /api/campaigns/rows`);
  console.log(`  GET  /api/campaigns/insights`);
  console.log(`  GET  /api/reja/plans`);
  console.log(`  POST /api/reja/plans`);
  console.log(`  GET  /api/reja/plans/:id/distribution`);
  console.log(`  POST /api/reja/plans/:id/distribution`);
  console.log(`  GET  /api/reja/plans/:id/progress`);
  });
});
