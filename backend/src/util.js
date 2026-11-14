"use strict";
// 共用工具：TTL 快取、帶逾時的 fetch、併發限制、數字解析

const _cache = new Map();
/** 取快取；沒有或過期就執行 fn 並存入。同一 key 併發只打一次上游。 */
async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.val;
  if (hit && hit.pending) return hit.pending;
  const pending = (async () => {
    try {
      const val = await fn();
      _cache.set(key, { val, exp: Date.now() + ttlMs });
      return val;
    } catch (e) {
      // 上游失敗時，若有舊資料就繼續用舊的（stale-if-error）
      if (hit && hit.val !== undefined) { _cache.set(key, { val: hit.val, exp: Date.now() + 30000 }); return hit.val; }
      _cache.delete(key);
      throw e;
    }
  })();
  _cache.set(key, Object.assign({}, hit || { exp: 0 }, { pending }));
  return pending;
}
function cacheAge(key) { const h = _cache.get(key); return h && h.exp > Date.now(); }
function cacheSize() { return _cache.size; }
setInterval(() => { // 定期清掉過期項目，避免長時間運行記憶體膨脹
  const now = Date.now();
  for (const [k, v] of _cache) if (v.exp + 3600000 < now && !v.pending) _cache.delete(k);
}, 600000).unref();

async function fetchJson(url, { timeout = 15000, headers = {}, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: Object.assign({ "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; tw-stock-research/5.0)" }, headers),
      });
      if (!r.ok) throw new Error("HTTP " + r.status + " " + new URL(url).hostname);
      return await r.json();
    } catch (e) { lastErr = e; if (i < retries) await sleep(400 * (i + 1)); }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 併發上限 n 的 map；單筆失敗回傳 null，不中斷整批 */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; } }
  }));
  return out;
}

/** "1,234.5" / "+5.00" / "X0.00" / "--" → number 或 null */
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, "").replace(/<[^>]*>/g, "").trim();
  const m = s.match(/[-+]?\d+(\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return isFinite(n) ? n : null;
}
/** 依多個候選欄位名取值（上游欄位改名時的容錯） */
function pick(obj, keys) { for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== "") return obj[k]; return undefined; }
const round = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pctStr = (v) => (v === null || v === undefined || !isFinite(v)) ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%";
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
/** 台北時間的今天 */
function taipeiNow() { return new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000); }
function daysAgo(n) { const d = taipeiNow(); d.setDate(d.getDate() - n); return ymd(d); }

module.exports = { cached, cacheAge, cacheSize, fetchJson, sleep, mapLimit, num, pick, round, clamp, pctStr, ymd, taipeiNow, daysAgo };
