-- ============================================================
-- Bitrix24 mirror schema
-- ============================================================

-- Responsible users (Bitrix24 agents)
CREATE TABLE IF NOT EXISTS responsibles (
  id            INTEGER PRIMARY KEY,
  name          TEXT,
  last_name     TEXT,
  email         TEXT,
  work_position TEXT,
  active        BOOLEAN DEFAULT TRUE,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Lead/Deal pipeline stages
CREATE TABLE IF NOT EXISTS stages (
  id          SERIAL PRIMARY KEY,
  entity      TEXT NOT NULL CHECK (entity IN ('lead', 'deal')),
  bitrix_id   TEXT NOT NULL,          -- e.g. "NEW", "IN_PROCESS", "C1:NEW"
  name        TEXT NOT NULL,
  sort_order  INTEGER DEFAULT 0,
  is_final    BOOLEAN DEFAULT FALSE,  -- won/lost stages
  is_won      BOOLEAN DEFAULT FALSE,
  name_uz     TEXT,
  UNIQUE (entity, bitrix_id)
);

-- Leads
CREATE TABLE IF NOT EXISTS leads (
  id              INTEGER PRIMARY KEY,
  responsible_id  INTEGER REFERENCES responsibles(id),
  stage_id        INTEGER REFERENCES stages(id),
  opportunity     NUMERIC(15,2) DEFAULT 0,
  source_id       TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  utm_term        TEXT,
  uf_segment      TEXT,
  uf_filial       TEXT,
  uf_service      TEXT,
  uf_activity     TEXT,
  uf_with_whom    TEXT,
  uf_tashrif_sanasi TEXT,
  uf_amo_date     TIMESTAMPTZ,
  name            TEXT,
  last_name       TEXT,
  title           TEXT,
  date_create     TIMESTAMPTZ,
  date_modify     TIMESTAMPTZ,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leads_responsible_idx ON leads(responsible_id);
CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads(stage_id);
CREATE INDEX IF NOT EXISTS leads_date_create_idx ON leads(date_create);
CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source_id);
CREATE INDEX IF NOT EXISTS leads_uf_amo_date_idx ON leads(uf_amo_date);

-- Lead phone numbers. phone_norm = last 9 digits, computed once at write time
-- (a GENERATED column) so phone-matching joins hit a plain b-tree index instead
-- of re-running REGEXP_REPLACE per row. The normalization rule lives here, once.
CREATE TABLE IF NOT EXISTS lead_phones (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  phone      TEXT NOT NULL,
  phone_norm TEXT GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9)) STORED
);

CREATE INDEX IF NOT EXISTS lead_phones_lead_idx ON lead_phones(lead_id);
CREATE INDEX IF NOT EXISTS lead_phones_pnorm_idx ON lead_phones(phone_norm);

-- Deals
CREATE TABLE IF NOT EXISTS deals (
  id              INTEGER PRIMARY KEY,
  responsible_id  INTEGER REFERENCES responsibles(id),
  stage_id        INTEGER REFERENCES stages(id),
  opportunity     NUMERIC(15,2) DEFAULT 0,
  currency_id     TEXT,
  source_id       TEXT,
  utm_source      TEXT,
  title           TEXT,
  date_create     TIMESTAMPTZ,
  date_modify     TIMESTAMPTZ,
  closedate       TIMESTAMPTZ,
  uf_cancel_reason TEXT,
  contact_id      INTEGER,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_phones (
  contact_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  PRIMARY KEY (contact_id, phone)
);

CREATE INDEX IF NOT EXISTS deals_responsible_idx ON deals(responsible_id);
CREATE INDEX IF NOT EXISTS deals_stage_idx ON deals(stage_id);
CREATE INDEX IF NOT EXISTS deals_date_create_idx ON deals(date_create);

-- Deal phone numbers (see lead_phones for the phone_norm rationale).
CREATE TABLE IF NOT EXISTS deal_phones (
  id         SERIAL PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  phone      TEXT NOT NULL,
  phone_norm TEXT GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9)) STORED
);

CREATE INDEX IF NOT EXISTS deal_phones_deal_idx ON deal_phones(deal_id);
CREATE INDEX IF NOT EXISTS deal_phones_pnorm_idx ON deal_phones(phone_norm);

-- Lead stage history
CREATE TABLE IF NOT EXISTS lead_stage_history (
  id          SERIAL PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage_id    INTEGER REFERENCES stages(id),
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lsh_lead_idx ON lead_stage_history(lead_id);
CREATE INDEX IF NOT EXISTS lsh_changed_at_idx ON lead_stage_history(changed_at);

-- Deal stage history
CREATE TABLE IF NOT EXISTS deal_stage_history (
  id          SERIAL PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  stage_id    INTEGER REFERENCES stages(id),
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dsh_deal_idx ON deal_stage_history(deal_id);
CREATE INDEX IF NOT EXISTS dsh_changed_at_idx ON deal_stage_history(changed_at);

-- Webhook event audit log
CREATE TABLE IF NOT EXISTS webhook_logs (
  id          SERIAL PRIMARY KEY,
  event       TEXT NOT NULL,
  entity_id   INTEGER,
  payload     JSONB,
  processed   BOOLEAN DEFAULT FALSE,
  error       TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wl_event_idx ON webhook_logs(event);
CREATE INDEX IF NOT EXISTS wl_received_at_idx ON webhook_logs(received_at);

-- Facebook Lead Ads submissions
CREATE TABLE IF NOT EXISTS facebook_leads (
  id            TEXT PRIMARY KEY,          -- Facebook leadgen_id
  form_id       TEXT,
  ad_id         TEXT,
  ad_name       TEXT,
  adset_id      TEXT,
  adset_name    TEXT,
  campaign_id   TEXT,
  campaign_name TEXT,
  page_id       TEXT,
  full_name     TEXT,
  phone         TEXT,
  email         TEXT,
  field_data    JSONB,                     -- all raw form fields
  created_time  TIMESTAMPTZ,
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  phone_norm    TEXT GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9)) STORED
);

CREATE INDEX IF NOT EXISTS fb_leads_campaign_idx  ON facebook_leads(campaign_id);
CREATE INDEX IF NOT EXISTS fb_leads_created_idx   ON facebook_leads(created_time);
CREATE INDEX IF NOT EXISTS fb_leads_form_idx      ON facebook_leads(form_id);
CREATE INDEX IF NOT EXISTS fb_leads_pnorm_idx      ON facebook_leads(phone_norm);

-- Sync state tracker
CREATE TABLE IF NOT EXISTS sync_state (
  entity      TEXT PRIMARY KEY,
  last_sync   TIMESTAMPTZ DEFAULT NOW(),
  total_rows  INTEGER DEFAULT 0
);

-- Meta Ads API response cache (1-hour TTL)
CREATE TABLE IF NOT EXISTS campaign_cache (
  id         SERIAL PRIMARY KEY,
  endpoint   VARCHAR(100) NOT NULL,
  month      INT NOT NULL,
  year       INT NOT NULL,
  data       JSONB NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(endpoint, month, year)
);

-- ============================================================
-- Seed lead stages (Bitrix24 default lead statuses)
-- ============================================================
INSERT INTO stages (entity, bitrix_id, name, sort_order, is_final, is_won) VALUES
  ('lead', 'NEW',         'Yangi lid',        10, FALSE, FALSE),
  ('lead', 'IN_PROCESS',  'Ishlash jarayoni', 20, FALSE, FALSE),
  ('lead', 'PROCESSED',   'Ishlandi',         30, FALSE, FALSE),
  ('lead', '1',           'Javob bermadi',     40, FALSE, FALSE),
  ('lead', '2',           'Qayta aloqa',       50, FALSE, FALSE),
  ('lead', '3',           'O''ylab ko''radi',  60, FALSE, FALSE),
  ('lead', 'JUNK',        'Keraksiz',          70, TRUE,  FALSE),
  ('lead', 'CONVERTED',   'Aylantrildi',       80, TRUE,  TRUE)
ON CONFLICT (entity, bitrix_id) DO NOTHING;

-- ============================================================
-- Seed deal stages (typical Bitrix24 pipeline)
-- ============================================================
INSERT INTO stages (entity, bitrix_id, name, sort_order, is_final, is_won) VALUES
  ('deal', 'C1:NEW',          'Yangi',           10, FALSE, FALSE),
  ('deal', 'C1:PREPARATION',  'Tayyorlash',      20, FALSE, FALSE),
  ('deal', 'C1:EXECUTING',    'Bajarilmoqda',    30, FALSE, FALSE),
  ('deal', 'C1:FINAL_INVOICE','Yakuniy hisob',   40, FALSE, FALSE),
  ('deal', 'C1:WON',          'Yutildi',         50, TRUE,  TRUE),
  ('deal', 'C1:LOSE',         'Yutqizildi',      60, TRUE,  FALSE)
ON CONFLICT (entity, bitrix_id) DO NOTHING;
