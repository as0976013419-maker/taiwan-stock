"use strict";
// 量化分析模組：風險指標、相對強弱、趨勢模板、階段分析、海龜通道、歷史訊號統計、部位試算
// 全部是純函數；輸入為日 K 陣列（舊→新）。任何資料不足的項目回傳 null，由報告層顯示「—」。
const { sma, rsi, kd } = require("./indicators");
const { round } = require("./util");

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const std = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
/** v 在 arr 中的百分位（0~100，越高代表 v 越大） */
const pctRank = (arr, v) => { const a = arr.filter((x) => x !== null && isFinite(x)); if (!a.length || v === null || v === undefined || !isFinite(v)) return null; return round(a.filter((x) => x <= v).length / a.length * 100, 0); };
const dailyRets = (c) => { const r = []; for (let i = 1; i < c.length; i++) r.push(c[i - 1] > 0 ? c[i] / c[i - 1] - 1 : 0); return r; };

/** Wilder ATR，回傳最新值 */
function atr(h, l, c, p = 14) {
  if (c.length <= p) return null; const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let a = mean(tr.slice(0, p)); for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p; return a;
}

function riskMetrics(hist, idx) {
  const { closes: c, highs: h, lows: l, opens: o, volumes: v, dates: d } = hist, n = c.length; if (n < 60) return null;
  const win = Math.min(250, n - 1), r = dailyRets(c).slice(-win), ann = Math.sqrt(252);
  const volOf = (k) => (r.length >= k ? std(r.slice(-k)) * ann * 100 : null);
  // 最大回撤（近一年，收盤價）
  let peak = -Infinity, mdd = 0; for (let i = n - win - 1; i < n; i++) { if (c[i] > peak) peak = c[i]; mdd = Math.min(mdd, c[i] / peak - 1); }
  const hi = Math.max(...c.slice(-win - 1)), a14 = atr(h, l, c, 14), a20 = atr(h, l, c, 20);
  const var95 = quantile(r, 0.05), tail = r.filter((x) => x <= var95), neg = r.filter((x) => x < 0);
  const m = mean(r), s = std(r), dd = neg.length > 1 ? Math.sqrt(neg.reduce((t, x) => t + x * x, 0) / r.length) : null;
  let beta = null, corr = null;
  if (idx && idx.closes && idx.closes.length > 60) { // 與大盤逐日對齊
    const im = new Map(idx.dates.map((x, i) => [x, i])), xs = [], ys = [];
    for (let i = n - win; i < n; i++) { const j = im.get(d[i]), j0 = im.get(d[i - 1]); if (j === undefined || j0 === undefined) continue; xs.push(idx.closes[j] / idx.closes[j0] - 1); ys.push(c[i] / c[i - 1] - 1); }
    if (xs.length > 40) { const mx = mean(xs), my = mean(ys); let cov = 0, vx = 0, vy = 0; for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; } beta = vx > 0 ? cov / vx : null; corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null; }
  }
  const gaps = []; for (let i = n - win; i < n; i++) gaps.push(o[i] / c[i - 1] - 1);
  const val20 = mean(c.slice(-20).map((x, i) => x * v[n - 20 + i]));
  return {
    days: win, atr14: round(a14), atr20: round(a20), atrPct: a14 ? round(a14 / c[n - 1] * 100) : null,
    vol20: round(volOf(20), 1), vol60: round(volOf(60), 1), vol250: round(volOf(Math.min(250, r.length)), 1),
    maxDD: round(mdd * 100, 1), curDD: round((c[n - 1] / hi - 1) * 100, 1),
    var95: round(var95 * 100), cvar95: round(mean(tail) * 100), worstDay: round(Math.min(...r) * 100), bestDay: round(Math.max(...r) * 100),
    sharpe: s ? round(m / s * ann) : null, sortino: dd ? round(m / dd * ann) : null,
    beta: round(beta), corr: round(corr), worstGap: round(Math.min(...gaps) * 100), avgValue20: val20,
    upDayRatio: round(r.filter((x) => x > 0).length / r.length * 100, 0),
  };
}

/** 多週期報酬與相對大盤的超額報酬 */
function relStrength(hist, idx) {
  const { closes: c, dates: d } = hist, n = c.length, id = idx && idx.dates ? idx.dates : null;
  // 指數資料可能比個股晚一天更新（盤中／剛收盤）：取「不晚於該日」的最近一根指數
  const at = (date) => { if (!id) return -1; let lo = 0, hi = id.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (id[m] <= date) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
  return [["1 週", 5], ["1 個月", 20], ["3 個月", 60], ["6 個月", 120], ["1 年", 250], ["3 年", 750]].map(([label, k]) => {
    if (n <= k) return { label, k, ret: null, idx: null, excess: null };
    const ret = (c[n - 1] / c[n - 1 - k] - 1) * 100; let ir = null;
    const x = at(d[n - 1]), y = at(d[n - 1 - k]); if (x > 0 && y >= 0 && x > y) ir = (idx.closes[x] / idx.closes[y] - 1) * 100;
    return { label, k, ret: round(ret), idx: round(ir), excess: ir === null ? null : round(ret - ir) };
  });
}

/** 趨勢模板（強勢股第二階段的八項條件；均線採 50/150/200 日） */
function trendTemplate(hist, rs) {
  const { closes: c, highs: h, lows: l } = hist, n = c.length; if (n < 220) return null;
  const m50 = sma(c, 50), m150 = sma(c, 150), m200 = sma(c, 200), i = n - 1, w = Math.min(250, n);
  const hi52 = Math.max(...h.slice(-w)), lo52 = Math.min(...l.slice(-w)), p = c[i];
  const ex = (k) => { const x = (rs || []).find((r) => r.k === k); return x ? x.excess : null; };
  const e6 = ex(120), e12 = ex(250);
  const checks = [
    ["股價高於 150 日與 200 日均線", p > m150[i] && p > m200[i], `${round(p)} vs ${round(m150[i])} / ${round(m200[i])}`],
    ["150 日均線高於 200 日均線", m150[i] > m200[i], `${round(m150[i])} vs ${round(m200[i])}`],
    ["200 日均線至少上升一個月", m200[i] > m200[i - 20], `${round(m200[i - 20])} → ${round(m200[i])}`],
    ["50 日 > 150 日 > 200 日均線", m50[i] > m150[i] && m150[i] > m200[i], `${round(m50[i])} / ${round(m150[i])} / ${round(m200[i])}`],
    ["股價高於 50 日均線", p > m50[i], `${round(p)} vs ${round(m50[i])}`],
    ["股價高於 52 週低點至少 30%", p >= lo52 * 1.3, `高於低點 ${round((p / lo52 - 1) * 100, 1)}%`],
    ["股價距 52 週高點 25% 以內", p >= hi52 * 0.75, `距高點 ${round((p / hi52 - 1) * 100, 1)}%`],
    ["相對強度優於大盤（6 個月與 1 年超額報酬為正）", e6 !== null && e12 !== null ? e6 > 0 && e12 > 0 : null, e6 === null ? "無大盤資料" : `6 個月 ${e6 > 0 ? "+" : ""}${e6}%、1 年 ${e12 === null ? "—" : (e12 > 0 ? "+" : "") + e12 + "%"}`],
  ].map(([name, pass, detail]) => ({ name, pass, detail }));
  // 階段分析（以 150 日均線≈30 週線的方向與股價位置判定）
  const slope = (m150[i] / m150[i - 20] - 1) * 100, prior = n > 271 ? (c[i - 20] / c[i - 140] - 1) * 100 : 0;
  const stage = p > m150[i] && slope > 1 ? 2 : p < m150[i] && slope < -1 ? 4 : prior < 0 ? 1 : 3;
  return { checks, passed: checks.filter((x) => x.pass === true).length, total: checks.filter((x) => x.pass !== null).length, m50: round(m50[i]), m150: round(m150[i]), m200: round(m200[i]), hi52: round(hi52), lo52: round(lo52), slope150: round(slope), stage,
    stageName: ["", "第一階段：打底", "第二階段：上升", "第三階段：做頭", "第四階段：下降"][stage] };
}

/** 海龜通道：20／55 日突破、10／20 日出場、N＝ATR(20) */
function turtle(hist) {
  const { closes: c, highs: h, lows: l } = hist, n = c.length; if (n < 60) return null;
  const mx = (a, k) => Math.max(...a.slice(n - 1 - k, n - 1)), mn = (a, k) => Math.min(...a.slice(n - 1 - k, n - 1)), N = atr(h, l, c, 20), p = c[n - 1];
  const hi20 = mx(h, 20), hi55 = mx(h, 55), lo10 = mn(l, 10), lo20 = mn(l, 20);
  return { N: round(N), hi20, hi55, lo10, lo20, sys1: p > hi20, sys2: p > hi55, exit1: p < lo10, exit2: p < lo20, stop2N: round(p - 2 * N), distHi20: round((hi20 / p - 1) * 100), distHi55: round((hi55 / p - 1) * 100) };
}

/** 歷史訊號統計：這檔股票過去出現同樣訊號後 5/10/20 日的實際報酬分布（事件研究） */
function eventStudy(hist) {
  const { closes: c, highs: h, lows: l, volumes: v } = hist, n = c.length; if (n < 250) return null;
  const m5 = sma(c, 5), m20 = sma(c, 20), m60 = sma(c, 60), vm = sma(v, 20), R = rsi(c, 14), KD = kd(h, l, c, 9);
  const hiPrev = (i, k) => { let m = -Infinity; for (let j = i - k; j < i; j++) if (h[j] > m) m = h[j]; return m; };
  const EV = [
    ["up20", "收盤由下往上站回 20 日均線", (i) => c[i - 1] <= m20[i - 1] && c[i] > m20[i]],
    ["dn20", "收盤由上往下跌破 20 日均線", (i) => c[i - 1] >= m20[i - 1] && c[i] < m20[i]],
    ["x520", "5 日均線上穿 20 日均線", (i) => m5[i - 1] <= m20[i - 1] && m5[i] > m20[i]],
    ["brk20", "收盤創 20 日新高", (i) => c[i] > hiPrev(i, 20) && c[i - 1] <= hiPrev(i - 1, 20)],
    ["brk60", "收盤創 60 日新高", (i) => c[i] > hiPrev(i, 60) && c[i - 1] <= hiPrev(i - 1, 60)],
    ["volup", "成交量達均量 2 倍且收紅", (i) => vm[i] && v[i] >= 2 * vm[i] && c[i] > c[i - 1]],
    ["voldn", "成交量達均量 2 倍且收黑", (i) => vm[i] && v[i] >= 2 * vm[i] && c[i] < c[i - 1]],
    ["rsi30", "RSI(14) 跌破 30", (i) => R[i - 1] !== null && R[i - 1] >= 30 && R[i] < 30],
    ["rsi70", "RSI(14) 升破 70", (i) => R[i - 1] !== null && R[i - 1] <= 70 && R[i] > 70],
    ["kdlow", "KD 在 30 以下 K 上穿 D", (i) => KD.K[i - 1] !== null && KD.K[i - 1] <= KD.D[i - 1] && KD.K[i] > KD.D[i] && KD.K[i] < 30],
    ["dev60", "股價低於 60 日均線 10% 以上", (i) => m60[i] && c[i] < m60[i] * 0.9 && !(c[i - 1] < m60[i - 1] * 0.9)],
  ];
  const H = [5, 10, 20], start = 65;
  const stat = (idxs, k) => { const rs = idxs.filter((i) => i + k < n).map((i) => (c[i + k] / c[i] - 1) * 100); return rs.length ? { n: rs.length, win: round(rs.filter((x) => x > 0).length / rs.length * 100, 0), mean: round(mean(rs)), median: round(median(rs)) } : { n: 0 }; };
  const all = []; for (let i = start; i < n; i++) all.push(i);
  const events = EV.map(([key, name, fn]) => {
    const idxs = []; for (let i = start; i < n; i++) { try { if (fn(i)) idxs.push(i); } catch (e) { /* 指標尚未就緒 */ } }
    const last = idxs.length ? idxs[idxs.length - 1] : -1;
    return { key, name, count: idxs.length, active: last >= n - 3, lastDate: last >= 0 ? hist.dates[last] : null, h: H.map((k) => stat(idxs, k)) };
  });
  return { bars: n, years: round(n / 250, 1), horizons: H, baseline: H.map((k) => stat(all, k)), events };
}

/** 動能／波動因子（個股自身的時間序列值） */
function factors(hist) {
  const c = hist.closes, n = c.length, r = (a, b) => (n > b && c[n - 1 - b] > 0 ? round((c[n - 1 - a] / c[n - 1 - b] - 1) * 100) : null);
  return { mom12_1: r(20, 250), mom6: r(0, 120), mom3: r(0, 60), rev1m: r(0, 20) };
}

/** 部位規模試算：固定比例風險法（每筆交易最多虧損本金的 riskPct%） */
function sizing(price, atr14, stops, capital = 1000000, riskPct = 1) {
  if (!price || !atr14) return null; const risk = capital * riskPct / 100;
  return [["2 倍 ATR", price - 2 * atr14], ["3 倍 ATR", price - 3 * atr14]].concat(stops || []).filter((s) => s[1] > 0 && s[1] < price).map(([name, stop]) => {
    const dist = price - stop, shares = Math.floor(risk / dist), value = shares * price;
    return { name, stop: round(stop), distPct: round(dist / price * 100), shares, lots: round(shares / 1000, 2), value: Math.round(value), weight: round(value / capital * 100, 1) };
  });
}
module.exports = { mean, std, median, quantile, pctRank, atr, riskMetrics, relStrength, trendTemplate, turtle, eventStudy, factors, sizing };
