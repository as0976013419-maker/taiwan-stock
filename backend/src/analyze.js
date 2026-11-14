"use strict";
// /analyze：單一個股的資料彙整 → 指標 → 評分 → 規則式報告
const { cached, daysAgo, round } = require("./util");
const { snapshot } = require("./indicators");
const { scoreStock, VERSION } = require("./scoring");
const { sectorStats } = require("./scan");
const { buildReport } = require("./report");

const ok = (r) => (r.status === "fulfilled" ? r.value : null);

/** 代號或名稱 → 代號 */
async function resolveCode(src, input) {
  const s = String(input || "").trim().toUpperCase();
  if (/^[0-9]{4,6}[A-Z]?$/.test(s)) return s;
  try { const snap = await src.getMarketSnapshot(); for (const r of snap.stocks.values()) if (r.name === input.trim()) return r.code; } catch (e) { /* 快照失敗就當作找不到 */ }
  return null;
}

async function analyze(src, input) {
  const code = await resolveCode(src, input);
  if (!code) throw Object.assign(new Error("請輸入正確的股票代號（如 2330）或完整名稱"), { status: 400 });
  let fresh = false;
  const data = await cached("analyze:" + code, 180000, async () => { fresh = true; return build(src, code); });
  return Object.assign({}, data, { cached: !fresh });
}

async function build(src, code) {
  const [rs, rq, rh, rc, rm, rr] = await Promise.allSettled([
    src.getMarketSnapshot(), src.getQuote(code), src.getHistory(code, daysAgo(560)), src.getChip(code), src.getMargin(code), src.getRevenue(code),
  ]);
  const snapAll = ok(rs), row = snapAll ? snapAll.stocks.get(code) : null, live = ok(rq), hist = ok(rh);
  // 本益比等估值：全市場快照已有就不再多打一次個股 API（節省 FinMind 額度）
  const rp = (row && (row.pe || row.isETF)) ? { status: "fulfilled", value: null } : await src.getPER(code).then((value) => ({ status: "fulfilled", value }), () => ({ status: "rejected" }));
  const quota = [rh, rc, rm, rr].some((r) => r.status === "rejected" && r.reason && r.reason.quota);
  const hasHist = hist && hist.closes && hist.closes.length >= 30;
  if (!row && !live && !hasHist) throw Object.assign(new Error("查無此股票代號，或資料來源暫時無法連線：" + code), { status: 404 });

  // 報價優先序：盤中即時 → 日收盤快照 → 歷史最後一根
  const n = hasHist ? hist.closes.length - 1 : -1;
  const fromHist = hasHist ? { code, name: code, price: hist.closes[n], prevClose: hist.closes[n - 1], change: round(hist.closes[n] - hist.closes[n - 1]), changePct: round((hist.closes[n] / hist.closes[n - 1] - 1) * 100), open: hist.opens[n], high: hist.highs[n], low: hist.lows[n], volume: Math.round(hist.volumes[n] / 1000), date: hist.dates[n] } : {};
  const quote = Object.assign({}, fromHist, row || {}, live || {}, { code, name: (row && row.name) || (live && live.name) || code, isETF: /^00/.test(code), industry: row ? row.industry : null });
  delete quote.inst; delete quote.margin;

  // 盤中：把即時價併入歷史最後一根，讓指標反映當下
  let h = hasHist ? hist : null;
  const liveDay = live && live.realtime ? (live.time || "").slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : "";
  if (h && liveDay && live.price) h = mergeBar(h, { date: liveDay, price: live.price, open: live.open, high: live.high, low: live.low, volume: live.volume });
  else if (h && row) h = mergeBar(h, row);
  const indicators = h ? snapshot(h) : null;
  const chip = ok(rc) && ok(rc).length ? ok(rc) : null, margin = ok(rm) && ok(rm).length ? ok(rm) : null, revenue = ok(rr), per = ok(rp);
  const fundamentals = {
    pe: (per && per.pe) || (row && row.pe) || null, pb: (per && per.pb) || (row && row.pb) || null, yield: (per && per.yield) || (row && row.yield) || null,
    revYoY: revenue && revenue.yoy !== null ? revenue.yoy : (row ? row.revYoY : null), revMoM: revenue && revenue.mom !== null ? revenue.mom : (row ? row.revMoM : null),
  };
  if (quote.isETF) { fundamentals.pe = fundamentals.pb = fundamentals.revYoY = fundamentals.revMoM = null; }
  let sector = null;
  if (snapAll && row && !row.isETF) { const st = sectorStats([...snapAll.stocks.values()].filter((r) => r.price > 0)).get(row.industry); if (st) sector = { sector: st.sector, rank: st.rank, heat: st.heat, upRatio: st.upRatio, avgChangePct: st.avgChangePct, count: st.count }; }

  const scored = scoreStock({ snap: Object.assign({}, row || {}, { isETF: quote.isETF }), ind: indicators, chip, margin, fund: fundamentals, sector });
  const missing = [];
  if (quota) missing.push("FinMind 額度已用盡（約 10 分鐘後恢復，或設定 FINMIND_TOKEN）");
  if (!indicators) missing.push("歷史K線"); if (!chip) missing.push(row && row.inst ? "三大法人歷史（僅有當日）" : "三大法人"); if (!margin && !quote.isETF) missing.push("融資融券"); if (!revenue && !quote.isETF && fundamentals.revYoY === null) missing.push("月營收");
  const out = { code, quote, indicators, chip, margin, fundamentals, revenue, sector, scored, missing, instToday: row ? row.inst : null, marginToday: row ? row.margin : null, _v: VERSION, demo: !!src.demo,
    history: h ? h.dates.slice(-60).map((d, k) => { const j = h.dates.length - Math.min(60, h.dates.length) + k; return { date: d, open: h.opens[j], high: h.highs[j], low: h.lows[j], close: h.closes[j], volume: h.volumes[j] }; }) : [] };
  out.text = buildReport(out);
  return out;
}
/** 把「今天」的行情併入歷史最後一根（歷史快取較久，最新一根以快照／即時報價為準） */
function mergeBar(h, q) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : null, n = h.dates.length - 1;
  if (!d || !q.price || d < h.dates[n]) return h;
  const bar = { o: q.open || q.price, hi: q.high || q.price, lo: q.low || q.price, c: q.price, v: (q.volume || 0) * 1000 };
  const put = (arr, v) => (d === h.dates[n] ? arr.slice(0, n).concat(v) : arr.concat(v));
  return { code: h.code, dates: put(h.dates, d), opens: put(h.opens, bar.o), highs: put(h.highs, bar.hi), lows: put(h.lows, bar.lo), closes: put(h.closes, bar.c), volumes: put(h.volumes, bar.v) };
}
module.exports = { analyze, resolveCode, mergeBar };
