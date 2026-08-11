/**
 * Fetches currency exchange rates from Bitrix24 and caches them for 1 hour.
 * All rates are relative to USD (base currency).
 *
 * Bitrix24 format: AMOUNT_CNT units of currency = AMOUNT USD
 * e.g. UZS: AMOUNT_CNT=12100, AMOUNT=1  → 1 USD = 12100 UZS
 */
const { bitrixCall } = require('./bitrix');

let cache = {};      // { UZS: 12100, USD: 1, ... }
let cacheAt = 0;
const TTL = 60 * 60 * 1000; // 1 hour

async function getRates() {
  if (Date.now() - cacheAt < TTL && Object.keys(cache).length > 0) return cache;

  try {
    const res  = await bitrixCall('crm.currency.list', {}, 'currency-rates');
    const list = res.result || [];
    const rates = {};
    for (const c of list) {
      // rate = how many units of currency per 1 USD
      const cnt    = parseFloat(c.AMOUNT_CNT) || 1;
      const amount = parseFloat(c.AMOUNT)     || 1;
      rates[c.CURRENCY] = cnt / amount;
    }
    cache   = rates;
    cacheAt = Date.now();
    return rates;
  } catch (err) {
    console.error('[currency] failed to fetch rates:', err.message);
    return cache; // return stale on error
  }
}

/**
 * Convert an amount from fromCurrency to USD.
 * Returns null if amount is null/undefined.
 */
async function toUSD(amount, fromCurrency) {
  if (amount == null) return null;
  const num = parseFloat(amount);
  if (isNaN(num)) return null;
  if (!fromCurrency || fromCurrency === 'USD') return Math.round(num * 100) / 100;

  const rates = await getRates();
  const rate  = rates[fromCurrency];
  if (!rate) return Math.round(num * 100) / 100; // unknown currency → keep as-is
  return Math.round((num / rate) * 100) / 100;
}

module.exports = { getRates, toUSD };
