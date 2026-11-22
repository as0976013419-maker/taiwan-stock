// 友達（2409）減資案例：以真實日 K（正式站 /history 原始資料）與 FinMind 官方紀錄重播三種情況
// 用法：node auo_case.js <資料夾> <新版 backend> <舊版 backend（ecbe6db）>
const fs = require("fs"), path = require("path"), DIR = process.argv[2];
const J = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const NEW = require(path.join(process.argv[3], "src/analyze")), OLD = require(path.join(process.argv[4], "src/analyze"));
const h = J("h_2409.json"), old = J("af_2409.json"), tx = J("../audit/taiex.json").data;
const index = { code: "TAIEX", dates: tx.map((r) => r.date), closes: tx.map((r) => r.close), opens: tx.map((r) => r.open), highs: tx.map((r) => r.max), lows: tx.map((r) => r.min), volumes: tx.map(() => 0) };
const div = []; for (const r of J("TaiwanStockDividend_2409.json").data) { const c = (+r.CashEarningsDistribution || 0) + (+r.CashStatutorySurplus || 0); if (c > 0 && r.CashExDividendTradingDate) div.push({ date: r.CashExDividendTradingDate, cash: c, stock: 0 }); }
const red = J("TaiwanStockCapitalReductionReferencePrice_2409.json").data.map((r) => ({ date: r.date, before: +r.ClosingPriceonTheLastTradingDay, after: +r.PostReductionReferencePrice, type: "減資" }));
const n = h.dates.length, i = h.dates.indexOf("2022-10-11");
console.log(`原始日 K：2022-10-07 收 ${h.closes[i - 1]} → 2022-10-11 收 ${h.closes[i]}（單日 ${((h.closes[i] / h.closes[i - 1] - 1) * 100).toFixed(2)}%；漲跌幅限制 10%）`);
console.log(`官方減資參考價：${JSON.stringify(red[0])}`);
const row = Object.assign({}, old.quote, { date: h.dates[n - 1], price: h.closes[n - 1], prevClose: h.closes[n - 2], pe: old.fundamentals.pe, pb: old.fundamentals.pb, yield: old.fundamentals.yield, isETF: false, value: 1e9 });
const mk = (reductionsOk) => ({ demo: false, getMarketSnapshot: async () => ({ stocks: new Map([["2409", row]]) }), getQuote: async () => null, getHistory: async () => h,
  getChip: async () => old.chip, getMargin: async () => old.margin, getRevenue: async () => old.revenue, getPER: async () => null, getFinancials: async () => old.financials, getBalance: async () => old.balance,
  getDividends: async () => ({ years: [], lastEx: null, events: div }), getHolding: async () => old.holding, getNews: async () => [], getIndex: async () => index,
  getSplitMap: async () => new Map(), getCapitalReductions: async () => { if (!reductionsOk) throw Object.assign(new Error("FinMind 請求額度已用盡"), { quota: true }); return red; } });
const pick = (a) => { const q = a.quant || {}, r = q.risk || {}, rs = (k) => { const x = (q.rs || []).find((y) => y.k === k); return x ? (x.ret === null ? "無法計算" : x.ret + "%") : "—"; };
  return { bars: a.indicators ? a.indicators.bars : 0, cut: a.adjust && a.adjust.cut, unexplained: a.adjust ? a.adjust.unexplained.map((x) => x.date + " " + x.movePct + "%") : [], "1年": rs(250), "3年": rs(750), 最大回撤: r.maxDD, 年化波動: r.vol250, 最差單日: r.worstDay, 趨勢模板: q.trend ? q.trend.passed + "/" + q.trend.total : "不計算", 訊號統計: q.events ? q.events.bars + " 根" : "不計算", MA240: a.indicators ? +a.indicators.ma240.toFixed(2) : null }; };
(async () => {
  const U = require(path.join(process.argv[3], "src/util"));
  const a = await NEW.analyze(mk(true), "2409"); U._test_clear(); const b = await NEW.analyze(mk(false), "2409");
  const c = await OLD.analyze(mk(false), "2409");
  console.log("\nA 新版、取得官方減資紀錄：", JSON.stringify(pick(a)), "\n   已還原：", JSON.stringify(a.adjust.splits));
  console.log("\nB 新版、減資紀錄取不到（額度用盡）：", JSON.stringify(pick(b)));
  console.log("\nC 舊版 ecbe6db、減資紀錄取不到：", JSON.stringify(pick(c)));
  const l = b.text.split("\n").find((x) => x.startsWith("【無法解釋的價格跳動】")); console.log("\nB 的報告揭露：", l);
})().catch((e) => console.log("ERR", e.stack));
