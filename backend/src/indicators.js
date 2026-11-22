"use strict";
// 技術指標（回傳與輸入等長的陣列，資料不足處為 null）

function sma(a, p) {
  const out = new Array(a.length).fill(null); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) out[i] = s / p; }
  return out;
}
function ema(a, p) {
  const out = new Array(a.length).fill(null); if (a.length < p) return out;
  const k = 2 / (p + 1); let s = 0;
  for (let i = 0; i < p; i++) s += a[i];
  out[p - 1] = s / p;
  for (let i = p; i < a.length; i++) out[i] = a[i] * k + out[i - 1] * (1 - k);
  return out;
}
/** Wilder RSI */
function rsi(c, p = 14) {
  const out = new Array(c.length).fill(null); if (c.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
/** 台股慣用 KD(9,3,3) */
function kd(h, l, c, p = 9) {
  const K = new Array(c.length).fill(null), D = new Array(c.length).fill(null); let k = 50, d = 50;
  for (let i = p - 1; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; }
    const rsv = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
    k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3; K[i] = k; D[i] = d;
  }
  return { K, D };
}
function macd(c, f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s);
  const dif = c.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
  const start = dif.findIndex((v) => v !== null);
  const dea = new Array(c.length).fill(null);
  if (start >= 0) { const e = ema(dif.slice(start), sig); for (let i = 0; i < e.length; i++) dea[start + i] = e[i]; }
  const hist = dif.map((v, i) => (v !== null && dea[i] !== null) ? v - dea[i] : null);
  return { dif, dea, hist };
}
function boll(c, p = 20, m = 2) {
  const mid = sma(c, p), up = new Array(c.length).fill(null), lo = new Array(c.length).fill(null);
  for (let i = p - 1; i < c.length; i++) {
    let v = 0; for (let j = i - p + 1; j <= i; j++) v += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / p); up[i] = mid[i] + m * sd; lo[i] = mid[i] - m * sd;
  }
  return { mid, up, lo };
}

/** 由歷史資料算出「最新一根」的指標快照，供評分與報告使用 */
function snapshot(hist) {
  if (!hist || !hist.closes || hist.closes.length < 30) return null;
  const { closes: c, highs: h, lows: l, volumes: v } = hist;
  const n = c.length, i = n - 1, at = (arr, k = 0) => (arr[i - k] === undefined ? null : arr[i - k]);
  const ma5 = sma(c, 5), ma10 = sma(c, 10), ma20 = sma(c, 20), ma60 = sma(c, 60), ma120 = sma(c, 120), ma240 = sma(c, 240);
  const vma5 = sma(v, 5), vma20 = sma(v, 20);
  const R = rsi(c, 14), KD = kd(h, l, c, 9), M = macd(c), B = boll(c, 20, 2);
  const maxOf = (arr, from, to) => { let m = -Infinity; for (let k = Math.max(0, from); k <= to; k++) if (arr[k] > m) m = arr[k]; return m; };
  const minOf = (arr, from, to) => { let m = Infinity; for (let k = Math.max(0, from); k <= to; k++) if (arr[k] < m) m = arr[k]; return m; };
  const ret = (k) => (i - k >= 0 && c[i - k] > 0) ? (c[i] / c[i - k] - 1) * 100 : null;
  const cross = (a, b) => { // 近 3 日內 a 上穿(1)/下穿(-1) b
    for (let k = 0; k < 3; k++) {
      const a1 = at(a, k), b1 = at(b, k), a0 = at(a, k + 1), b0 = at(b, k + 1);
      if ([a1, b1, a0, b0].some((x) => x === null)) continue;
      if (a0 <= b0 && a1 > b1) return 1; if (a0 >= b0 && a1 < b1) return -1;
    }
    return 0;
  };
  // 量價：近 10 日上漲日均量 vs 下跌日均量
  let upV = 0, upN = 0, dnV = 0, dnN = 0;
  for (let k = Math.max(1, n - 10); k < n; k++) { if (c[k] > c[k - 1]) { upV += v[k]; upN++; } else if (c[k] < c[k - 1]) { dnV += v[k]; dnN++; } }
  const hi20prev = maxOf(h, i - 20, i - 1), hi60 = maxOf(h, i - 59, i), lo60 = minOf(l, i - 59, i);
  const hi240 = maxOf(h, i - 239, i), lo240 = minOf(l, i - 239, i);
  const hi250 = maxOf(h, i - 249, i), lo250 = minOf(l, i - 249, i); // 52 週＝250 個交易日，與多週期績效、趨勢模板同一口徑
  return {
    bars: n, close: c[i], prevClose: c[i - 1],
    ma5: at(ma5), ma10: at(ma10), ma20: at(ma20), ma60: at(ma60), ma120: at(ma120), ma240: at(ma240),
    ma20Prev: at(ma20, 5), ma60Prev: at(ma60, 5),
    rsi: at(R), k: at(KD.K), d: at(KD.D), dif: at(M.dif), dea: at(M.dea), macdHist: at(M.hist), macdHistPrev: at(M.hist, 1),
    bollUp: at(B.up), bollMid: at(B.mid), bollLo: at(B.lo),
    vol: v[i], vma5: at(vma5), vma20: at(vma20), volRatio: at(vma20) ? v[i] / at(vma20) : null,
    upVolAvg: upN ? upV / upN : null, dnVolAvg: dnN ? dnV / dnN : null,
    hi20prev, lo20: minOf(l, i - 19, i), hi60, lo60, hi240, lo240,
    pos240: hi240 > lo240 ? (c[i] - lo240) / (hi240 - lo240) * 100 : null, // 一年區間位階 0~100
    hi250: n >= 250 ? hi250 : null, lo250: n >= 250 ? lo250 : null, pos250: n >= 250 && hi250 > lo250 ? (c[i] - lo250) / (hi250 - lo250) * 100 : null, span250: Math.min(250, n),
    ret5: ret(5), ret20: ret(20), ret60: ret(60), ret240: ret(240), ret250: ret(250),
    maCross: cross(ma5, ma20), kdCross: cross(KD.K, KD.D), macdCross: cross(M.dif, M.dea),
    maBull: at(ma5) !== null && at(ma20) !== null && at(ma60) !== null && at(ma5) > at(ma20) && at(ma20) > at(ma60),
    maBear: at(ma5) !== null && at(ma20) !== null && at(ma60) !== null && at(ma5) < at(ma20) && at(ma20) < at(ma60),
  };
}
module.exports = { sma, ema, rsi, kd, macd, boll, snapshot };
