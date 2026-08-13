# Pattern: report-stage dimension (grouping by a free-text field, not live status)

Extracted from AIST- (`server/bitrix.mjs`, `src/components/KonversiyaTable.tsx`) as a
reusable pattern for the next project. Not AIST-specific — applies to any CRM/pipeline
dashboard where the client wants a report grouped by a label that doesn't match the
record's real, live pipeline status.

## The problem

A stakeholder wants a report table grouped by "stage" for reporting purposes, but the
grouping doesn't match the record's actual live pipeline stage (`STATUS_ID` /
`stage_id`). Reasons this comes up:
- The real pipeline has more stages than the report should show (they want stages
  collapsed/relabeled for a monthly report).
- The report's "stage" is manually assigned by a manager and drifts from the pipeline
  on purpose (e.g. an account manager overrides which bucket a deal reports under).
- There are multiple competing versions of "the report stage" from different
  stakeholders (sales wants one grouping, marketing wants another) that must coexist
  without either one clobbering the pipeline itself.

Don't reach for "just recompute it from status" — if the client asked for a *separate*
field, they want independence from the pipeline, including the ability for the two to
disagree.

## The pattern

1. **Model the label as its own field**, separate from the entity's live status field.
   In Bitrix this is a plain custom field (`UF_CRM_*`, free text or enum) that a human
   sets directly — never derived from `STATUS_ID` server-side. If two report groupings
   are needed, that's two separate fields (see AIST-: "Стадия (для отчетов)" and
   "Стадия (для отчетов) 2" back two different tabs).

2. **Metrics stay keyed off the real status fields**, not the report-stage value. Only
   the *grouping key* changes; every metric inside a group (counts by semantic status,
   conversion rate, etc.) is computed the same way regardless of which dimension the
   report is currently grouped by. This keeps one metric function reusable across every
   tab:

   ```js
   const DIMS = {
     manager:      l => [l.manager_id || '—', l.manager_name || '—'],
     source:       l => [l.source_id  || '—', l.source_name  || l.source_id || '—'],
     report_stage: l => { const v = l.report_stage; return [v || '—', v || '']; }, // no value → blank row, not dropped
   };

   function metrics(list) {
     return {
       total: list.length,
       inProgress: list.filter(l => l.semantic === 'P').length,
       won:        list.filter(l => l.semantic === 'S').length,
       // ...every metric reads the live status fields, never the report-stage value
     };
   }

   function computeReport(records, dimension) {
     const keyer = DIMS[dimension] || DIMS.manager;
     const groups = new Map();
     for (const r of records) {
       const [key, name] = keyer(r);
       (groups.get(key) ?? groups.set(key, { key, name, list: [] }).get(key)).list.push(r);
     }
     return [...groups.values()].map(g => ({ key: g.key, name: g.name, ...metrics(g.list) }));
   }
   ```

3. **Missing values get their own bucket, never dropped.** A record with no report-stage
   value is still real data — usually "hasn't been triaged into the report yet". Key it
   as `'—'` with a blank/dash label rather than filtering it out, so totals still add up
   to the full record count and the gap is visible instead of silently missing.

4. **One dimension registry drives every tab.** Don't hand-write a separate query per
   tab — register `{ key, keyer }` pairs and let one generic group-and-summarize
   function serve all of them (manager / source / report-stage / date / …). Adding a
   new tab is adding one entry, not duplicating the aggregation logic.

5. **Per-tab column overrides are a display-layer concern, not a data-layer one.** If one
   grouping needs a differently-labeled or differently-sourced metric in one column
   (AIST-'s "Stadiya" tab swaps a status-derived count for a separate UF-field-derived
   count in the same column slot), do that swap in the frontend's column config, not by
   forking the backend aggregation:

   ```ts
   const BASE_COLS = [...]; // shared across every tab
   const STAGE_TAB_COLS = BASE_COLS.map(c =>
     c.key === 'visited' ? { ...c, label: 'Marked visited', get: r => r.markedVisitedCount } : c
   );
   ```

6. **Reuse the same keyer for pivot/matrix views.** If the dashboard also has a pivot
   table (rows × dimension-as-columns), the report-stage keyer is exactly the column
   keyer — don't re-derive column values with separate logic that can drift from the
   flat table's grouping.

7. **Drill-down filters by the same key function**, so "click a row → see the underlying
   records" is guaranteed consistent with how that row's totals were computed:

   ```js
   const recordsInGroup = (records, dimension, key) =>
     records.filter(r => (DIMS[dimension] || DIMS.manager)(r)[0] === key);
   ```

## Naming/labeling gotcha

If the client gives you two near-identical field names for two report tabs (e.g. a
field and "the same field, v2"), do **not** try to guess which is more "correct" or
collapse them into one — they exist as two because two different stakeholders wanted
independent control. Keep them as two fields, two dimension keys, two tabs, and document
which literal field code backs which tab label right next to the field constant, e.g.:

```js
/** "Стадия (для отчетов)" — free text; the Stadiya tab groups by this. */
const F_REPORT_STAGE1 = 'UF_CRM_1771440293231';
/** "Стадия (для отчетов) 2" — free text; the Stadiya (otchyot) tab groups by this. */
const F_REPORT_STAGE  = 'UF_CRM_1783166097';
```

Six months later, the field code is the only thing that reliably tells you which tab
you're looking at — the human labels in the source CRM are exactly the kind of thing
that gets renamed without anyone updating the code comment.
