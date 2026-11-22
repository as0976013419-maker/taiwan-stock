// G：/history 回傳的分割還原價餵給「整張」回測時，分割前的張數是否等於當時可交易的單位
// 資料：正式站 /history 存下的 0050 原始日 K（2021-09-01～2026-11-17）＋ FinMind 官方分割紀錄（2025-06-18，188.65 → 47.16）
// 用法：node docs/evidence/g_case.js <資料夾（含 h_0050.json）> <backend 路徑> <bt-core.js 路徑>
const fs = require("fs"), path = require("path"), vm = require("vm");
const [DIR, BE, CORE] = process.argv.slice(2).map((p) => path.resolve(p));
const raw = JSON.parse(fs.readFileSync(path.join(DIR, "h_0050.json"), "utf8")); raw.code = "0050";
const { adjustPrices, limitFor } = require(path.join(BE, "src/quant"));
const act = [{ date: "2025-06-18", before: 188.65, after: 47.16, type: "分割" }]; // 與 /history 使用的官方清單相同
const a = adjustPrices(raw, [], act, { limit: limitFor("0050") }), adj = a.price, splits = a.splits;
const f = (x, d = 0) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const iPre = raw.dates.indexOf("2025-06-10"), fee = 0.001425, cap = 1000000;
console.log("官方紀錄：", JSON.stringify(splits));
console.log(`2025-06-10（分割前最後交易日）收盤：原始 ${raw.closes[iPre]}，還原後 ${f(adj.closes[iPre], 4)}；成交量：原始 ${f(raw.volumes[iPre])} 股，還原後 ${f(adj.volumes[iPre])} 股`);
// 本金 100 萬、100% 部位、含 0.1425% 手續費：引擎的張數公式 floor(本金 / (價格 × 1000 × (1 + 費率)))
const lots = (p) => Math.floor(cap / (p * 1000 * (1 + fee))), r = splits[0].ratio;
const lr = lots(raw.closes[iPre]), la = lots(adj.closes[iPre]);
console.log(`以原始價（當時實際可交易）：${lr} 張 = ${f(lr * 1000)} 股（分割前）＝ 分割後 ${f(lr * 1000 * r)} 股；成本 ${f(lr * 1000 * raw.closes[iPre] * (1 + fee), 2)}`);
console.log(`以還原價（回測實際使用）：${la} 張 = ${f(la * 1000)} 股（換算後）＝ 分割前 ${f(la * 1000 / r, 1)} 股（${f(la / r, 4)} 張，不是整張）；成本 ${f(la * 1000 * adj.closes[iPre] * (1 + fee), 2)}`);
// 引擎實測：回測期間跨越分割，確認診斷有揭露、並列出變動前的進場
const ctx = { console, localStorage: { getItem: () => null }, Math, Date, JSON, Array, Object, Number, String, isNaN, isFinite, parseInt, parseFloat, Infinity, NaN, Error, Float64Array, Map, Set };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(CORE, "utf8") + ";this.run=runBacktestEngine;", ctx);
const i0 = adj.dates.findIndex((d) => d >= "2023-11-01"), i1 = adj.dates.filter((d) => d <= "2025-12-31").length, D = { code: "0050" };
for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) D[k] = adj[k].slice(i0, i1);
const res = ctx.run(JSON.parse(JSON.stringify(D)), { code: "0050", capital: cap, execType: "open", positionBase: "equity", posSize: 100, stopLoss: 8, stopProfit: 25, buyFee: 0.1425, sellFee: 0.4425, scoreThreshold: 1,
  longEntry: [{ id: "ma_golden", params: { fast: 5, slow: 20 } }], longExit: [{ id: "ma_death", params: { fast: 5, slow: 20 } }], shortEnabled: false, shortEntry: [], shortExit: [],
  tradeStart: "2024-12-02", unexplained: [], corpChecked: true, splitAdjusted: splits });
const g = res.diag;
console.log(`\n回測 2024-12-02～2025-12-31（均線 5/20、本金 100 萬、100%、隔日開盤）：診斷 shareChanges=${JSON.stringify(g.shareChanges)}，變動前進場 ${g.entriesBeforeShareChange} 筆`);
// 手續費與證交稅都是成交金額的固定比例，所以同一筆交易的淨損益與股數成正比：以當時整張換算的淨損益 = 回測淨損益 × 當時股數(換成現在股數) ÷ 回測股數
console.log("| 進場日（隔日開盤） | 還原價 | 回測張數 | 當時實際開盤價 | 回測股數換算成當時股數 | 同一筆可用現金在當時可買整張 | 回測淨損益 | 以當時整張計的淨損益 |\n|---|---|---|---|---|---|---|---|");
let dSim = 0, dReal = 0;
for (const e of g.entryLog.filter((x) => x.filled && x.execDate < "2025-06-18")) { const rp = raw.opens[raw.dates.indexOf(e.execDate)], realLots = Math.floor(e.cashBefore / (rp * 1000 * (1 + fee)));
  const ex = res.trades.find((t) => t.type === "exit" && t.entryDate === e.execDate), realPnl = ex ? ex.netPnl * (realLots * 1000 * r) / (e.lots * 1000) : null;
  if (ex) { dSim += ex.netPnl; dReal += realPnl; }
  console.log(`| ${e.execDate} | ${f(e.price, 2)} | ${e.lots} | ${rp} | ${f(e.lots * 1000 / r, 1)} | ${realLots} 張（${f(realLots * 1000)} 股） | ${ex ? f(ex.netPnl) : "未平倉"} | ${ex ? f(realPnl) : "—"} |`); }
console.log(`變動前進場的交易合計：回測淨損益 ${f(dSim)}，以當時整張計 ${f(dReal)}（差 ${f(dSim - dReal)}）。報酬率相同，差異來自張數單位不同。`);
