// Codex 審查提供的人工反例（明確標示為測試資料，非真實行情）
// 用法：node codex_cases.js <bt-core.js 路徑>
const fs = require("fs"), vm = require("vm");
const ctx = { console, localStorage: { getItem: () => null }, Math, Date, JSON, Array, Object, Number, String, isNaN, isFinite, parseInt, parseFloat, Infinity, NaN, Error, Float64Array, Map, Set };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(process.argv[2], "utf8") + ";this.run=runBacktestEngine;", ctx);
const mk = (closes, opens) => { const n = closes.length, d = { code: "T", dates: [], opens: opens || closes.slice(), closes, highs: [], lows: [], volumes: [] };
  for (let i = 0; i < n; i++) { const t = new Date(Date.UTC(2020, 0, 1 + i)); d.dates.push(t.toISOString().slice(0, 10)); d.highs.push(Math.max(d.opens[i], closes[i])); d.lows.push(Math.min(d.opens[i], closes[i])); d.volumes.push(1e6); } return d; };
// corpChecked：人工測試資料沒有公司行動，明確標示為已檢查（舊版引擎會忽略此欄位）
const base = (o) => Object.assign({ code: "T", corpChecked: true, capital: 1000000, positionBase: "equity", posSize: 100, scoreThreshold: 1, longExit: [], shortEnabled: false, shortEntry: [], shortExit: [] }, o);
const show = (label, r) => console.log(label, JSON.stringify(r.trades.map((t) => [t.type, t.side, t.date, t.price, t.reason || "", t.netPnl !== undefined ? Math.round(t.netPnl * 100) / 100 : ""])), "未平倉:", !!(r.diag && r.diag.openAtEnd));
// B：多單 100 元進場，次日開盤 130、收盤 90，停利 25%（open 模式）
{ const c = Array(60).fill(90).concat([100, 90, 90]), o = c.slice(); o[60] = 100; o[61] = 130;
  // 以「價格站上 20 日均線」在第 59 根收盤產生訊號 → 第 60 根開盤 100 進場
  c[59] = 95; const r = ctx.run(JSON.parse(JSON.stringify(mk(c, o))), base({ execType: "open", stopProfit: 25, longEntry: [{ id: "price_above_ma", params: { period: 20 } }] }));
  show("B 多單停利（open）：", r); }
// B'：空單 100 元進場，次日開盤 70、收盤 110，停利 25%（open 模式）
{ const c = Array(60).fill(110).concat([100, 110, 110]), o = c.slice(); o[60] = 100; o[61] = 70; c[59] = 105;
  const r = ctx.run(JSON.parse(JSON.stringify(mk(c, o))), base({ execType: "open", stopProfit: 25, longEntry: [], shortEnabled: true, shortEntry: [{ id: "s_price_below_ma", params: { period: 20 } }] }));
  show("B' 空單停利（open）：", r); }
// C：多單 100 元進場（close 模式），收盤升到 120 再跌到 108，移動停損 8%（物件形式）
{ const c = Array(60).fill(90).concat([100, 110, 120, 108, 108]); c[59] = 100;
  const r = ctx.run(JSON.parse(JSON.stringify(mk(c))), base({ execType: "close", longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [{ id: "trailing_stop", params: { pct: 8 } }] }));
  show("C 多單移動停損 8%（close）：", r); }
// C'：空單移動停損 8%（close 模式）：100 放空，收盤跌到 80 再升到 87
{ const c = Array(60).fill(110).concat([100, 90, 80, 87, 87]); c[59] = 100;
  const r = ctx.run(JSON.parse(JSON.stringify(mk(c))), base({ execType: "close", longEntry: [], shortEnabled: true, shortEntry: [{ id: "s_price_below_ma", params: { period: 20 } }], shortExit: [{ id: "s_trailing", params: { pct: 8 } }] }));
  show("C' 空單移動停損 8%（close）：", r); }
// C''：open 模式時間順序：當日開盤 112 時，已知最高收盤 120 → 回撤 6.7% 未達 8%；當日收盤 100 → 隔日開盤 100 才觸發
{ const c = Array(60).fill(90).concat([100, 110, 120, 100, 100, 100]), o = c.slice(); c[59] = 95; o[60] = 100; o[63] = 112; o[64] = 100;
  const r = ctx.run(JSON.parse(JSON.stringify(mk(c, o))), base({ execType: "open", longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [{ id: "trailing_stop", params: { pct: 8 } }] }));
  show("C'' 多單移動停損 8%（open）：", r); }
