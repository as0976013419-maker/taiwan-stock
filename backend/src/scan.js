"use strict";
// /scan：volume / change / drop / momentum / sector / limitup / disposition
// 兩段式：先用全市場快照（7 個批次 API）粗篩排序，再只對前 N 名抓歷史 K 線做精算。
// 這樣 1700 檔的全市場掃描只需要 N 次（≤30）個股請求，而不是 1700 次。
const { cached, mapLimit, pctStr, clamp, round, daysAgo } = require("./util");
const { snapshot } = require("./indicators");
const S = require("./scoring");

/** 族群統計：Map<industry,{sector,count,avgChangePct,upRatio,heat,rank,limitUps}> */
function sectorStats(rows) {
  const g = new Map();
  for (const r of rows) { if (r.isETF) continue; const a = g.get(r.industry) || []; a.push(r); g.set(r.industry, a); }
  const out = [];
  for (const [sector, a] of g) {
    if (a.length < 3) continue;
    const avg = a.reduce((s, r) => s + r.changePct, 0) / a.length, up = a.filter((r) => r.changePct > 0).length / a.length;
    const lus = a.filter((r) => r.prevClose && r.price >= S.limitUpPrice(r.prevClose, false)).length;
    const raw = 50 + avg * 6 + (up - 0.5) * 30 + Math.min(lus, 5); // 實測：大漲日舊係數會讓多數族群同時頂到 100，失去鑑別度
    out.push({ sector, count: a.length, avgChangePct: round(avg), upRatio: round(up), limitUps: lus, raw, heat: Math.round(clamp(raw, 0, 100)), members: a });
  }
  out.sort((a, b) => b.raw - a.raw).forEach((s, i) => { s.rank = i + 1; });
  return new Map(out.map((s) => [s.sector, s]));
}
function universeOf(all, universe) {
  const byValue = all.slice().sort((a, b) => b.value - a.value);
  if (universe === "all") return byValue;
  if (universe === "large") return byValue.slice(0, 800);
  return byValue.slice(0, 150); // custom：成交值前 150 的熱門股池
}
async function withHistory(src, rows) {
  const { mergeBar } = require("./analyze"), { adjustPrices } = require("./quant");
  const hs = await mapLimit(rows, 4, (r) => src.getHistory(r.code, daysAgo(200)));
  let splits = new Map(); try { if (src.getSplitMap) splits = await src.getSplitMap(); } catch (e) { /* 清單取不到時維持原始價格 */ }
  return rows.map((r, i) => { if (!(hs[i] && hs[i].closes.length >= 30)) return { r, ind: null };
    const merged = mergeBar(hs[i], r), acts = splits.get(r.code); // 沒有股數變動的股票（絕大多數）直接沿用原始序列
    return { r, ind: snapshot(acts ? adjustPrices(merged, null, acts).price : merged) }; });
}
const base = (r) => ({ code: r.code, name: r.name, price: r.price, changePct: pctStr(r.changePct), volume: r.volume, sector: r.industry });

async function runScan(src, { mode = "volume", limit = 20, universe = "custom", lite = false }) {
  limit = clamp(parseInt(limit, 10) || 20, 5, 30);
  if (!["volume", "change", "drop", "momentum", "sector", "limitup", "disposition"].includes(mode)) throw Object.assign(new Error("不支援的掃描模式：" + mode), { status: 400 });
  if (!["custom", "large", "all"].includes(universe)) universe = "custom";
  if (lite && mode === "volume") { // 首頁熱門股列只需要代號與名稱：不評分、不消耗個股資料額度
    const snap = await src.getMarketSnapshot();
    const top = [...snap.stocks.values()].filter((r) => r.price > 0 && r.volume > 0 && !r.isETF).sort((a, b) => b.volume - a.volume).slice(0, limit);
    const ds = top.map((r) => r.date).filter(Boolean).sort();
    return { mode, lite: true, stocks: top.map(base), cached: false, _v: S.VERSION, demo: !!src.demo, asOf: ds[ds.length - 1] || null };
  }
  const key = `scan:${mode}:${limit}:${universe}`;
  let fresh = false;
  const result = await cached(key, 180000, async () => { fresh = true; return compute(src, mode, limit, universe); });
  const BASIS = {
    volume: "依成交量（張）由大到小；排除 ETF", change: "依漲跌幅由大到小；排除 ETF 與成交量低於 300 張者", drop: "依漲跌幅由小到大；排除 ETF 與成交量低於 300 張者",
    momentum: "先以當日快照粗篩，再以近 200 日 K 線計算動能分數排序；排除 ETF", sector: "族群熱度＝族群平均漲跌、上漲家數比與漲停家數的加權；僅含成交值前 800 檔、5 檔以上的族群",
    limitup: "漲幅大於 3% 且在成交值前 800 檔者，依鎖漲停觀察分數排序", disposition: "證交所公告的處置股與注意股，依處置期間相對強弱排序（不是買進評分）" };
  return Object.assign({}, result, { cached: !fresh, _v: S.VERSION, demo: !!src.demo, basis: BASIS[mode] || "",
    scoreNote: "掃描評分只使用收盤快照與近 200 日 K 線，沒有法人與融資的多日序列，與個股頁的評分資料範圍不同，兩者可能不一致。" });
}

async function compute(src, mode, limit, universe) {
  const r0 = await compute0(src, mode, limit, universe), snap = await src.getMarketSnapshot();
  // 資料日期：快照中最常見的交易日（上市與上櫃可能因更新時間不同而不一致，兩者都列出）
  const cnt = new Map(); for (const r of snap.stocks.values()) if (r.date) cnt.set(r.date, (cnt.get(r.date) || 0) + 1);
  const dates = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  return Object.assign(r0, { asOf: dates[0] || null, asOfOther: dates.slice(1, 3), generatedAt: new Date().toISOString() });
}
async function compute0(src, mode, limit, universe) {
  const snap = await src.getMarketSnapshot();
  const all = [...snap.stocks.values()].filter((r) => r.price > 0 && r.volume > 0);
  const sectors = sectorStats(all);
  const secOf = (r) => sectors.get(r.industry) || null;
  const valueRank = new Map(all.slice().sort((a, b) => a.value - b.value).map((r, i) => [r.code, i / Math.max(1, all.length - 1)]));
  const fundOf = (r) => ({ pe: r.pe, pb: r.pb, yield: r.yield, revYoY: r.revYoY, revMoM: r.revMoM });
  const scored = (r, ind) => S.scoreStock({ snap: r, ind, fund: fundOf(r), sector: secOf(r) });
  const scoreCols = (sc) => ({ score: sc.score, grade: sc.grade, fundScore: sc.detail._fund, techScore: sc.detail._tech, volScore: sc.detail._vol, chipScore: sc.detail._chip, marginScore: sc.detail._margin, themeScore: sc.detail._theme });

  if (mode === "volume" || mode === "change" || mode === "drop") {
    // 漲跌幅排行排除成交量過低者（< 300 張），避免冷門股雜訊
    const pool = all.filter((r) => !r.isETF && (mode === "volume" || r.volume >= 300)); // 評分模型針對個股，ETF（含槓反）不列入
    const sorted = pool.slice().sort(mode === "volume" ? (a, b) => b.volume - a.volume : mode === "change" ? (a, b) => b.changePct - a.changePct : (a, b) => a.changePct - b.changePct);
    const rows = await withHistory(src, sorted.slice(0, limit));
    return { mode, partial: rows.some((x) => !x.ind), stocks: rows.map(({ r, ind }) => { const sc = scored(r, ind); return Object.assign(base(r), scoreCols(sc), { suggestion: (ind ? "" : "（缺K線，技術面未計分）") + S.suggestionOf(sc, ind) }); }) };
  }

  if (mode === "momentum") {
    const pool = universeOf(all, universe).filter((r) => !r.isETF);
    const pre = pool.map((r) => ({ r, m: S.momentumOf(r, null, { valuePct: valueRank.get(r.code), sector: secOf(r) }).momentumScore })).sort((a, b) => b.m - a.m).slice(0, limit + 10);
    const rows = await withHistory(src, pre.map((x) => x.r));
    const out = rows.map(({ r, ind }) => { const m = S.momentumOf(r, ind, { valuePct: valueRank.get(r.code), sector: secOf(r) }), sc = scored(r, ind);
      return Object.assign(base(r), scoreCols(sc), m, { suggestion: m.momentumScore >= 80 ? "動能強，留意是否過熱與隔日量能" : m.momentumScore >= 60 ? "動能偏強，觀察能否續量" : "動能普通" }); });
    return { mode, universe, scanned: pool.length, stocks: out.sort((a, b) => b.momentumScore - a.momentumScore).slice(0, limit) };
  }

  if (mode === "limitup") {
    const pool = universeOf(all, "large").filter((r) => !r.isETF && r.changePct > 3);
    const out = pool.map((r) => {
      const lu = S.limitUpPrice(r.prevClose, false), locked = r.price >= lu, dist = round(Math.max(0, (lu / r.price - 1) * 100));
      const sec = secOf(r), peers = sec ? sec.limitUps : 0, atHigh = r.high && r.price >= r.high;
      const tags = [];
      let sc = (locked ? 55 : Math.max(0, 45 - dist * 8)) + (atHigh ? 10 : 0) + (valueRank.get(r.code) || 0) * 20 + Math.min(peers, 5) * 3;
      tags.push(locked ? { cls: "hot", text: "已鎖漲停" } : dist <= 2 ? { cls: "bull", text: "接近漲停" } : { cls: "neutral", text: "漲幅" + r.changePct.toFixed(1) + "%" });
      if (peers >= 2) tags.push({ cls: "bull", text: "族群連動(" + peers + "檔漲停)" });
      if (!atHigh) tags.push({ cls: "warn", text: "未收最高" });
      if ((valueRank.get(r.code) || 0) < 0.5) tags.push({ cls: "warn", text: "量能偏低" });
      return Object.assign(base(r), { limitUpScore: clamp(Math.round(sc), 0, 100), distanceToLimitUp: dist, limitUpPrice: lu, tags,
        suggestion: locked ? "已鎖住，觀察隔日開盤與委買量" : "尚未鎖住，留意尾盤是否開板", fundScore: 0, techScore: 0, volScore: 0, chipScore: 0, marginScore: 0, themeScore: 0 });
    }).sort((a, b) => b.limitUpScore - a.limitUpScore).slice(0, limit);
    return { mode, scanned: pool.length, stocks: out };
  }

  if (mode === "disposition") {
    const list = await src.getDisposition();
    const out = list.map((dsp) => {
      const r = snap.stocks.get(dsp.code); if (!r) return null;
      const tags = [{ cls: "warn", text: dsp.type === "處置股" ? "分盤交易" : "列入注意" }];
      if (dsp.period) tags.push({ cls: "neutral", text: dsp.period.slice(0, 24) });
      if (r.changePct >= 5) tags.push({ cls: "hot", text: "處置中仍強" }); if (r.changePct <= -5) tags.push({ cls: "bear", text: "賣壓重" });
      // 觀察分數：只反映「處置期間的相對強弱」，不是買進評分
      const sc = clamp(Math.round(50 + r.changePct * 4 + ((valueRank.get(r.code) || 0) - 0.5) * 20 - (dsp.type === "處置股" ? 10 : 0)), 0, 100);
      return Object.assign(base(r), { dispositionScore: sc, dispositionType: dsp.type, tags, suggestion: dsp.reason || "流動性受限，僅供觀察",
        fundScore: 0, techScore: 0, volScore: 0, chipScore: 0, marginScore: 0, themeScore: 0 });
    }).filter(Boolean).sort((a, b) => b.dispositionScore - a.dispositionScore).slice(0, limit);
    return { mode, stocks: out };
  }

  // sector：族群熱度 TOP 10 + 動能前 50
  const pool = universeOf(all, "large").filter((r) => !r.isETF);
  const poolSectors = sectorStats(pool);
  const mom = new Map(pool.map((r) => [r.code, S.momentumOf(r, null, { valuePct: valueRank.get(r.code), sector: poolSectors.get(r.industry) })]));
  const lead = (r) => Object.assign(base(r), mom.get(r.code));
  const top = [...poolSectors.values()].filter((s) => s.count >= 5).slice(0, 10).map((s) => {
    const tags = [];
    if (s.avgChangePct >= 2) tags.push({ cls: "hot", text: "資金湧入" }); else if (s.avgChangePct >= 0.8) tags.push({ cls: "bull", text: "偏強" });
    if (s.upRatio >= 0.7) tags.push({ cls: "bull", text: "普漲" });
    if (s.limitUps >= 2) tags.push({ cls: "hot", text: s.limitUps + "檔漲停" });
    if (s.avgChangePct <= -1) tags.push({ cls: "bear", text: "弱勢" });
    if (s.upRatio < 0.4 && s.avgChangePct > 0) tags.push({ cls: "warn", text: "少數股拉抬" });
    return { sector: s.sector, sectorHeat: s.heat, avgChangePct: s.avgChangePct, upRatio: s.upRatio, count: s.count, tags,
      leaders: s.members.slice().sort((a, b) => mom.get(b.code).momentumScore - mom.get(a.code).momentumScore).slice(0, 5).map(lead) };
  });
  const stocks = pool.slice().sort((a, b) => mom.get(b.code).momentumScore - mom.get(a.code).momentumScore).slice(0, 50).map(lead);
  const upAll = pool.filter((r) => r.changePct > 0).length / Math.max(1, pool.length);
  const aiComment = top.length ? `今日 ${pool.length} 檔中上漲家數佔 ${Math.round(upAll * 100)}%。熱度最高為「${top[0].sector}」（均漲 ${pctStr(top[0].avgChangePct)}、上漲比 ${Math.round(top[0].upRatio * 100)}%）` +
    (top[1] ? `，其次「${top[1].sector}」` : "") + `。熱度為當日單日指標，族群是否延續需看隔日量能與法人動向。` : "";
  return { mode, scanned: pool.length, sectors: top, stocks, aiComment };
}
module.exports = { runScan, sectorStats };
