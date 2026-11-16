"use strict";
// 綜合評分（100 分）＝ 基本面 20 + 技術面 25 + 量價 15 + 籌碼 20 + 融資 10 + 題材 10
// 每個細項回傳 "+N"（得分）、"0"（未得分）或 "—"（無資料）。
// 無資料的細項不給分也不扣分——所以資料缺漏時總分會偏低，這是刻意的保守設計。
const { clamp, round } = require("./util");

const VERSION = "score-v5.1";
const tickOf = (p, etf) => etf ? (p < 50 ? 0.01 : 0.05) : (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
/** 漲停價：前收 ×1.10，向下取到升降單位 */
function limitUpPrice(prev, etf) { const raw = prev * 1.1, t = tickOf(raw, etf); return round(Math.floor(raw / t + 1e-9) * t, 2); }

function gradeOf(score) {
  if (score >= 80) return { grade: "強勢觀察", gradeColor: "#ef4444" };
  if (score >= 65) return { grade: "可試單", gradeColor: "#f59e0b" };
  if (score >= 50) return { grade: "等待整理", gradeColor: "#6b7280" };
  return { grade: "不建議", gradeColor: "#374151" };
}
/** 連續買超天數（由最新一天往回數） */
function streak(series, key) { let n = 0; for (let i = series.length - 1; i >= 0; i--) { if (series[i][key] > 0) n++; else break; } return n; }

/**
 * @param {object} x
 *   snap   全市場快照列（可為 null）
 *   ind    indicators.snapshot() 結果（可為 null → 技術面/量價無資料）
 *   chip   個股法人序列 [{foreign,trust,dealer,total}]（可為 null → 退回用快照當日值）
 *   margin 個股融資序列 [{bal,limit}]（可為 null → 退回快照）
 *   fund   {pe,pb,yield,revYoY,revMoM}
 *   sector {rank, upRatio, heat} 該股所屬族群當日統計（可為 null）
 */
function scoreStock(x) {
  const d = {}, pts = (k, n) => { d[k] = n > 0 ? "+" + n : "0"; return n; }, na = (k) => { d[k] = "—"; return 0; };
  const snap = x.snap || {}, ind = x.ind, f = x.fund || {}, etf = !!snap.isETF;
  let fund = 0, tech = 0, vol = 0, chip = 0, margin = 0, theme = 0;

  // ── 基本面 20 ──
  const yoy = f.revYoY, pe = f.pe, pb = f.pb;
  fund += (yoy === null || yoy === undefined) ? na("rev_yoy") : pts("rev_yoy", yoy >= 20 ? 8 : yoy >= 10 ? 6 : yoy >= 0 ? 3 : 0);
  // EPS：有季財報時看單季 EPS 年增率，否則退回用本益比高低
  if (f.epsYoY !== null && f.epsYoY !== undefined) fund += pts("eps_growth", f.epsYoY >= 25 ? 5 : f.epsYoY >= 10 ? 3 : f.epsYoY >= 0 ? 1 : 0);
  else fund += !(pe > 0) ? na("eps_growth") : pts("eps_growth", pe <= 15 ? 5 : pe <= 25 ? 3 : pe <= 40 ? 1 : 0);
  // ROE：有財報時用「近四季稅後淨利 ÷ 最新股東權益」，否則以 PB ÷ PE 估算
  const roe = (f.roe !== null && f.roe !== undefined) ? f.roe : (pe > 0 && pb > 0) ? pb / pe * 100 : null;
  fund += roe === null ? na("roe") : pts("roe", roe >= 15 ? 4 : roe >= 8 ? 2 : 0);
  // 毛利率「代理」：沒有逐季財報時，以營收 YoY 與 MoM 同時不衰退當作獲利結構穩定的替代訊號
  const mom = f.revMoM;
  if (f.gmYoY !== null && f.gmYoY !== undefined) fund += pts("margin_stable", f.gmYoY >= 0 ? 3 : f.gmYoY >= -2 ? 1 : 0); // 實際毛利率與去年同季相比
  else fund += (yoy === null || yoy === undefined || mom === null || mom === undefined) ? na("margin_stable") : pts("margin_stable", (yoy >= 0 && mom >= 0) ? 3 : (yoy >= 0 || mom >= 0) ? 1 : 0);

  // ── 技術面 25 ／ 量價 15 ──
  if (ind && ind.ma20 !== null) {
    tech += pts("above_ma20", ind.close > ind.ma20 ? 5 : 0);
    tech += ind.ma20Prev === null ? na("ma20_up") : pts("ma20_up", ind.ma20 > ind.ma20Prev ? 5 : 0);
    tech += (ind.ma60 === null || ind.ma60Prev === null) ? na("ma60_up") : pts("ma60_up", ind.ma60 > ind.ma60Prev ? 5 : 0);
    tech += ind.ma60 === null ? na("ma_bull") : pts("ma_bull", ind.maBull ? 5 : 0);
    tech += pts("breakout", ind.close >= ind.hi20prev ? 5 : 0);
    vol += (ind.upVolAvg === null || ind.dnVolAvg === null) ? na("up_vol") : pts("up_vol", ind.upVolAvg > ind.dnVolAvg ? 5 : 0);
    // 回檔量縮：今日收黑且量低於 20 日均量；今日收紅則看近 10 日下跌日均量是否低於均量
    const dayDown = ind.volPartial ? ind.volDayDown : ind.close < ind.prevClose; // 盤中時量能取自前一完整交易日，漲跌方向也要用同一天
    const pullbackQuiet = dayDown ? ind.vol < ind.vma20 : (ind.dnVolAvg !== null && ind.dnVolAvg < ind.vma20);
    vol += ind.vma20 === null ? na("down_vol") : pts("down_vol", pullbackQuiet ? 5 : 0);
    vol += ind.vma20 === null ? na("vol_above_avg") : pts("vol_above_avg", ind.vol > ind.vma20 ? 5 : 0);
  } else { ["above_ma20", "ma20_up", "ma60_up", "ma_bull", "breakout", "up_vol", "down_vol", "vol_above_avg"].forEach(na); }

  // ── 籌碼 20 ──
  if (x.chip && x.chip.length) {
    const s = x.chip, fs = streak(s, "foreign"), ts = streak(s, "trust"), sum5 = s.slice(-5).reduce((a, r) => a + r.total, 0);
    chip += pts("foreign_buy", fs >= 3 ? 6 : fs >= 1 ? 3 : 0);
    chip += pts("site_buy", ts >= 3 ? 6 : ts >= 1 ? 3 : 0);
    chip += pts("inst_total", sum5 > 0 ? 4 : 0);
    // 大戶持股「代理」：近 20 日法人累計買超佔同期成交量比重（集保大戶級距資料需付費，故以此替代）
    const sum20 = s.slice(-20).reduce((a, r) => a + r.total, 0), v20 = ind && ind.vma20 ? ind.vma20 / 1000 * Math.min(20, s.length) : null;
    const ratio = v20 ? sum20 / v20 * 100 : null;
    // 有外資持股資料時，改看外資持股比例近 20 日的變化
    if (x.holding && isFinite(x.holding.ratio) && isFinite(x.holding.ratio20)) { const dlt = x.holding.ratio - x.holding.ratio20; chip += pts("big_player", dlt >= 0.3 ? 4 : dlt > 0 ? 2 : 0); }
    else chip += ratio === null ? na("big_player") : pts("big_player", ratio >= 3 ? 4 : ratio >= 1 ? 2 : 0);
  } else if (snap.inst) { // 掃描模式：只有當日法人
    const n = snap.inst, ratio = snap.volume > 0 ? n.total / snap.volume * 100 : null;
    chip += pts("foreign_buy", n.foreign > 0 ? 3 : 0); chip += pts("site_buy", n.trust > 0 ? 3 : 0); chip += pts("inst_total", n.total > 0 ? 4 : 0);
    chip += ratio === null ? na("big_player") : pts("big_player", ratio >= 5 ? 4 : ratio >= 2 ? 2 : 0);
  } else { ["foreign_buy", "site_buy", "inst_total", "big_player"].forEach(na); }

  // ── 融資 10 ──（ETF 與無信用交易資格者無資料）
  let mBal = null, mPrev = null, mLimit = null;
  if (x.margin && x.margin.length >= 2) { const s = x.margin; mBal = s[s.length - 1].bal; mPrev = s[Math.max(0, s.length - 6)].bal; mLimit = s[s.length - 1].limit; }
  else if (snap.margin) { mBal = snap.margin.bal; mPrev = snap.margin.prev; mLimit = snap.margin.limit; }
  if (mBal !== null && mBal !== undefined) {
    const use = mLimit > 0 ? mBal / mLimit * 100 : null;
    margin += use === null ? na("margin_health") : pts("margin_health", use < 15 ? 5 : use < 30 ? 3 : 0);
    const priceUp = ind ? (ind.ret5 !== null ? ind.ret5 >= 0 : true) : (snap.changePct >= 0);
    margin += (mPrev === null || mPrev === undefined) ? na("margin_decrease") : pts("margin_decrease", mBal < mPrev ? (priceUp ? 5 : 3) : 0);
  } else { na("margin_health"); na("margin_decrease"); }

  // ── 題材 10 ──（以當日族群強度為代理）
  if (x.sector) {
    theme += pts("theme_main", x.sector.rank <= 3 ? 6 : x.sector.rank <= 8 ? 3 : 0);
    theme += pts("theme_support", x.sector.upRatio >= 0.6 ? 4 : x.sector.upRatio >= 0.5 ? 2 : 0);
  } else { na("theme_main"); na("theme_support"); }

  const score = clamp(Math.round(fund + tech + vol + chip + margin + theme), 0, 100);
  Object.assign(d, { _fund: fund, _tech: tech, _vol: vol, _chip: chip, _margin: margin, _theme: theme });
  return Object.assign({ score, detail: d, roe: round(roe, 1), etf }, gradeOf(score));
}

/** 掃描表格用的一句話（描述現況與觀察條件，不是買賣指令） */
function suggestionOf(sc, ind) {
  const d = sc.detail, bits = [];
  if (d.ma_bull === "+5") bits.push("均線多頭排列"); else if (d.above_ma20 === "0") bits.push("股價在月線下");
  if (d.breakout === "+5") bits.push("突破20日高");
  if (d.vol_above_avg === "+5") bits.push("量增");
  if (d.foreign_buy === "+6") bits.push("外資連買"); if (d.site_buy === "+6") bits.push("投信連買");
  if (ind && ind.rsi !== null && ind.rsi > 80) bits.push("RSI偏高留意追高風險");
  const head = sc.score >= 80 ? "多項條件同時成立" : sc.score >= 65 ? "條件偏正向，留意量能是否延續" : sc.score >= 50 ? "訊號分歧，等待方向" : "條件不足";
  return head + (bits.length ? "：" + bits.slice(0, 3).join("、") : "");
}

/** 動能分數 0~100 與標籤。有歷史資料(ind)時較準；沒有時用當日快照估計並依可得項目正規化。 */
function momentumOf(snap, ind, ctx = {}) {
  const tags = []; let got = 0, max = 0;
  const add = (v, m) => { got += clamp(v, 0, m); max += m; };
  const chg = snap.changePct || 0;
  add(chg * 3.5, 30);
  const range = (snap.high || 0) - (snap.low || 0), pos = range > 0 ? (snap.price - snap.low) / range : 0.5;
  add(pos * 15, 15);
  if (ind && ind.volRatio !== null) add((ind.volRatio - 1) * 10, 20); else if (ctx.valuePct !== undefined) add(ctx.valuePct * 20, 20);
  if (ind && ind.ma20 !== null) { add((ind.close > ind.ma20 ? 8 : 0) + (ind.maBull ? 7 : 0), 15); add((ind.ret20 || 0) * 0.5, 10); }
  if (ctx.sector) add(ctx.sector.heat / 10, 10);
  const score = max ? Math.round(got / max * 100) : 0;
  const lu = snap.prevClose ? limitUpPrice(snap.prevClose, snap.isETF) : null;
  if (lu && snap.price >= lu) tags.push({ cls: "hot", text: "漲停" }); else if (chg >= 5) tags.push({ cls: "hot", text: "強勢" });
  if (ind && ind.volRatio !== null && ind.volRatio >= 2) tags.push({ cls: "hot", text: "爆量" + ind.volRatio.toFixed(1) + "x" });
  if (ind && ind.maBull) tags.push({ cls: "bull", text: "多頭排列" });
  if (range > 0 && pos >= 0.95 && chg > 0) tags.push({ cls: "bull", text: "收最高" });
  if (ind && ind.close >= ind.hi20prev) tags.push({ cls: "bull", text: "創20日高" });
  if (ind && ind.rsi !== null && ind.rsi >= 80) tags.push({ cls: "warn", text: "RSI過熱" });
  if (range > 0 && pos <= 0.4 && chg > 2) tags.push({ cls: "warn", text: "上影線長" });
  if (chg < -3) tags.push({ cls: "bear", text: "弱勢" });
  return { momentumScore: score, momentumTags: tags };
}

module.exports = { VERSION, scoreStock, suggestionOf, momentumOf, gradeOf, limitUpPrice };
