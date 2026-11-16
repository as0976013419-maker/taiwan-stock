"use strict";
// 示範資料模式（DEMO=1）：以股票代號為種子產生「固定可重現」的假資料，
// 介面與 sources.js 完全相同，用於離線開發、自動化測試與 UI 驗證。
// ⚠ 這些數字不是真實行情，所有回應都會帶 demo:true，前端會顯示橫幅。
const { round, ymd, taipeiNow } = require("./util");

const LIST = [
  ["2330", "台積電", "半導體", 1000], ["2317", "鴻海", "其他電子", 180], ["2454", "聯發科", "半導體", 1300], ["2308", "台達電", "電子零組件", 400],
  ["2603", "長榮", "航運", 200], ["2412", "中華電", "通信網路", 125], ["2882", "國泰金", "金融保險", 65], ["2891", "中信金", "金融保險", 38],
  ["3711", "日月光投控", "半導體", 160], ["2303", "聯電", "半導體", 50], ["2379", "瑞昱", "半導體", 520], ["3034", "聯詠", "半導體", 560],
  ["2382", "廣達", "電腦及週邊設備", 280], ["3231", "緯創", "電腦及週邊設備", 115], ["2357", "華碩", "電腦及週邊設備", 600], ["6669", "緯穎", "電腦及週邊設備", 2300],
  ["2609", "陽明", "航運", 70], ["2615", "萬海", "航運", 85], ["2881", "富邦金", "金融保險", 90], ["2886", "兆豐金", "金融保險", 40],
  ["1301", "台塑", "塑膠", 45], ["1303", "南亞", "塑膠", 42], ["2002", "中鋼", "鋼鐵", 22], ["1216", "統一", "食品", 82],
  ["2912", "統一超", "貿易百貨", 270], ["3008", "大立光", "光電", 2400], ["2409", "友達", "光電", 16], ["3481", "群創", "光電", 15],
  ["2327", "國巨", "電子零組件", 600], ["3037", "欣興", "電子零組件", 170], ["2345", "智邦", "通信網路", 700], ["3045", "台灣大", "通信網路", 110],
  ["6505", "台塑化", "油電燃氣", 55], ["1101", "台泥", "水泥", 32], ["2207", "和泰車", "汽車", 620], ["9910", "豐泰", "其他", 130],
  ["4743", "合一", "生技醫療", 75], ["6446", "藥華藥", "生技醫療", 620], ["3661", "世芯-KY", "半導體", 3200], ["5274", "信驊", "半導體", 5200],
  ["8069", "元太", "光電", 260], ["6488", "環球晶", "半導體", 420], ["5483", "中美晶", "半導體", 130], ["3529", "力旺", "半導體", 2600],
  ["0050", "元大台灣50", "ETF", 190], ["0056", "元大高股息", "ETF", 36], ["00878", "國泰永續高股息", "ETF", 22], ["00919", "群益台灣精選高息", "ETF", 23],
];
const OTC = new Set(["8069", "6488", "5483", "3529", "5274", "4743", "6446"]);

function rng(seedStr) { // mulberry32
  let h = 1779033703; for (const ch of String(seedStr)) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), h = h << 13 | h >>> 19;
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function tradingDays(n) { const out = []; const d = taipeiNow(); while (out.length < n) { if (d.getDay() % 6 !== 0) out.unshift(ymd(d)); d.setDate(d.getDate() - 1); } return out; }
const tick = (p) => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const toTick = (p) => { const t = tick(p); return round(Math.round(p / t) * t, 2); };

const _hist = new Map();
function fullHistory(code) {
  if (_hist.has(code)) return _hist.get(code);
  const meta = LIST.find((x) => x[0] === code); if (!meta) return null;
  const r = rng("h" + code), N = 1300, dates = tradingDays(N);
  const drift = (r() - 0.35) * 0.0012, vol = 0.012 + r() * 0.014, baseVol = (2000 + r() * 30000) * 1000;
  const closes = new Array(N); let p = meta[3];
  closes[N - 1] = p;
  for (let i = N - 2; i >= 0; i--) { p = p / Math.exp(drift + vol * gauss(r)); closes[i] = p; } // 由今天回推，讓最新價落在設定值附近
  const opens = [], highs = [], lows = [], volumes = [], cl = [];
  for (let i = 0; i < N; i++) {
    const prev = i ? cl[i - 1] : closes[0];
    let c = Math.max(prev * 0.9, Math.min(prev * 1.1, closes[i])); c = toTick(c);
    const o = toTick(prev * (1 + gauss(r) * vol * 0.4)), hi = toTick(Math.max(o, c) * (1 + Math.abs(gauss(r)) * vol * 0.5)), lo = toTick(Math.min(o, c) * (1 - Math.abs(gauss(r)) * vol * 0.5));
    cl.push(c); opens.push(o); highs.push(Math.max(hi, o, c)); lows.push(Math.min(lo, o, c));
    volumes.push(Math.round(baseVol * (0.5 + r() * 1.2) * (1 + Math.abs(c / prev - 1) * 25)));
  }
  const h = { code, dates, opens, highs, lows, closes: cl, volumes };
  _hist.set(code, h); return h;
}

async function getHistory(code, start, end) {
  const h = fullHistory(code); if (!h) return { code, dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  const a = h.dates.findIndex((d) => d >= start), bIdx = end ? h.dates.filter((d) => d <= end).length : h.dates.length;
  const s = (arr) => arr.slice(a < 0 ? arr.length : a, bIdx);
  return { code, dates: s(h.dates), opens: s(h.opens), highs: s(h.highs), lows: s(h.lows), closes: s(h.closes), volumes: s(h.volumes) };
}
function chipSeries(code) {
  const r = rng("c" + code), h = fullHistory(code), bias = (r() - 0.45) * 0.6, out = [];
  for (let i = h.dates.length - 60; i < h.dates.length; i++) {
    const lots = h.volumes[i] / 1000, f = Math.round(lots * (bias + gauss(r) * 0.3) * 0.15), t = Math.round(lots * (bias * 0.5 + gauss(r) * 0.3) * 0.04), d = Math.round(lots * gauss(r) * 0.02);
    out.push({ date: h.dates[i], foreign: f, trust: t, dealer: d, total: f + t + d });
  }
  return out;
}
function marginSeries(code) {
  const r = rng("m" + code), h = fullHistory(code), limit = Math.round(20000 + r() * 300000); let bal = Math.round(limit * (0.03 + r() * 0.3)); const out = [];
  for (let i = h.dates.length - 60; i < h.dates.length; i++) { bal = Math.max(100, Math.round(bal * (1 + gauss(r) * 0.02))); out.push({ date: h.dates[i], bal, limit, shortBal: Math.round(bal * (0.02 + r() * 0.1)) }); }
  return out;
}
const getChip = async (code) => (fullHistory(code) ? chipSeries(code) : []);
const getMargin = async (code) => (fullHistory(code) && !/^00/.test(code) ? marginSeries(code) : []);
function fund(code) { const r = rng("f" + code); return { pe: round(8 + r() * 30, 1), pb: round(0.8 + r() * 6, 2), yield: round(1 + r() * 5, 2), yoy: round((r() - 0.3) * 60, 1), mom: round((r() - 0.5) * 30, 1) }; }
async function getRevenue(code) {
  if (!fullHistory(code) || /^00/.test(code)) return null; const f = fund(code), r = rng("r" + code), base = 1e9 * (1 + r() * 50), months = [], d = taipeiNow(); d.setDate(1);
  for (let k = 12; k >= 1; k--) { const x = new Date(d); x.setMonth(x.getMonth() - k); const yoy = round(f.yoy + (r() - 0.5) * 20, 1); months.push({ ym: x.getFullYear() + "/" + String(x.getMonth() + 1).padStart(2, "0"), revenue: Math.round(base * (1 + (12 - k) * 0.01 + (r() - 0.5) * 0.1)), yoy, mom: round((r() - 0.5) * 20, 1) }); }
  const L = months[11]; L.yoy = f.yoy; L.mom = f.mom;
  return { ym: L.ym, revenue: L.revenue, yoy: L.yoy, mom: L.mom, yoy3: months.slice(-3).map((m) => m.yoy), months, ytdYoY: round(f.yoy * 0.9, 1), newHigh: false };
}
async function getPER(code) {
  if (!fullHistory(code) || /^00/.test(code)) return null; const f = fund(code), r = rng("p" + code), mk = (v) => Array.from({ length: 1200 }, () => round(v * (0.6 + r() * 0.9), 2));
  return { pe: f.pe, pb: f.pb, yield: f.yield, hist: { pe: mk(f.pe), pb: mk(f.pb), yield: mk(f.yield), from: "2021-11-15" } };
}
async function getFinancials(code) {
  if (!fullHistory(code) || /^00/.test(code)) return null; const r = rng("q" + code), f = fund(code), out = [], gm0 = 15 + r() * 40, rev0 = 3e9 * (1 + r() * 60), d = taipeiNow();
  let y = d.getFullYear(), q = Math.floor(d.getMonth() / 3); if (q === 0) { y--; q = 4; }
  for (let k = 8; k >= 0; k--) { let yy = y, qq = q - k; while (qq <= 0) { qq += 4; yy--; }
    const rev = rev0 * (1 + (8 - k) * 0.03 + (r() - 0.5) * 0.08), gm = gm0 + (r() - 0.5) * 4, om = gm - 12 - r() * 5, nm = om * 0.82, ni = rev * nm / 100;
    out.push({ date: yy + "-" + String(qq * 3).padStart(2, "0") + "-30", label: yy + "Q" + qq, revenue: Math.round(rev), gross: Math.round(rev * gm / 100), opInc: Math.round(rev * om / 100), netInc: Math.round(ni), eps: round(Math.max(0.1, f.pe ? fullHistory(code).closes.at(-1) / f.pe / 4 * (0.8 + (8 - k) * 0.04 + r() * 0.1) : 1), 2), gm: round(gm, 1), om: round(om, 1), nm: round(nm, 1) }); }
  return out;
}
async function getBalance(code) {
  const q = await getFinancials(code); if (!q) return null; const r = rng("b" + code), ttm = q.slice(-4).reduce((s, x) => s + x.netInc, 0), equity = ttm / (0.06 + r() * 0.2), liab = equity * (0.3 + r() * 1.2);
  return { date: q.at(-1).date, assets: Math.round(equity + liab), liabilities: Math.round(liab), equity: Math.round(equity), curAssets: Math.round((equity + liab) * 0.4), curLiab: Math.round(liab * 0.5), cash: Math.round(equity * 0.2), inventory: Math.round(equity * 0.1) };
}
async function getDividends(code) {
  const h = fullHistory(code); if (!h) return null; const f = fund(code), y = taipeiNow().getFullYear(), p = h.closes.at(-1);
  return { years: [3, 2, 1, 0].map((k) => ({ year: String(y - k), cash: round(p * f.yield / 100 * (0.8 + (3 - k) * 0.07), 2), stock: 0, times: 1 })), lastEx: { date: y + "-07-15", cash: round(p * f.yield / 100, 2), period: "示範" }, events: [] };
}
async function getHolding(code) { if (!fullHistory(code)) return null; const r = rng("o" + code), x = round(10 + r() * 50, 2), d = () => round((r() - 0.5) * 1.5, 2); return { date: fullHistory(code).dates.at(-1), ratio: x, ratio5: round(x - d() * 0.3, 2), ratio20: round(x - d(), 2), ratio60: round(x - d() * 2, 2), shares: Math.round(1e8 * (5 + r() * 250)) }; }
async function getNews(code) { return fullHistory(code) ? [{ date: fullHistory(code).dates.at(-1) + " 09:00", title: "（示範）這是一則示範新聞標題，並非真實新聞", source: "示範", link: "https://example.com/" }] : []; }
let _idx = null;
async function getIndex() { // 以所有示範股的等權平均報酬合成一條「大盤」
  if (_idx) return _idx; const hs = LIST.filter((m) => !/^00/.test(m[0])).map((m) => fullHistory(m[0])), n = hs[0].closes.length, closes = [20000];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + hs.reduce((s, h) => s + (h.closes[i] / h.closes[i - 1] - 1), 0) / hs.length));
  return (_idx = { code: "TAIEX", dates: hs[0].dates, opens: closes, highs: closes, lows: closes, closes, volumes: new Array(n).fill(0) });
}

function row(meta) {
  const [code, name, industry] = meta, h = fullHistory(code), i = h.closes.length - 1, price = h.closes[i], prev = h.closes[i - 1], f = fund(code), etf = /^00/.test(code);
  const c = chipSeries(code)[59], m = marginSeries(code);
  return {
    code, name, market: OTC.has(code) ? "上櫃" : "上市", isETF: etf, industry, price, prevClose: prev, change: round(price - prev), changePct: round((price / prev - 1) * 100),
    open: h.opens[i], high: h.highs[i], low: h.lows[i], volume: Math.round(h.volumes[i] / 1000), value: Math.round(h.volumes[i] * price), date: h.dates[i],
    pe: etf ? null : f.pe, pb: etf ? null : f.pb, yield: f.yield, revYoY: etf ? null : f.yoy, revMoM: etf ? null : f.mom,
    inst: { foreign: c.foreign, trust: c.trust, dealer: c.dealer, total: c.total }, margin: etf ? null : { bal: m[59].bal, prev: m[58].bal, limit: m[59].limit, shortBal: m[59].shortBal },
  };
}
let _snap = null;
async function getMarketSnapshot() {
  if (!_snap) _snap = { stocks: new Map(LIST.map((m) => [m[0], row(m)])), asOf: new Date().toISOString(), sources: { demo: true } };
  return _snap;
}
async function getQuote(code) { const s = (await getMarketSnapshot()).stocks.get(code); return s ? Object.assign({}, s, { realtime: false, time: s.date }) : null; }
async function getDisposition() {
  return [{ code: "4743", name: "合一", type: "處置股", reason: "連續三次達注意標準（示範）", period: "示範期間" }, { code: "6446", name: "藥華藥", type: "注意股", reason: "近六日累積漲幅異常（示範）", period: "" }];
}
module.exports = { demo: true, getMarketSnapshot, getHistory, getChip, getMargin, getRevenue, getPER, getFinancials, getBalance, getDividends, getHolding, getNews, getIndex, getQuote, getDisposition };
