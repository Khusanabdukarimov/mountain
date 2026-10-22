'use strict';

// Which Creative (ad) a won deal's sale belongs to — one deal, one creative row.
//
// A won deal is traced to the Meta form submission it came from:
//   A  the deal's lead -> same-phone form lead of the lead's campaign
//   B  a deal with no lead -> same-phone form lead
//   C  neither (e.g. a returning customer's new deal) -> the deal card's own UTM
//      (utm_content = adset, utm_campaign = campaign)
// A person can have several form submissions (other ads, other adsets), so a deal can
// match many; it is credited to exactly one: the submission whose ad is the one the
// lead card itself names (utm_term / utm_content), else the latest submission. Before
// this, every matching adset — and, in /creatives, every ad row of the adset — got the
// whole sale, so the page's JAMI row added the same deal up to several times.
//
// The sale lands on the creative row of its ad. A row exists for every ad that has a form
// lead in the lead date window (what /creatives lists); when the credited ad has none,
// the sale goes to the adset's biggest row, and a sale whose adset has no row at all is
// not shown (as before). /creatives (counts) and /creative-deals (the drill-down) both
// read this, so a row's number always matches the deals listed under it.

const SQL = `
WITH won AS (
  SELECT d.id, d.lead_id, d.opportunity, d.currency_id, d.date_create, d.responsible_id, d.stage_id,
         d.utm_campaign, d.utm_content
  FROM deals d
  JOIN stages ds ON ds.id = d.stage_id AND ds.is_won = true
  WHERE d.uf_bp_sale_date >= $3::date AND d.uf_bp_sale_date <= $4::date
),
ad_rows AS (
  SELECT COALESCE(fl.adset_name, 'N/A') AS adset_name, COALESCE(fl.campaign_name, 'N/A') AS campaign_name,
         fl.ad_id, COUNT(DISTINCT fl.id) AS n
  FROM facebook_leads fl
  WHERE (fl.created_time AT TIME ZONE 'Asia/Tashkent')::date >= $1::date
    AND (fl.created_time AT TIME ZONE 'Asia/Tashkent')::date <= $2::date
  GROUP BY 1, 2, 3
),
primary_ad AS (
  SELECT DISTINCT ON (adset_name, campaign_name) adset_name, campaign_name, ad_id
  FROM ad_rows
  ORDER BY adset_name, campaign_name, n DESC, ad_id NULLS LAST
),
via_form AS (
  SELECT DISTINCT ON (c.deal_id) c.deal_id, c.ad_id, c.adset_name, c.campaign_name, c.phone
  FROM (
    SELECT w.id AS deal_id, fl.ad_id,
           COALESCE(fl.adset_name, 'N/A') AS adset_name, COALESCE(fl.campaign_name, 'N/A') AS campaign_name,
           fl.phone, fl.created_time,
           (fl.ad_name IS NOT DISTINCT FROM le.utm_term AND fl.adset_name IS NOT DISTINCT FROM le.utm_content) AS exact
    FROM won w
    JOIN leads le ON le.id = w.lead_id
    JOIN lead_phones lp ON lp.lead_id = le.id
    JOIN facebook_leads fl ON fl.phone_norm = lp.phone_norm AND fl.phone_norm <> ''
                          AND fl.campaign_name = le.utm_campaign
    UNION ALL
    SELECT w.id, fl.ad_id,
           COALESCE(fl.adset_name, 'N/A'), COALESCE(fl.campaign_name, 'N/A'),
           fl.phone, fl.created_time, FALSE
    FROM won w
    JOIN deal_phones dp ON dp.deal_id = w.id
    JOIN facebook_leads fl ON fl.phone_norm = dp.phone_norm AND fl.phone_norm <> ''
    WHERE w.lead_id IS NULL
  ) c
  ORDER BY c.deal_id, c.exact DESC, c.created_time DESC
),
via_deal_utm AS (
  SELECT w.id AS deal_id, NULL::text AS ad_id, w.utm_content AS adset_name, w.utm_campaign AS campaign_name,
         NULL::text AS phone
  FROM won w
  LEFT JOIN leads le ON le.id = w.lead_id
  WHERE NULLIF(w.utm_campaign, '') IS NOT NULL
    AND NULLIF(w.utm_content, '') IS NOT NULL
    AND (w.lead_id IS NULL OR COALESCE(le.utm_campaign, '') = '')
    AND NOT EXISTS (
      SELECT 1 FROM deal_phones dp
      JOIN facebook_leads fl ON fl.phone_norm = dp.phone_norm AND fl.phone_norm <> ''
      WHERE dp.deal_id = w.id AND w.lead_id IS NULL
    )
)
SELECT a.deal_id,
       CASE WHEN a.ad_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM ad_rows r
              WHERE r.adset_name = a.adset_name AND r.campaign_name = a.campaign_name AND r.ad_id = a.ad_id)
            THEN a.ad_id ELSE p.ad_id END                         AS row_ad_id,
       a.adset_name, a.campaign_name, a.phone,
       CASE WHEN w.currency_id = 'USD' THEN COALESCE(w.opportunity, 0) ELSE 0 END AS opp_usd,
       w.opportunity, w.currency_id, w.date_create, s.name AS stage_name,
       TRIM(COALESCE(r.name, '') || ' ' || COALESCE(r.last_name, '')) AS responsible
FROM (
  SELECT deal_id, ad_id, adset_name, campaign_name, phone FROM via_form
  UNION ALL
  SELECT deal_id, ad_id, adset_name, campaign_name, phone FROM via_deal_utm
) a
JOIN won w ON w.id = a.deal_id
JOIN primary_ad p ON p.adset_name = a.adset_name AND p.campaign_name = a.campaign_name
LEFT JOIN stages s ON s.id = w.stage_id
LEFT JOIN responsibles r ON r.id = w.responsible_id
ORDER BY w.id
`;

/** Key of one Creative row, as /creatives builds it. */
const rowKey = (adset, campaign, adId) => `${adset ?? 'N/A'}|${campaign ?? 'N/A'}|${adId ?? ''}`;

/**
 * One row per counted sale: { deal_id, row_ad_id, adset_name, campaign_name, phone, opp_usd,
 * opportunity, currency_id, date_create, stage_name, responsible }.
 * `since`/`until` is the lead date window (which creative rows exist), `sotuvFrom`/`sotuvTo` the sale dates.
 */
async function attributedSales(db, { since, until, sotuvFrom, sotuvTo }) {
  const { rows } = await db.query(SQL, [since, until, sotuvFrom, sotuvTo]);
  return rows;
}

module.exports = { attributedSales, rowKey };
