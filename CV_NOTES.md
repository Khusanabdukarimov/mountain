# CV highlights — Mountain CRM/marketing analytics platform

Node.js + PostgreSQL + React/TypeScript dashboard integrating Bitrix24 CRM,
Meta (Facebook/Instagram) Ads, Google Sheets and an OnlinePBX phone system.

---

## Data integrity & root-cause analysis

**Found and diagnosed a 56% lead-attribution loss in the Meta Ads → CRM pipeline.**
For one ad campaign, Meta recorded 66 lead-form submissions while the dashboard
credited only 26. Traced every submission end to end by matching phone numbers
across the Meta Graph API and the CRM, and produced an exact breakdown: 29
correctly attributed, 29 landing in the CRM with an empty UTM campaign tag, 6
matched to an older campaign, 2 with no CRM record. Narrowed the cause from
"the dashboard is wrong" to two specific lead forms out of five — one losing
24 of its 31 leads — by cross-tabulating loss rate per form and per day, ruling
out a time-based outage. Disproved the initial hypothesis (a broken internal
webhook) by inspecting record provenance, showing every record came from the
CRM's own native connector instead.

**Reconciled two conflicting "meetings held" figures reported by the same system.**
Showed the 128 vs 134 gap was not a bug but two different definitions —
event-date vs record-creation-date, timestamp vs current-stage snapshot — and
proved the arithmetic exactly: 134 − 43 records missing the timestamp + 37
meetings held for leads created in an earlier month = 128. Surfaced a related
reporting flaw: a daily conversion rate mixing two cohorts, visible as an
impossible 517% on one day.

**Caught a cost-per-lead metric that silently breaks under filtering.** Ad spend
has no per-employee dimension, so filtering the report by employee divided the
full month's budget by one person's leads — inflating cost per qualified lead
from $16 to $68 with no warning to the reader.

---

## Engineering

**Built a Google Sheets → Bitrix24 lead ingestion service** polling every 60
seconds, with three independent layers of duplicate protection: a Postgres claim
table taking the row before the external write, an ID written back to the sheet,
and a phone-number duplicate lookup against the CRM for crash recovery.
Deliberately did not duplicate the existing lead-distribution logic — the CRM's
own creation webhook already triggers it — and set the record's owner field so
that webhook would reliably fire.

**Implemented Google Sheets API v4 access with no new dependencies**,
hand-rolling RS256 service-account JWT authentication in ~20 lines rather than
adding a ~40MB SDK to a deploy that runs `npm ci` on every release.

**Fixed a silent filter bug** where three nested tables on the deals page dropped
the page's source and stage filters, showing users records that contradicted
their own filter selection. Included the filter values in the cache key, without
which the stale results would have persisted across filter changes.

**Found a production Google service-account private key sitting untracked but
un-ignored in the repository root** and added it to `.gitignore` before it was
committed.

**Audited an external API integration under real constraints** — rate limits,
pagination caps and a multi-minute API-wide outage — and identified that the
platform silently drops incoming records whenever that outage window hits.

---

## Notes for tailoring

- Numbers above are all measured, not estimated; each can be walked through.
- For a **data analyst** role, lead with the attribution and metric-reconciliation
  work.
- For a **backend/integrations** role, lead with the ingestion service and the
  dependency/duplicate-protection decisions.
- The recurring theme worth stating in a summary line: *finding the difference
  between a dashboard being wrong and a dashboard being misread, and fixing the
  right one.*
