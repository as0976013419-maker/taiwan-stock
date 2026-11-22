// 以正式站 /history 存下的台積電真實日 K，照使用者回報的設定執行回測（新流程：起始日前暖機）
// 用法：node bt_table2.js <資料夾> <bt-core.js 路徑>
const fs = require("fs"), path = require("path"), vm = require("vm");
const h = JSON.parse(fs.readFileSync(path.join(process.argv[2], "h_2330.json"), "utf8"));
const ctx = { console, localStorage: { getItem: () => null }, Math, Date, JSON, Array, Object, Number, String, isNaN, isFinite, parseInt, parseFloat, Infinity, NaN, Error, Float64Array, Map, Set };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[3], "utf8") + ";this.run=runBacktestEngine;", ctx);
// 與回測頁相同：多抓起始日前約 400 個日曆日
const i0 = h.dates.findIndex((d) => d >= "2024-11-12"), i1 = h.dates.filter((d) => d <= "2026-11-17").length, D = { code: "2330" };
for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) D[k] = h[k].slice(i0, i1);
const cfg = (c) => ({ code: "2330", capital: c, execType: "open", positionBase: "equity", posSize: 100, stopLoss: 8, stopProfit: 25, buyFee: 0.1425, sellFee: 0.4425, scoreThreshold: 1,
  longEntry: [{ id: "ma_golden", params: { fast: 5, slow: 20 } }], longExit: [{ id: "ma_death", params: { fast: 5, slow: 20 } }], shortEnabled: false, shortEntry: [], shortExit: [],
  tradeStart: "2025-11-17", unexplained: [], corpChecked: true });
const f = (x) => Number(x).toLocaleString("en-US");
for (const cap of [1000000, 3000000]) {
  const r = ctx.run(JSON.parse(JSON.stringify(D)), cfg(cap)), g = r.diag;
  console.log(`\n### 本金 ${f(cap)}：回測期間 ${r.dates[0]}～${r.dates[r.dates.length - 1]}（${r.equity.length} 個交易日；起始日前另用 ${g.preBars} 根暖機）`);
  console.log(`進場訊號 ${g.entrySignals} 次、成交 ${g.entryLog.filter((e) => e.filled).length} 次、拒單 ${g.rejected} 次（現金不足 ${g.rejectedCash}）；拒單所需金額 ${g.minCashNeeded === null ? "—" : f(g.minCashNeeded) + "～" + f(g.maxCashNeeded)}`);
  console.log("| # | 訊號日 | 成交日（隔日開盤） | 參考價 | 一張含費所需 | 當時可用現金 | 張數 | 結果 |\n|---|---|---|---|---|---|---|---|");
  g.entryLog.forEach((e, k) => console.log(`| ${k + 1} | ${e.signalDate} | ${e.execDate} | ${f(e.price)} | ${f(e.perLot)} | ${f(e.cashBefore)} | ${e.lots} | ${e.filled ? "成交 " + e.lots * 1000 + " 股" : "拒單：現金不足一張"} |`));
  const ex = r.trades.filter((t) => t.type === "exit");
  if (ex.length) {
    console.log("\n| # | 進場 | 出場 | 原因 | 股數 | 買進手續費 | 賣出費稅 | 淨損益 |\n|---|---|---|---|---|---|---|---|");
    let tot = 0;
    ex.forEach((t, k) => { tot += t.netPnl; console.log(`| ${k + 1} | ${t.entryDate} @${f(t.entryPrice)} | ${t.exitDate} @${f(t.exitPrice)} | ${t.reason} | ${t.qty * 1000} | ${f(Math.round(t.entryFees))} | ${f(Math.round(t.exitFees))} | ${f(Math.round(t.netPnl))} |`); });
    console.log(`已實現淨損益合計 ${f(Math.round(tot))}；期末權益 ${f(Math.round(r.metrics.finalEquity))}（權益變動 ${f(Math.round(r.metrics.finalEquity - cap))}；總報酬 ${(r.metrics.totalReturn * 100).toFixed(2)}%；期末未平倉：${g.openAtEnd ? "是" : "否"}）`);
  }
}
