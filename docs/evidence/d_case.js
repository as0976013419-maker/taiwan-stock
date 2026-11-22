// Codex 反例 D：80 根人工日 K，第 40 根起由 100 跳到 50（查無公告）。明確標示為測試資料，非真實行情。
// 用法：DEMO=1 node docs/evidence/d_case.js <backend 路徑>
// 輸出：個股分析路徑的風險指標與報告文字片段；掃描路徑以「跳動序列」與「只有跳動後序列」比較評分是否一致。
const path = require("path"), B = path.resolve(process.argv[2]);
const { analyze } = require(path.join(B, "src/analyze")), { runScan } = require(path.join(B, "src/scan"));
const U = require(path.join(B, "src/util")), demo = require(path.join(B, "src/demo"));
const flat = (n, fn) => { const d = [], c = []; for (let i = 0; i < n; i++) { d.push(new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10)); c.push(fn(i)); }
  return { dates: d, opens: c.slice(), highs: c.slice(), lows: c.slice(), closes: c, volumes: c.map(() => 1e6) }; };
const src = (over) => Object.assign({}, demo, over);
(async () => {
  if (U._test_clear) U._test_clear();
  const a = await analyze(src({ getHistory: async (c) => Object.assign(flat(80, (i) => (i < 40 ? 100 : 50)), { code: c }), getQuote: async () => null, getMarketSnapshot: async () => ({ stocks: new Map() }) }), "2330");
  const r = a.quant && a.quant.risk;
  console.log("[個股] 使用 K 線：", a.indicators && a.indicators.bars !== undefined ? a.indicators.bars : "(無欄位)", " 截斷：", JSON.stringify(a.adjust && a.adjust.cut || null));
  console.log("[個股] 風險指標：", r ? JSON.stringify({ days: r.days, maxDD: r.maxDD, vol60: r.vol60, vol250: r.vol250, worstDay: r.worstDay }) : "不計算（null）");
  console.log("[個股] 報告『風險』段：", (a.text.split("\n").find((l) => /最大回撤|風險指標/.test(l)) || "(無)").slice(0, 160));
  // 掃描：每檔前 150 根為 0.45p（查無公告的 +100% 跳動），之後 50 根由 0.9p 緩升到 p（p＝該檔快照價，避免快照併入時再產生跳動）。
  // 對照組只有跳動後 50 根。若掃描沒有截斷，60 日報酬、均線排列、年線位階等會混入跳動前的價格，兩組評分就會不同。
  const snap = await demo.getMarketSnapshot(), price = (c) => (snap.stocks.get(c) || {}).price || 100;
  const jump = (c) => Object.assign(flat(200, (i) => (i < 150 ? 0.45 * price(c) : price(c) * (0.9 + 0.1 * (i - 150) / 49))), { code: c });
  const post = (c) => { const h = jump(c); for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) h[k] = h[k].slice(150); return h; };
  const cols = (s) => s.stocks.map((x) => [x.code, x.techScore, x.volScore, x.totalScore !== undefined ? x.totalScore : x.score].join(":")).join(" ");
  if (U._test_clear) U._test_clear(); const s1 = await runScan(src({ getHistory: async (c) => jump(c) }), { mode: "volume", limit: 8 });
  if (U._test_clear) U._test_clear(); const s2 = await runScan(src({ getHistory: async (c) => post(c) }), { mode: "volume", limit: 8 });
  console.log("[掃描] 跳動序列：     ", cols(s1)); console.log("[掃描] 只用跳動後序列：", cols(s2)); console.log("[掃描] 兩者一致：", cols(s1) === cols(s2));
})().catch((e) => { console.error("錯誤：", e.message); process.exit(1); });
