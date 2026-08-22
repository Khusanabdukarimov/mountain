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
const callsRouter                        = require('./api/calls');
const { ensurePbxTables, startCallSync } = require('./sync/syncCalls');
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
// Calls come from OnlinePBX now — this router owns /call-stats-full,
// /call-list, /call-filter-options, /sync-calls (mounted first so it wins).
app.use('/api/dashboard', callsRouter);
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
    -- Sifatsiz / bekor reason (decoded label, written by services/upsertLead.js).
    -- These exist in prod but had no migration — add idempotently so fresh DBs
    -- and the Kampaniyalar drill-down's "Sabab" column work everywhere.
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS uf_junk_reason   TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS uf_cancel_reason TEXT;
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
  // Normalized-phone columns (last 9 digits, GENERATED once at write time) +
  // b-tree indexes. Phone-matching joins across the app use these instead of
  // re-running REGEXP_REPLACE per row — the form drill-down and per-form counts
  // go from N table scans to N index lookups. Adding a STORED generated column
  // rewrites the table once; IF NOT EXISTS makes the whole block idempotent.
  pool.query(`
    ALTER TABLE lead_phones    ADD COLUMN IF NOT EXISTS phone_norm TEXT
      GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9)) STORED;
    ALTER TABLE deal_phones    ADD COLUMN IF NOT EXISTS phone_norm TEXT
      GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9)) STORED;
    ALTER TABLE facebook_leads ADD COLUMN IF NOT EXISTS phone_norm TEXT
      GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9)) STORED;
    CREATE INDEX IF NOT EXISTS lead_phones_pnorm_idx ON lead_phones(phone_norm);
    CREATE INDEX IF NOT EXISTS deal_phones_pnorm_idx ON deal_phones(phone_norm);
    CREATE INDEX IF NOT EXISTS fb_leads_pnorm_idx    ON facebook_leads(phone_norm);
  `).catch(err => console.error('[startup] phone_norm migration failed:', err.message)),
  // Manual jami_lid / leads_count adjustments per form+day. Used to fold in
  // leads Meta counts but we can't map to a Bitrix card (junk-phone spam that
  // slipped Meta's own filter). Read by /form-stats (by campaign) and /forms
  // (by form_id); delta is added to jami_lid / leads_count.
  pool.query(`
    CREATE TABLE IF NOT EXISTS lead_count_overrides (
      id            SERIAL PRIMARY KEY,
      form_id       TEXT,
      campaign_name TEXT,
      rep_date      DATE NOT NULL,
      delta         INTEGER NOT NULL,
      note          TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(err => console.error('[startup] lead_count_overrides migration failed:', err.message)),
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
  ensurePbxTables().catch(err => console.error('[startup] pbx migration failed:', err.message)),
  require('./services/bitrixClient').ensureSchema()
    .catch(err => console.error('[startup] bitrix_api_log migration failed:', err.message)),
  // "Стадия (для отчетов)" (UF_CRM_1771440293231) — the hand-set reporting label
  // the Lid va Konversiya table's report-stage dimension groups by.
  // "Tashrif buyurdiga tushgan sana" (UF_CRM_1770695429433) — the moment the
  // meeting was held. Uchrashuvlar soni is counted on this date.
  pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS uf_meeting_set_at  TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS leads_meeting_set_idx ON leads(uf_meeting_set_at)
      WHERE uf_meeting_set_at IS NOT NULL;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS uf_meeting_done_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS leads_meeting_done_idx ON leads(uf_meeting_done_at)
      WHERE uf_meeting_done_at IS NOT NULL;
  `).catch(err => console.error('[startup] uf_meeting_done_at migration failed:', err.message)),
  pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS uf_report_stage TEXT;
    CREATE INDEX IF NOT EXISTS leads_report_stage_idx ON leads(uf_report_stage)
      WHERE uf_report_stage IS NOT NULL;
  `).catch(err => console.error('[startup] uf_report_stage migration failed:', err.message)),
]).then(() => {
  app.listen(PORT, () => {
    startCallSync();
    console.log(`[bitrix-sync] Server running on port ${PORT}`);

    // Daily lead reconcile (01:00 Tashkent) — refreshes UTM tags that Bitrix's
    // native CRM-form connector populates after lead creation, so Kampaniyalar
    // "Jami lid" isn't undercounted. Also runs once ~90s after startup.
    try {
      const { scheduleDailyReconcile } = require('./sync/reconcileLeads');
      scheduleDailyReconcile();
    } catch (e) {
      console.error('[reconcile-leads] failed to schedule:', e.message);
    }

    // Daily deal reconcile (01:15 Tashkent) — re-syncs deals whose
    // ONCRMDEALADD/UPDATE webhook failed (e.g. Bitrix REST timeout), so they
    // don't silently vanish from our mirror. Also runs once ~90s after startup.
    try {
      const { scheduleDailyReconcile: scheduleDealReconcile } = require('./sync/reconcileDeals');
      scheduleDealReconcile();
    } catch (e) {
      console.error('[reconcile-deals] failed to schedule:', e.message);
    }

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
