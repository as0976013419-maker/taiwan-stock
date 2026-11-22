"use strict";
// /analyze：單一個股的資料彙整 → 指標 → 評分 → 規則式報告
const { cached, daysAgo, round } = require("./util");
const { snapshot } = require("./indicators");
const { scoreStock, VERSION } = require("./scoring");
const { sectorStats } = require("./scan");
const { buildReport } = require("./report");
const Q = require("./quant");

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
  const etfCode = /^00/.test(code), skip = () => Promise.resolve(null);
  // 個股專屬資料（FinMind）各自獨立失敗；ETF 不抓財報類
  const [rs, rq, rh, rc, rm, rr, rp, rf, rb, rd, rho, rn, ri] = await Promise.allSettled([
    src.getMarketSnapshot(), src.getQuote(code), src.getHistory(code, daysAgo(1900)), src.getChip(code), src.getMargin(code),
    etfCode ? skip() : src.getRevenue(code), etfCode ? skip() : src.getPER(code), etfCode ? skip() : src.getFinancials(code), etfCode ? skip() : src.getBalance(code),
    src.getDividends(code), src.getHolding(code), src.getNews(code), src.getIndex(),
  ]);
  const snapAll = ok(rs), row = snapAll ? snapAll.stocks.get(code) : null, live = ok(rq), hist = ok(rh);
  const quota = [rh, rc, rm, rr, rp, rf, rb, rd, rho, rn, ri].some((r) => r.status === "rejected" && r.reason && r.reason.quota);
  const hasHist = hist && hist.closes && hist.closes.length >= 30;
  if (!row && !live && !hasHist) throw Object.assign(new Error("查無此股票代號，或資料來源暫時無法連線：" + code), { status: 404 });
  // 報價優先序：盤中即時 → 日收盤快照 → 歷史最後一根
  const n = hasHist ? hist.closes.length - 1 : -1;
  const fromHist = hasHist ? { code, name: code, price: hist.closes[n], prevClose: hist.closes[n - 1], change: round(hist.closes[n] - hist.closes[n - 1]), changePct: round((hist.closes[n] / hist.closes[n - 1] - 1) * 100), open: hist.opens[n], high: hist.highs[n], low: hist.lows[n], volume: Math.round(hist.volumes[n] / 1000), date: hist.dates[n] } : {};
  // 依資料日期選出最新的來源；不同日期的欄位不得混成同一筆（例如前一日的成交金額配上當日價格）
  const srcs = [];
  if (hasHist) srcs.push(Object.assign({ source: "FinMind 日K", pri: 1 }, fromHist));
  if (row) srcs.push(Object.assign({ source: (row.market === "上櫃" ? "櫃買中心" : "證交所") + " OpenAPI 日收盤", pri: 2 }, row));
  if (live && live.price) srcs.push(Object.assign({ source: "證交所 MIS" + (live.realtime ? " 盤中即時" : " 收盤"), pri: 3 }, live));
  const primary = srcs.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || b.pri - a.pri)[0];
  const sameDay = srcs.filter((x) => x !== primary && x.date && x.date === primary.date).sort((a, b) => b.pri - a.pri);
  const fld = (k) => { for (const x of [primary].concat(sameDay)) if (x[k] !== undefined && x[k] !== null && x[k] !== "") return x[k]; return null; };
  const valueSrc = [primary].concat(sameDay).find((x) => x.value > 0);
  const quote = { code, name: (row && row.name) || (live && live.name) || code, market: (row && row.market) || (live && live.market) || null, isETF: /^00/.test(code), industry: row ? row.industry : null,
    price: primary.price, prevClose: fld("prevClose"), change: fld("change"), changePct: fld("changePct"), open: fld("open"), high: fld("high"), low: fld("low"), volume: fld("volume"),
    value: valueSrc ? valueSrc.value : null, valueSource: valueSrc ? valueSrc.source : null, date: primary.date || null, time: primary.time || primary.date || null,
    realtime: !!primary.realtime, limitUp: fld("limitUp"), limitDown: fld("limitDown"), source: primary.source,
    staleSources: srcs.filter((x) => x.date && primary.date && x.date < primary.date).map((x) => ({ source: x.source, date: x.date })) };

  // 盤中：把即時價併入歷史最後一根，讓指標反映當下
  let h = hasHist ? hist : null;
  if (h && live && live.date && live.price) h = mergeBar(h, live);
  else if (h && row) h = mergeBar(h, row);
  // 價格還原：hp＝只還原股數變動（價位計算用）、ht＝再還原現金股利（報酬統計用）
  let adj = null, actionsOk = true;
  if (h) {
    const divEv = ok(rd) && ok(rd).events; let actions = [];
    try { actions = ((await src.getSplitMap()).get(code)) || []; } catch (e) { actionsOk = false; }
    adj = Q.adjustPrices(h, divEv, actions);
    if (adj.unexplained.length && src.getCapitalReductions) { // 仍有查無公告的異常跳動 → 再查減資參考價（多數股票不會走到這裡）
      try { const red = await src.getCapitalReductions(code); if (red.length) adj = Q.adjustPrices(h, divEv, actions.concat(red)); } catch (e) { /* 查不到就維持不還原 */ }
    }
  }
  const hp = adj ? adj.price : null, ht = adj ? adj.total : null;
  const intraday = !!quote.realtime;
  const indicators = hp ? snapshot(hp) : null;
  if (indicators && intraday && hp.closes.length > 31) {
    // 盤中的成交量只累計到當下，不能和「完整交易日」的均量相比 → 量能欄位改用前一個完整交易日
    const cut = (x) => x.slice(0, -1), prev = snapshot({ dates: cut(hp.dates), opens: cut(hp.opens), highs: cut(hp.highs), lows: cut(hp.lows), closes: cut(hp.closes), volumes: cut(hp.volumes) });
    if (prev) Object.assign(indicators, { vol: prev.vol, vma5: prev.vma5, vma20: prev.vma20, volRatio: prev.volRatio, upVolAvg: prev.upVolAvg, dnVolAvg: prev.dnVolAvg, volPartial: true, volAsOf: hp.dates[hp.dates.length - 2], volDayDown: prev.close < prev.prevClose });
  }
  const chip = ok(rc) && ok(rc).length ? ok(rc) : null, margin = ok(rm) && ok(rm).length ? ok(rm) : null, revenue = ok(rr), per = ok(rp);
  const fin = ok(rf), bal = ok(rb), dividends = ok(rd), holding = ok(rho), news = ok(rn) || [], index = ok(ri) && ok(ri).closes && ok(ri).closes.length > 60 ? ok(ri) : null;
  const fundamentals = {
    pe: (row && row.pe) || (per && per.pe) || null, pb: (row && row.pb) || (per && per.pb) || null, yield: (row && row.yield) || (per && per.yield) || null,
    revYoY: revenue && revenue.yoy !== null ? revenue.yoy : (row ? row.revYoY : null), revMoM: revenue && revenue.mom !== null ? revenue.mom : (row ? row.revMoM : null),
  };
  if (quote.isETF) { fundamentals.pe = fundamentals.pb = fundamentals.revYoY = fundamentals.revMoM = null; }
  // 官方本益比／淨值比／殖利率是以「快照當日收盤價」計算；報價較新時依價格等比例換算（EPS、淨值、股利不變，換算是精確的）
  if (row && row.pe && row.price > 0 && quote.price > 0 && Math.abs(quote.price / row.price - 1) > 1e-9 && (row.pe || row.pb)) {
    const k = quote.price / row.price;
    if (fundamentals.pe === row.pe) fundamentals.pe = round(row.pe * k); if (fundamentals.pb === row.pb) fundamentals.pb = round(row.pb * k); if (fundamentals.yield === row.yield && row.yield) fundamentals.yield = round(row.yield / k);
    fundamentals.valuationBase = { date: row.date, price: row.price, pe: row.pe, pb: row.pb, yield: row.yield };
  }
  // 財報衍生：近四季 EPS、單季 EPS 年增、實際 ROE、毛利率變化、負債比
  if (fin && fin.length) {
    const L = fin[fin.length - 1], Y = fin.length >= 5 ? fin[fin.length - 5] : null, last4 = fin.slice(-4), prev4 = fin.length >= 8 ? fin.slice(-8, -4) : null, sum = (a, k) => a.every((x) => x[k] !== null) ? a.reduce((t, x) => t + x[k], 0) : null;
    // 成長率無法計算時，說明是「不適用」（負基期／本期虧損）還是「資料不足」，不讓兩者都顯示成缺資料
    const why = (cur, base, enough) => (!enough ? "財報期數不足" : cur === null || cur === undefined ? "資料不足" : base === null || base === undefined ? "資料不足" : base <= 0 ? "比較基期 EPS ≤ 0，成長率不適用" : null);
    Object.assign(fundamentals, { epsYoYNote: why(L.eps, Y ? Y.eps : null, !!Y), epsTTMYoYNote: why(last4.length === 4 ? sum(last4, "eps") : null, prev4 ? sum(prev4, "eps") : null, !!prev4) });
    Object.assign(fundamentals, { quarter: L.label, epsQ: L.eps, epsYoY: Y && Y.eps > 0 && L.eps !== null ? round((L.eps / Y.eps - 1) * 100, 1) : null, epsTTM: last4.length === 4 ? round(sum(last4, "eps"), 2) : null,
      epsTTMYoY: prev4 && sum(prev4, "eps") > 0 && sum(last4, "eps") !== null ? round((sum(last4, "eps") / sum(prev4, "eps") - 1) * 100, 1) : null,
      gm: L.gm, gmYoY: Y && Y.gm !== null && L.gm !== null ? round(L.gm - Y.gm, 1) : null, om: L.om, nm: L.nm,
      roe: bal && bal.equity > 0 && last4.length === 4 && sum(last4, "netInc") !== null ? round(sum(last4, "netInc") / bal.equity * 100, 1) : null });
  }
  if (bal) Object.assign(fundamentals, { debtRatio: bal.assets > 0 && bal.liabilities !== null ? round(bal.liabilities / bal.assets * 100, 1) : null, currentRatio: bal.curLiab > 0 && bal.curAssets ? round(bal.curAssets / bal.curLiab * 100, 0) : null });
  if (holding && holding.shares && quote.price) fundamentals.marketCap = holding.shares * quote.price;
  // 橫斷面百分位：估值與營收動能在全市場、同產業中的位置
  if (snapAll && row && !quote.isETF) {
    const all = [...snapAll.stocks.values()].filter((r) => !r.isETF), same = all.filter((r) => r.industry === row.industry), col = (a, k) => a.map((r) => r[k]).filter((x) => x !== null && x > (k === "revYoY" ? -1000 : 0));
    fundamentals.rank = { peMkt: Q.pctRank(col(all, "pe"), fundamentals.pe), peInd: Q.pctRank(col(same, "pe"), fundamentals.pe), pbMkt: Q.pctRank(col(all, "pb"), fundamentals.pb), yieldMkt: Q.pctRank(col(all, "yield"), fundamentals.yield),
      revMkt: Q.pctRank(col(all, "revYoY"), fundamentals.revYoY), revInd: Q.pctRank(col(same, "revYoY"), fundamentals.revYoY), indCount: same.length, mktCount: all.length };
  }
  if (per && per.hist && fundamentals.pe) fundamentals.own = { pePct: Q.pctRank(per.hist.pe, fundamentals.pe), pbPct: Q.pctRank(per.hist.pb, fundamentals.pb), yieldPct: Q.pctRank(per.hist.yield, fundamentals.yield), peMed: round(Q.median(per.hist.pe), 1), peLo: round(Q.quantile(per.hist.pe, 0.1), 1), peHi: round(Q.quantile(per.hist.pe, 0.9), 1), from: per.hist.from };
  let sector = null;
  if (snapAll && row && !row.isETF) { const st = sectorStats([...snapAll.stocks.values()].filter((r) => r.price > 0)).get(row.industry); if (st) sector = { sector: st.sector, rank: st.rank, heat: st.heat, upRatio: st.upRatio, avgChangePct: st.avgChangePct, count: st.count }; }

  const scored = scoreStock({ snap: Object.assign({}, row || {}, { isETF: quote.isETF }), ind: indicators, chip, margin, fund: fundamentals, sector, holding });
  // 量化模組
  const rs2 = hp ? Q.relStrength(hp, index, ht, adj ? adj.unexplained : []) : null;
  const quant = hp ? { risk: Q.riskMetrics(ht, index, hp), rs: rs2, trend: Q.trendTemplate(hp, rs2), turtle: Q.turtle(hp), events: Q.eventStudy(ht), factors: Q.factors(ht) } : null;
  let market = null; // 大盤狀態（順勢交易的前提）
  if (index) { const ic = index.closes, m = (p) => (ic.length >= p ? ic.slice(-p).reduce((a, x) => a + x, 0) / p : null), last = ic[ic.length - 1];
    market = { date: index.dates[index.dates.length - 1], close: round(last), ma50: round(m(50)), ma200: round(m(200)), above50: m(50) !== null && last > m(50), above200: m(200) !== null && last > m(200), ret20: round((last / ic[ic.length - 21] - 1) * 100), ret60: round((last / ic[ic.length - 61] - 1) * 100) }; }
  const missing = [];
  if (quota) missing.push("FinMind 額度已用盡（約 10 分鐘後恢復，或設定 FINMIND_TOKEN）");
  if (!etfCode) { if (!fin) missing.push("季財報"); if (!bal) missing.push("資產負債表"); if (!per) missing.push("歷史估值"); }
  if (!holding) missing.push("外資持股"); if (!index) missing.push("大盤指數");
  if (!indicators) missing.push("歷史K線"); if (!chip) missing.push(row && row.inst ? "三大法人歷史（僅有當日）" : "三大法人"); if (!margin && !quote.isETF) missing.push("融資融券"); if (!revenue && !quote.isETF && fundamentals.revYoY === null) missing.push("月營收");
  const out = { code, quote, indicators, chip, margin, fundamentals, revenue, sector, scored, missing, instToday: row ? row.inst : null, marginToday: row ? row.margin : null, intraday,
    adjust: adj ? { splits: adj.splits, unexplained: adj.unexplained, dividendsApplied: adj.dividendsApplied, dividendsAvailable: !!(ok(rd) && ok(rd).events), actionsAvailable: actionsOk } : null,
    asOf: { quote: quote.time || quote.date || null, snapshot: row ? row.date : null, kline: h ? h.dates[h.dates.length - 1] : null, chip: chip ? chip[chip.length - 1].date : null, margin: margin ? margin[margin.length - 1].date : null,
      revenue: revenue ? revenue.ym : null, financials: fin && fin.length ? fin[fin.length - 1].label : null, holding: holding ? holding.date : null, index: index ? index.dates[index.dates.length - 1] : null },
    financials: fin, balance: bal, dividends, holding, news, quant, market, coverage: { got: [snapAll, hist, chip, margin, etfCode || revenue, etfCode || per, etfCode || fin, etfCode || bal, dividends, holding, index].filter(Boolean).length, total: 11 }, _v: VERSION, demo: !!src.demo,
    history: hp ? hp.dates.slice(-60).map((d, k) => { const j = hp.dates.length - Math.min(60, hp.dates.length) + k; return { date: d, open: hp.opens[j], high: hp.highs[j], low: hp.lows[j], close: hp.closes[j], volume: hp.volumes[j] }; }) : [] };
  const rep = buildReport(out);
  out.text = rep.text; out.stance = rep.stance; out.tags = rep.tags; out.horizons = rep.horizons; out.stanceDetail = rep.stanceDetail;
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
