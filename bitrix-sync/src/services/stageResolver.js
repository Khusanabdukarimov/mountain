const pool = require('../db/pool');
const { bitrixCall } = require('./bitrix');

// In-memory cache: "lead:NEW" → stages.id (integer)
const _cache = new Map();
let _loaded = false;

async function loadAll() {
  const { rows } = await pool.query('SELECT id, entity, bitrix_id FROM stages');
  rows.forEach((r) => _cache.set(`${r.entity}:${r.bitrix_id}`, r.id));
  _loaded = true;
}

/**
 * Resolve a Bitrix24 status string to the local stages.id.
 * Inserts a new stage row if not found (so unknown statuses don't break upserts).
 *
 * @param {string} entity     'deal' | 'lead'
 * @param {string} bitrixId   e.g. 'C4:WON'
 * @param {string} [semanticId]  Bitrix STAGE_SEMANTIC_ID: 'S' = won, 'F' = lost, '' = in-progress
 */
async function resolve(entity, bitrixId, semanticId) {
  if (!bitrixId) return null;
  if (!_loaded) await loadAll();

  const key = `${entity}:${bitrixId}`;
  if (_cache.has(key)) return _cache.get(key);

  // Use STAGE_SEMANTIC_ID when available ('S' = won, 'F' = fail/lost).
  // Fall back to name-pattern detection for stages synced without semantic info.
  const suffix   = bitrixId.includes(':') ? bitrixId.split(':').pop().toUpperCase() : bitrixId.toUpperCase();
  const isWon    = semanticId === 'S' || suffix === 'WON' || suffix === 'UC_NV0Y4F';
  const isFinal  = isWon || semanticId === 'F' || suffix === 'LOSE';

  // Unknown stage — insert it; upgrade is_won/is_final if we now have better info
  let { rows } = await pool.query(
    `INSERT INTO stages (entity, bitrix_id, name, sort_order, is_won, is_final)
     VALUES ($1, $2, $3, 999, $4, $5)
     ON CONFLICT (entity, bitrix_id) DO UPDATE
       SET is_won   = CASE WHEN EXCLUDED.is_won   THEN TRUE ELSE stages.is_won   END,
           is_final = CASE WHEN EXCLUDED.is_final THEN TRUE ELSE stages.is_final END
     RETURNING id`,
    [entity, bitrixId, bitrixId, isWon, isFinal]
  );

  if (!rows.length) {
    const res = await pool.query(
      'SELECT id FROM stages WHERE entity = $1 AND bitrix_id = $2',
      [entity, bitrixId]
    );
    rows = res.rows;
  }

  const id = rows[0].id;
  _cache.set(key, id);
  return id;
}

function invalidate() {
  _cache.clear();
  _loaded = false;
}

/**
 * Fetch all deal pipeline stages from Bitrix24 and upsert them with correct
 * is_won / is_final flags based on SEMANTICS ('S' = won, 'F' = lost).
 * Called once at startup to fix any stages that were auto-inserted without
 * semantic info (e.g. stages from non-default pipelines).
 */
async function syncDealStagesFromBitrix() {
  try {
    // Get all custom pipelines; category 0 = default pipeline
    const catRes = await bitrixCall('crm.dealcategory.list', {}, 'stage-resolver');
    const categories = catRes.result || [];
    const categoryIds = [0, ...categories.map(c => parseInt(c.ID))];

    for (const catId of categoryIds) {
      // id must be a top-level param — do NOT use fetchAll (it wraps as filter[id])
      const stagesRes = await bitrixCall('crm.dealcategory.stage.list', { id: catId }, 'stage-resolver');
      const stages = stagesRes.result || [];
      for (const s of stages) {
        // SEMANTICS: 'S' = won, 'F' = lost, '' = in-progress
        const isWon   = s.SEMANTICS === 'S';
        const isFinal = isWon || s.SEMANTICS === 'F';
        // Bitrix stage IDs for deals follow the pattern C{catId}:{STATUS_ID}
        const bitrixId = s.STATUS_ID; // already includes pipeline prefix e.g. 'C4:WON'
        await pool.query(
          `INSERT INTO stages (entity, bitrix_id, name, sort_order, is_won, is_final)
           VALUES ('deal', $1, $2, $3, $4, $5)
           ON CONFLICT (entity, bitrix_id) DO UPDATE
             SET name     = EXCLUDED.name,
                 is_won   = CASE WHEN EXCLUDED.is_won   THEN TRUE ELSE stages.is_won   END,
                 is_final = CASE WHEN EXCLUDED.is_final THEN TRUE ELSE stages.is_final END`,
          [bitrixId, s.NAME || bitrixId, parseInt(s.SORT) || 999, isWon, isFinal]
        );
      }
    }

    invalidate(); // clear cache so next resolve() picks up updated flags
    console.log('[stageResolver] deal stages synced from Bitrix');
  } catch (err) {
    console.error('[stageResolver] syncDealStagesFromBitrix failed:', err.message);
  }
}

module.exports = { resolve, loadAll, invalidate, syncDealStagesFromBitrix };
