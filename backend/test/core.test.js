"use strict";
// 執行：npm test（使用示範資料，不需要網路）
const test = require("node:test"), assert = require("node:assert");
const I = require("../src/indicators"), S = require("../src/scoring"), demo = require("../src/demo");
const { analyze } = require("../src/analyze"), { runScan } = require("../src/scan"), { SECTIONS } = require("../src/ai");

test("SMA／RSI／KD 基本性質", () => {
  assert.deepStrictEqual(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.strictEqual(I.rsi(up, 14)[39], 100);               // 連續上漲 → RSI 100
  const flat = new Array(40).fill(50), k = I.kd(flat, flat, flat, 9);
  assert.strictEqual(Math.round(k.K[39]), 50);              // 無波動 → KD 停在 50
});
test("漲停價依升降單位向下取整", () => {
  assert.strictEqual(S.limitUpPrice(100, false), 110);
  assert.strictEqual(S.limitUpPrice(33.35, false), 36.65);  // 36.685 → 0.05 一跳
  assert.strictEqual(S.limitUpPrice(985, false), 1080);     // 1083.5 → 5 元一跳
});
test("評分：六面向加總等於總分，且不超過各自上限", async () => {
  for (const code of ["2330", "2603", "0050", "8069"]) {
    const a = await analyze(demo, code), d = a.scored.detail;
    assert.strictEqual(d._fund + d._tech + d._vol + d._chip + d._margin + d._theme, a.scored.score);
    assert.ok(d._fund <= 20 && d._tech <= 25 && d._vol <= 15 && d._chip <= 20 && d._margin <= 10 && d._theme <= 10);
    for (const k of Object.keys(d)) if (k[0] !== "_") assert.match(d[k], /^(\+\d+|0|—)$/);
  }
});
test("ETF 不計入個股基本面", async () => {
  const a = await analyze(demo, "0050");
  assert.strictEqual(a.scored.detail.rev_yoy, "—"); assert.strictEqual(a.scored.detail._fund, 0);
});
test("規則式報告含前端需要的所有段落，裁定只有一個方向", async () => {
  const a = await analyze(demo, "2330");
  for (const s of SECTIONS.filter((x) => x !== "AI綜合分析")) assert.ok(a.text.includes("=== " + s + "\n"), "缺段落 " + s);
  // 整體方向以結構化欄位 stance 為準；裁定段第一行必須與它一致（其後各週期可以有不同方向）
  const first = a.text.split("=== 最終裁定\n")[1].split("\n")[0];
  assert.ok(["偏多", "偏空", "中性"].includes(a.stance)); assert.ok(first.startsWith(a.stance === "中性" ? "中性震盪" : a.stance));
});
test("七種掃描都回傳前端需要的欄位", async () => {
  for (const mode of ["volume", "change", "drop", "momentum", "limitup", "disposition", "sector"]) {
    const r = await runScan(demo, { mode, limit: 5, universe: "large" });
    assert.ok(Array.isArray(r.stocks), mode);
    for (const s of r.stocks) { assert.ok(s.code && s.name && typeof s.changePct === "string", mode); }
    if (mode === "sector") assert.ok(r.sectors.length && r.sectors[0].leaders.length);
  }
  await assert.rejects(() => runScan(demo, { mode: "nope" }), /不支援/);
});
test("查無代號回 404、亂輸入回 400", async () => {
  await assert.rejects(() => analyze(demo, "9999"), (e) => e.status === 404);
  await assert.rejects(() => analyze(demo, "<script>"), (e) => e.status === 400);
});

// ── v5.2 回歸測試：金融計算正確性 ──
const Q = require("../src/quant");
const flat = (n, fn) => { const d = [], c = []; for (let i = 0; i < n; i++) { const dt = new Date(Date.UTC(2020, 0, 1 + i)); d.push(dt.toISOString().slice(0, 10)); c.push(fn(i)); } return { code: "T", dates: d, opens: c.slice(), highs: c.slice(), lows: c.slice(), closes: c, volumes: c.map(() => 1000) }; };

test("還原權息：官方分割＋除息後，含息報酬不得出現虧損；價位序列保留除息缺口", () => {
  const h = flat(60, (i) => (i < 30 ? 100 : i < 45 ? 25 : 23.75)); h.volumes = h.closes.map((_, i) => (i < 30 ? 1000 : 4000));
  const a = Q.adjustPrices(h, [{ date: h.dates[45], cash: 1.25, stock: 0 }], [{ date: h.dates[30], before: 100, after: 25, type: "分割" }]);
  assert.strictEqual(a.splits.length, 1); assert.strictEqual(a.splits[0].ratio, 4); assert.strictEqual(a.splits[0].official, true); assert.strictEqual(a.dividendsApplied, 1);
  assert.ok(Math.abs(a.total.closes[59] / a.total.closes[0] - 1) < 1e-9, "含息還原後整段報酬應為 0");
  assert.ok(Math.abs(a.price.closes[59] / a.price.closes[0] - 1 + 0.05) < 1e-9, "不含息序列保留 5% 的除息缺口");
  assert.strictEqual(a.price.volumes[0], 4000, "分割前的成交量要換算成分割後的股數");
  assert.strictEqual(a.price.closes[59], h.closes[59], "最新價必須是實際成交價"); assert.strictEqual(h.closes[0], 100, "原始序列不得被修改");
});
test("還原權息：查無官方公告時絕不自行估算倍數，只揭露", () => {
  const h = flat(60, (i) => (i < 30 ? 100 : 25)); // 外觀像一拆四，但沒有任何公告
  const a = Q.adjustPrices(h, [], []);
  assert.strictEqual(a.splits.length, 0); assert.strictEqual(a.price, h, "沒有官方公告 → 價位序列就是原始序列"); assert.strictEqual(a.total, h);
  assert.strictEqual(a.unexplained.length, 1); assert.strictEqual(a.unexplained[0].date, h.dates[30]);
});
test("還原權息：漲跌停內的正常波動不列為異常；同一筆股利重複出現只計一次", () => {
  const h = flat(40, (i) => 100 * (i % 2 ? 1.1 : 1));
  const a = Q.adjustPrices(h, [], []); assert.strictEqual(a.unexplained.length, 0); assert.strictEqual(a.changed, false);
  const g = flat(40, (i) => (i < 20 ? 100 : 95)), e = { date: g.dates[20], cash: 5, stock: 0 };
  const once = Q.adjustPrices(g, [e], []), twice = Q.adjustPrices(g, [e, Object.assign({}, e)], []);
  assert.strictEqual(twice.dividendsApplied, 1); assert.strictEqual(twice.total.closes[0], once.total.closes[0]); assert.ok(Math.abs(once.total.closes[0] - 95) < 1e-9);
});
test("還原權息：股票股利（配股）使股數增加，價位與含息序列都要還原", () => {
  const g = flat(40, (i) => (i < 20 ? 110 : 100)); // 配股 1 元（每 10 股配 1 股）→ 參考價 110 ÷ 1.1 ＝ 100
  const a = Q.adjustPrices(g, [{ date: g.dates[20], cash: 0, stock: 1 }], []);
  assert.ok(Math.abs(a.price.closes[0] - 100) < 1e-9); assert.strictEqual(a.unexplained.length, 0); assert.ok(Math.abs(a.price.volumes[0] - 1100) < 1e-9);
});

// ── 真實公司行動案例（資料片段見 fixtures/corporate-actions.json）──
const FX = require("./fixtures/corporate-actions.json");
const dayRet = (s, date) => { const i = s.dates.indexOf(date); return (s.closes[i] / s.closes[i - 1] - 1) * 100; };
test("真實案例：0050 一拆四（2025-06-18）還原後不再出現 -74.8% 的假跌幅", () => {
  const f = FX.split_0050, a = Q.adjustPrices(f.hist, [], f.actions);
  assert.ok(dayRet(f.hist, f.date) < -70, "原始資料確實有假跌幅"); assert.ok(Math.abs(dayRet(a.price, f.date)) < 10, "還原後當日漲跌應在漲跌幅限制內：" + dayRet(a.price, f.date));
  assert.ok(Math.abs(a.splits[0].ratio - 4) < 0.01); assert.strictEqual(a.unexplained.length, 0);
  const i = f.hist.dates.indexOf(f.date); for (let k = i; k < f.hist.closes.length; k++) assert.strictEqual(a.price.closes[k], f.hist.closes[k], "分割後的價格必須是實際成交價");
  assert.ok(Math.abs(a.price.closes[i - 1] * a.price.volumes[i - 1] - f.hist.closes[i - 1] * f.hist.volumes[i - 1]) < 1, "還原不得改變成交金額");
});
test("真實案例：00632R 反分割（2024-12-11）還原後不再出現 +600% 的假漲幅", () => {
  const f = FX.reverse_00632R, a = Q.adjustPrices(f.hist, [], f.actions);
  assert.ok(dayRet(f.hist, f.date) > 500); assert.ok(Math.abs(dayRet(a.price, f.date)) < 10); assert.ok(a.splits[0].ratio < 1); assert.strictEqual(a.unexplained.length, 0);
});
test("真實案例：國巨面額變更（2025-08-25）與現金減資（2022-10-31）", () => {
  const p = FX.parvalue_2327, a = Q.adjustPrices(p.hist, [], p.actions.filter((x) => p.hist.dates.includes(x.date)));
  assert.ok(dayRet(p.hist, p.date) < -70); assert.ok(Math.abs(dayRet(a.price, p.date)) < 10.5);
  const r = FX.reduction_2327, b = Q.adjustPrices(r.hist, [], r.actions);
  assert.ok(dayRet(r.hist, r.date) > 30); assert.ok(Math.abs(dayRet(b.price, r.date)) < 10.5, "減資還原後：" + dayRet(b.price, r.date)); assert.strictEqual(b.unexplained.length, 0);
});
test("真實案例：聯發科除息 73 元（2022-06-23）含息序列還原、價位序列不動", () => {
  const f = FX.exdiv_2454, a = Q.adjustPrices(f.hist, f.dividends, []);
  assert.ok(dayRet(f.hist, f.date) < -14); assert.ok(dayRet(a.total, f.date) > -7 && dayRet(a.total, f.date) < -5, "含息：" + dayRet(a.total, f.date));
  assert.strictEqual(a.price, f.hist, "除息不改變可交易價位"); assert.strictEqual(a.unexplained.length, 0, "已由股利解釋，不應列為異常");
});
test("真實案例：槓桿 ETF 的 ±20% 單日變動是真實行情，不得被還原", () => {
  const f = FX.leveraged_00631L, a = Q.adjustPrices(f.hist, [], f.actions);
  assert.strictEqual(a.splits.length, 0); assert.strictEqual(a.price, f.hist); assert.ok(a.unexplained.length >= 1, "應揭露但不還原");
  assert.ok(Math.abs(dayRet(a.total, f.date) - dayRet(f.hist, f.date)) < 1e-9);
});
test("風險指標：對已知序列的公式驗算", () => {
  // 每日報酬在 +1% 與 -1% 之間交替：日標準差≈1% → 年化 ≈ 1%×√252 ≈ 15.9%
  const h = flat(300, () => 0); let p = 100; h.closes = h.closes.map((_, i) => (p = i === 0 ? 100 : p * (i % 2 ? 1.01 : 0.99)));
  h.opens = h.closes.slice(); h.highs = h.closes.slice(); h.lows = h.closes.slice();
  const r = Q.riskMetrics(h, null);
  assert.ok(Math.abs(r.vol250 - 15.9) < 0.2, "年化波動 " + r.vol250); // +1%／-1% 交替時每兩天淨損 0.01%，250 天累積約 -1.2%，再加上單日 -1% → 最大回撤約 -2.2%
  assert.ok(r.maxDD < -2 && r.maxDD > -2.5, "最大回撤 " + r.maxDD);
  assert.ok(r.var95 <= -0.98 && r.var95 >= -1.02, "VaR " + r.var95); assert.strictEqual(r.beta, null, "沒有大盤資料時 Beta 必須是 null 而不是 0");
  // ATR：每天高低差固定 2 元、無跳空 → ATR 應為 2
  const g = flat(60, () => 100); g.highs = g.closes.map(() => 101); g.lows = g.closes.map(() => 99);
  assert.ok(Math.abs(Q.atr(g.highs, g.lows, g.closes, 14) - 2) < 1e-9);
});
test("Beta：個股報酬恰為大盤兩倍時應為 2", () => {
  const idx = flat(300, () => 0), s = flat(300, () => 0); let a = 100, b = 100;
  for (let i = 0; i < 300; i++) { const r = Math.sin(i * 1.7) * 0.01; if (i) { a *= 1 + r; b *= 1 + 2 * r; } idx.closes[i] = a; s.closes[i] = b; }
  for (const k of ["opens", "highs", "lows"]) { idx[k] = idx.closes.slice(); s[k] = s.closes.slice(); }
  const r = Q.riskMetrics(s, idx); assert.ok(Math.abs(r.beta - 2) < 0.02, "beta " + r.beta); assert.ok(r.corr > 0.99);
});
test("部位試算：風險金額 ÷ 停損距離", () => {
  const z = Q.sizing(100, 2.5, [], 1000000, 1); // 2 倍 ATR＝5 元 → 10,000 ÷ 5 ＝ 2,000 股
  assert.strictEqual(z[0].shares, 2000); assert.strictEqual(z[0].stop, 95); assert.strictEqual(z[0].value, 200000); assert.strictEqual(z[0].weight, 20);
  assert.strictEqual(Q.sizing(100, null, []), null, "沒有 ATR 時不得試算");
});
test("歷史訊號統計：進場用隔日開盤、隨機資料不得出現顯著訊號、樣本不足要標示", async () => {
  const h = await demo.getHistory("2330", "2019-01-01"), ev = Q.eventStudy(h);
  // 前視偏誤檢查：把「訊號日之後」的價格全部改掉，訊號日期本身不能改變
  const cut = 900, h2 = { code: h.code, dates: h.dates.slice(0, cut), opens: h.opens.slice(0, cut), highs: h.highs.slice(0, cut), lows: h.lows.slice(0, cut), closes: h.closes.slice(0, cut), volumes: h.volumes.slice(0, cut) };
  const e2 = Q.eventStudy(h2);
  for (const e of ev.events) { const x = e2.events.find((y) => y.key === e.key); assert.ok(x.count <= e.count, e.key + "：截斷資料後事件數不應變多"); }
  for (const e of ev.events) for (const x of e.h) { assert.ok(["insufficient", "none", "weak", "strong"].includes(x.grade)); if (x.n) { assert.ok(x.indep <= x.n); if (x.indep < 10) assert.strictEqual(x.grade, "insufficient"); } }
  // 示範資料是隨機漫步：做了多重檢定校正後，不應有任何訊號被判為「顯著」
  assert.strictEqual(ev.events.filter((e) => e.h.some((x) => x.grade === "strong")).length, 0);
  assert.strictEqual(ev.cost, 0.585);
});
test("缺漏值不得當成 0：沒有財報時 EPS／ROE 相關欄位為 null，評分顯示「—」", () => {
  const sc = S.scoreStock({ snap: { isETF: false, changePct: 1 }, ind: null, fund: { pe: null, pb: null, revYoY: null, revMoM: null }, sector: null });
  for (const k of ["rev_yoy", "eps_growth", "roe", "margin_stable", "above_ma20", "foreign_buy", "margin_health", "theme_main"]) assert.strictEqual(sc.detail[k], "—", k);
  assert.strictEqual(sc.score, 0);
});
test("分析輸出：三個週期各自有判斷與證據、資料日期齊全、報告無壞值", async () => {
  for (const code of ["2330", "2603", "0050"]) {
    const a = await analyze(demo, code);
    assert.strictEqual(a.horizons.length, 3); for (const h of a.horizons) assert.ok(["偏多", "偏空", "中性", "資料不足"].includes(h.view));
    assert.ok(a.asOf && a.asOf.kline && a.asOf.chip); assert.ok(!/NaN|undefined|Infinity|null/.test(a.text), code + " 報告含壞值");
    assert.ok(a.text.includes("【判斷失效條件】") && a.text.includes("【證據強度】"));
  }
});
test("首頁熱門股列（lite）不做個股評分", async () => {
  const r = await runScan(demo, { mode: "volume", limit: 10, lite: true });
  assert.strictEqual(r.lite, true); assert.strictEqual(r.stocks.length, 10); assert.strictEqual(r.stocks[0].score, undefined);
});

// ── 相容性：缺漏資料、各種歷史長度、停牌、來源失敗 ──
const { analyze: analyzeFn } = require("../src/analyze");
function srcWith(over) { // 以示範來源為底，覆寫個別資料源來模擬各種狀況
  const base = Object.assign({}, demo); return Object.assign(base, over);
}
const cutHist = (n) => async (code, start, end) => { const h = await demo.getHistory(code, "2000-01-01"); const o = { code }; for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) o[k] = h[k].slice(-n); if (n === 0) for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) o[k] = []; return o; };
const assertSane = (a, label) => {
  assert.ok(!/NaN|undefined|Infinity|null/.test(a.text), label + "：報告含壞值 → " + (a.text.split("\n").find((l) => /NaN|undefined|Infinity|null/.test(l)) || "").slice(0, 80));
  assert.strictEqual((a.text.match(/^=== /gm) || []).length, 31, label + "：段落數"); assert.ok(a.scored.score >= 0 && a.scored.score <= 100, label);
  assert.ok(["偏多", "偏空", "中性"].includes(a.stance), label); assert.ok(isFinite(a.quote.price) && a.quote.price > 0, label + "：報價");
  JSON.stringify(a, (k, v) => { if (typeof v === "number" && !isFinite(v)) throw new Error(label + "：欄位 " + k + " 不是有限數值"); return v; });
};
test("歷史長度 0／20／45／100／230／260／完整：分析都不得崩潰", async () => {
  const U = require("../src/util");
  for (const n of [0, 20, 45, 100, 230, 260, 1300]) for (const code of ["2330", "0050"]) {
    U._test_clear(); // 避開 3 分鐘分析快取
    const a = await analyzeFn(srcWith({ getHistory: cutHist(n) }), code).catch((e) => { throw new Error(`n=${n} ${code}: ${e.message}`); });
    assertSane(a, `n=${n} ${code}`);
    if (n < 30) { assert.strictEqual(a.indicators, null, `n=${n}：K 線不足 30 根時不計算指標`); assert.strictEqual(a.quant, null); }
    if (n >= 60) assert.ok(a.quant.risk, `n=${n}`); else if (a.quant) assert.strictEqual(a.quant.risk, null, `n=${n}：不足 60 根不得產生風險指標`);
    if (a.quant && n < 220) assert.strictEqual(a.quant.trend, null); if (a.quant && n < 250) assert.strictEqual(a.quant.events, null);
  }
});
test("個別資料源失敗、回空值或額度用盡：其餘段落照常產生", async () => {
  const quota = async () => { throw Object.assign(new Error("FinMind 請求額度已用盡"), { quota: true }); }, boom = async () => { throw new Error("upstream 500"); }, nul = async () => null, empty = async () => [];
  const keys = ["getChip", "getMargin", "getRevenue", "getPER", "getFinancials", "getBalance", "getDividends", "getHolding", "getNews", "getIndex", "getQuote", "getSplitMap", "getCapitalReductions"];
  for (const k of keys) for (const [name, fn] of [["quota", quota], ["throw", boom], ["null", nul]]) {
    const U = require("../src/util"); U._test_clear && U._test_clear();
    const a = await analyzeFn(srcWith({ [k]: k === "getNews" && name === "null" ? empty : fn }), "2330"); assertSane(a, `${k}=${name}`);
    if (name === "quota" && !["getQuote", "getSplitMap", "getCapitalReductions"].includes(k)) assert.ok(a.missing.some((m) => /額度/.test(m)), `${k} 額度用盡應提示`);
  }
  const U = require("../src/util"); U._test_clear && U._test_clear();
  const all = {}; for (const k of keys) all[k] = quota; const a = await analyzeFn(srcWith(all), "2330"); assertSane(a, "全部個股資料源額度用盡"); assert.strictEqual(a.adjust.dividendsAvailable, false);
});
test("停牌或無最新成交（全市場快照查不到）：以歷史最後一根為準，不得當成 0", async () => {
  const U = require("../src/util"); U._test_clear && U._test_clear();
  const s = srcWith({ getQuote: async () => null, getMarketSnapshot: async () => { const m = await demo.getMarketSnapshot(), x = new Map(m.stocks); x.delete("2330"); return { stocks: x }; } });
  const a = await analyzeFn(s, "2330"); assertSane(a, "停牌"); const h = await demo.getHistory("2330", "2000-01-01"); assert.strictEqual(a.quote.price, h.closes[h.closes.length - 1]); assert.strictEqual(a.sector, null);
  U._test_clear && U._test_clear();
  await assert.rejects(() => analyzeFn(srcWith({ getQuote: async () => null, getHistory: cutHist(0), getMarketSnapshot: async () => ({ stocks: new Map() }) }), "2330"), (e) => e.status === 404, "完全沒有資料時應回 404 而不是空報告");
});
test("示範來源涵蓋的所有標的：分析與七種掃描的不變條件", async () => {
  const U = require("../src/util"); U._test_clear && U._test_clear();
  const snap = await demo.getMarketSnapshot();
  for (const code of snap.stocks.keys()) { const a = await analyzeFn(demo, code); assertSane(a, code); assert.strictEqual(a.indicators.close, a.quote.price, code + "：指標現價＝報價"); assert.ok(a.quant.turtle.hi20 > 0); }
  for (const mode of ["volume", "change", "drop", "momentum", "limitup", "disposition", "sector"]) { const r = await runScan(demo, { mode, limit: 30, universe: "all" }); JSON.stringify(r, (k, v) => { if (typeof v === "number" && !isFinite(v)) throw new Error(mode + " " + k); return v; }); }
});
test("/history 契約：無股數變動時與原始資料逐值相同；有官方分割時回傳還原價並標示", async () => {
  const { server } = require("../server"); await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  try {
    const j = await (await fetch(`http://localhost:${port}/history?code=2330&start=2024-01-01&end=2030-01-01`)).json(), raw = await demo.getHistory("2330", "2024-01-01", "2030-01-01");
    for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) assert.deepStrictEqual(j[k], raw[k], k); assert.deepStrictEqual(j.splitAdjusted, []);
    const bad = await fetch(`http://localhost:${port}/history?code=abc`); assert.strictEqual(bad.status, 400);
    const lite = await (await fetch(`http://localhost:${port}/scan?mode=volume&limit=10&lite=1`)).json(); assert.strictEqual(lite.stocks.length, 10);
    const full = await (await fetch(`http://localhost:${port}/scan?mode=volume&limit=5`)).json(); assert.ok(full.stocks[0].score !== undefined, "不帶 lite 時維持原本含評分的回應");
  } finally { await new Promise((r) => server.close(r)); }
});

test("掃描：近期有官方分割的股票，技術面評分不得被假崩盤影響；其他股票不受影響", async () => {
  const U = require("../src/util"), code = "2330";
  U._test_clear(); const base = await runScan(demo, { mode: "volume", limit: 30 }), want = base.stocks.find((s) => s.code === code);
  // 把同一檔股票的歷史「人為一拆五」：分割日之前的價格 ×5、成交量 ÷5，並提供對應的官方公告
  const splitSrc = srcWith({
    getHistory: async (c, s, e) => { const h = await demo.getHistory(c, s, e); if (c !== code) return h; const k = h.dates.length - 40, o = { code: c, dates: h.dates };
      for (const f of ["opens", "highs", "lows", "closes"]) o[f] = h[f].map((x, i) => (i < k ? x * 5 : x)); o.volumes = h.volumes.map((x, i) => (i < k ? x / 5 : x)); o._k = k; return o; },
    getSplitMap: async () => { const h = await demo.getHistory(code, "2000-01-01"), k = h.dates.length - 40; return new Map([[code, [{ date: h.dates[k], before: h.closes[k - 1] * 5, after: h.closes[k - 1], type: "分割" }]]]); },
  });
  U._test_clear(); const got = await runScan(splitSrc, { mode: "volume", limit: 30 }), g = got.stocks.find((s) => s.code === code);
  assert.strictEqual(g.techScore, want.techScore, "有官方公告時，還原後的技術面評分應與未分割時相同"); assert.strictEqual(g.volScore, want.volScore);
  for (const s of got.stocks) if (s.code !== code) assert.deepStrictEqual(s, base.stocks.find((x) => x.code === s.code), s.code + " 不應受影響");
  // 沒有公告（清單取不到）時：不還原、也不崩潰
  U._test_clear(); const noList = await runScan(srcWith({ getHistory: splitSrc.getHistory, getSplitMap: async () => { throw new Error("down"); } }), { mode: "volume", limit: 30 });
  assert.ok(noList.stocks.find((s) => s.code === code));
});

// ── 2026-11-17 獨立實測問題的回歸測試 ──
const R = require("../src/report");
test("報價合併：不同日期的欄位不得混成同一筆（前一日成交金額配上當日價格）", async () => {
  const U = require("../src/util"); U._test_clear();
  const snap = await demo.getMarketSnapshot(), row = snap.stocks.get("1301"), h = await demo.getHistory("1301", "2000-01-01"), last = h.dates[h.dates.length - 1];
  // 快照停在前一交易日（成交金額 180 億），即時報價已是當日
  const older = Object.assign({}, row, { date: h.dates[h.dates.length - 2], value: 18e9, price: 76.6 });
  const live = { code: "1301", name: "台塑", market: "上市", price: 69, prevClose: 76.6, change: -7.6, changePct: -9.92, open: 70, high: 71, low: 69, volume: 152791, date: last, time: last + " 13:30:00", realtime: false };
  const a = await analyzeFn(srcWith({ getMarketSnapshot: async () => ({ stocks: new Map([...snap.stocks].map(([k, v]) => [k, k === "1301" ? older : v])) }), getQuote: async () => live }), "1301");
  assert.strictEqual(a.quote.price, 69); assert.strictEqual(a.quote.date, last);
  assert.strictEqual(a.quote.value, null, "前一日的成交金額不得當成當日金額"); assert.ok(/尚未取得/.test(a.text));
  assert.ok(a.quote.staleSources.some((x) => x.date === older.date));
  // 快照與即時報價同一天：成交金額可用，且標示來源與日期
  U._test_clear(); const same = Object.assign({}, row, { date: last, value: 10.879e9 });
  const b = await analyzeFn(srcWith({ getMarketSnapshot: async () => ({ stocks: new Map([...snap.stocks].map(([k, v]) => [k, k === "1301" ? same : v])) }), getQuote: async () => live }), "1301");
  assert.strictEqual(b.quote.value, 10.879e9); assert.ok(/OpenAPI/.test(b.quote.valueSource));
  // 沒有即時報價、快照比日 K 舊：以日 K 為準，報價與指標的現價一致
  U._test_clear(); const c = await analyzeFn(srcWith({ getQuote: async () => null, getMarketSnapshot: async () => ({ stocks: new Map([...snap.stocks].map(([k, v]) => [k, k === "1301" ? older : v])) }) }), "1301");
  assert.strictEqual(c.quote.price, h.closes[h.closes.length - 1]); assert.strictEqual(c.indicators.close, c.quote.price);
});
test("一年報酬全站同一口徑（250 個交易日），並標示起訖日", async () => {
  const U = require("../src/util"); U._test_clear();
  for (const code of ["2330", "0050"]) {
    const a = await analyzeFn(demo, code), r = a.quant.rs.find((x) => x.k === 250);
    assert.ok(r.from && r.to && r.days === 250); assert.strictEqual(a.indicators.ret250 !== undefined, true);
    assert.ok(Math.abs(a.indicators.ret250 - r.ret) < 0.01, "指標與多週期績效的一年報酬必須相同");
    for (const l of a.text.split("\n").filter((x) => /近 250 個交易日報酬/.test(x))) assert.ok(l.includes(pc2(r.ret)), l);
    assert.ok(!/近一年報酬/.test(a.text), "不得再出現未定義期間的「近一年報酬」");
  }
});
const pc2 = (v) => (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
test("公司行動：績效期間內有無法解釋的跳動時不計算，也不產生相對強弱", () => {
  const h = flat(300, (i) => (i < 200 ? 100 : 25)), rs = Q.relStrength(h, null, null, [{ date: h.dates[200], movePct: -75 }]);
  const y = rs.find((x) => x.k === 250); assert.strictEqual(y.ret, null); assert.strictEqual(y.excess, null); assert.ok(/無法可靠計算/.test(y.note));
  assert.ok(rs.find((x) => x.k === 20).ret !== null, "不含跳動的短期間照常計算");
});
test("支撐與壓力方向：高於現價的均線不得寫成「向下看是否守住」", async () => {
  const U = require("../src/util");
  for (const code of (await demo.getMarketSnapshot()).stocks.keys()) {
    U._test_clear(); const a = await analyzeFn(demo, code), P = a.indicators.close, l = a.text.split("\n").find((x) => x.startsWith("【觀察重點】"));
    const down = l.match(/向下看 ([\d,.]+)/), up = l.match(/向上看 ([\d,.]+)/), n = (x) => +x.replace(/,/g, "");
    if (down) assert.ok(n(down[1]) < P, `${code}：向下看 ${down[1]} 應低於現價 ${P}`); if (up) assert.ok(n(up[1]) > P, `${code}：向上看 ${up[1]} 應高於現價 ${P}`);
    if (a.indicators.ma5 > P) assert.ok(/需要收復的壓力/.test(l), code + "：MA5 在現價之上時應說明是壓力");
  }
});
test("趨勢模板：逐項結果、符合數與結論一致；關鍵條件未過不得稱為成立", async () => {
  const U = require("../src/util");
  for (const code of (await demo.getMarketSnapshot()).stocks.keys()) {
    U._test_clear(); const a = await analyzeFn(demo, code), tr = a.quant.trend; if (!tr) continue;
    const sec = a.text.split("=== 趨勢結構檢核\n")[1].split("\n\n=== ")[0];
    if (tr.passed === 8) assert.ok(/八項全部符合/.test(sec)); else assert.ok(!/八項全部符合|結構完整/.test(sec), code + " 未全數符合卻稱完整");
    if (tr.checks.slice(0, 3).some((c) => c.pass === false)) assert.ok(/關鍵條件未成立/.test(sec) && !/大致成立/.test(sec), code);
  }
});
test("條件四態：任一子條件未符合即未符合，不因另一項缺值變成未知", () => {
  assert.strictEqual(R.andState(false, null), false); assert.strictEqual(R.andState(true, null), null);
  assert.strictEqual(R.andState(true, true), true); assert.strictEqual(R.andState("na", true), "na"); assert.strictEqual(R.andState("na", false), false);
});
test("類別計票：高度相關的價格指標不得重複計票壓過基本面與籌碼（反例）", () => {
  // 舊規則逐項計票：價格 4 項＋動能 2 項＝6 多，基本面 2 項＋籌碼 1 項＝3 空 → 淨 +3 → 判為「偏多」
  const groups = [["價格趨勢", [[1, "站上月線"], [1, "站上季線"], [1, "多頭排列"], [1, "趨勢模板"]]], ["動能", [[1, "MACD"], [1, "KD"]]], ["基本面", [[-1, "營收年減"], [-1, "EPS 年減"]]], ["籌碼", [[-1, "法人賣超"]]]];
  const flatNet = groups.reduce((t, g) => t + g[1].reduce((u, x) => u + x[0], 0), 0); assert.strictEqual(flatNet, 3);
  const v = R.voteCategories(groups); assert.strictEqual(v.bull, 2); assert.strictEqual(v.bear, 2); assert.strictEqual(v.conflict, true); assert.strictEqual(v.stance, "中性");
  assert.strictEqual(R.voteCategories([["價格趨勢", [[1, "a"]]], ["籌碼", [[1, "b"]]], ["基本面", [[-1, "c"]]]]).stance, "中性");
  assert.strictEqual(R.voteCategories([["價格趨勢", [[1, "a"]]], ["籌碼", [[1, "b"]]], ["基本面", [[1, "c"]]], ["大盤", [[-1, "d"]]]]).stance, "偏多");
});
test("CAN SLIM：本季虧損是「未符合」、負基期是「不適用」、ROE 未達門檻即「未符合」", async () => {
  const U = require("../src/util"), base = await demo.getFinancials("2330");
  const run = async (lastEps, prevYearEps, roeLow) => { U._test_clear(); const q = base.map((x) => Object.assign({}, x)); q[q.length - 1].eps = lastEps; q[q.length - 5].eps = prevYearEps;
    if (roeLow) for (const x of q) x.netInc = Math.abs(x.netInc) * 0.01;
    const a = await analyzeFn(srcWith({ getFinancials: async () => q }), "2330"); const rows = a.text.split("\n"); return { C: rows.find((l) => l.startsWith("| C 當季獲利")), A: rows.find((l) => l.startsWith("| A 年度獲利")), a }; };
  let r = await run(-0.33, 1.2); assert.ok(/虧損/.test(r.C) && /未符合/.test(r.C), r.C); assert.ok(!/無財報資料/.test(r.C));
  r = await run(0.93, -0.12); assert.ok(/不適用/.test(r.C), r.C); assert.ok(/比較基期/.test(r.a.fundamentals.epsYoYNote));
  r = await run(5, 1, true); assert.ok(/未符合/.test(r.A), "ROE 低於門檻時整項應為未符合：" + r.A);
});
test("歷史訊號統計：用語、成熟樣本與目前狀態", async () => {
  const U = require("../src/util"); U._test_clear(); const a = await analyzeFn(demo, "2330"), sec = a.text.split("=== 歷史訊號統計\n")[1].split("\n\n=== ")[0];
  assert.ok(!/上漲機率/.test(a.text), "不得使用「上漲機率」"); assert.ok(/歷史上漲比例/.test(sec) && /毛報酬/.test(sec) && /樣本外驗證/.test(sec));
  assert.ok(!/任何訊號都只是把機率/.test(a.text)); assert.ok(!/超出這個範圍代表/.test(a.text));
  for (const e of a.quant.events.events) { assert.ok(Array.isArray(e.pending) && e.pending.length === 3); assert.ok(e.pending[0] <= e.pending[2]); }
});
test("評分覆蓋：ETF 的不適用項目不計分、不縮小分母，分數本身不變", async () => {
  const U = require("../src/util"); U._test_clear(); const e = await analyzeFn(demo, "0050"), s = await analyzeFn(demo, "2330");
  assert.strictEqual(e.scored.applicable, 60); assert.ok(e.scored.naKeys.includes("rev_yoy")); assert.ok(e.scored.known <= 60);
  assert.strictEqual(s.scored.applicable, 100); assert.strictEqual(s.scored.naKeys.length, 0);
  const d = e.scored.detail; assert.strictEqual(e.scored.score, d._fund + d._tech + d._vol + d._chip + d._margin + d._theme);
});
test("部位試算：停損價取到合法升降單位", () => {
  const { roundTick } = require("../src/scoring");
  assert.strictEqual(roundTick(2087.25, false, -1), 2085); assert.strictEqual(roundTick(81.69, false, -1), 81.6); assert.strictEqual(roundTick(31.04, false, -1), 31);
  const z = Q.sizing(2170, 78.97, [], 1000000, 1, (x) => roundTick(x, false, -1)); for (const r of z) assert.strictEqual(r.stop % 5, 0, "千元以上股票升降單位為 5 元");
});
test("掃描回應附上資料日期與排序條件", async () => {
  const U = require("../src/util"); U._test_clear();
  for (const mode of ["volume", "momentum", "sector", "disposition"]) { const r = await runScan(demo, { mode, limit: 5 }); assert.ok(r.asOf && r.basis, mode); }
});
// 回測引擎在瀏覽器執行；以 vm 載入同一份檔案測試
const vmLoad = () => { const vm = require("vm"), fs = require("fs"), ctx = { console, localStorage: { getItem: () => null }, Math, Date, JSON, Array, Object, Number, String, isNaN, isFinite, parseInt, parseFloat, Infinity, NaN, Error, Float64Array, Map, Set };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(require("path").join(__dirname, "../../frontend/js/bt-core.js"), "utf8") + ";this.run=runBacktestEngine;", ctx); return ctx; };
test("回測：只選一年時仍可交易（舊版固定暖機 250 根導致零交易）；資金不足一張時明確說明", async () => {
  const B = vmLoad(), h = await demo.getHistory("2603", "2000-01-01"), k = h.dates.length - 242, d = { code: "2603" };
  for (const f of ["dates", "opens", "highs", "lows", "closes", "volumes"]) d[f] = h[f].slice(k);
  const cfg = (cap) => ({ code: "2603", capital: cap, execType: "open", positionBase: "equity", posSize: 100, stopLoss: 8, stopProfit: 25, scoreThreshold: 1, longEntry: [{ id: "ma_golden", params: { fast: 5, slow: 20 } }], longExit: [{ id: "ma_death", params: { fast: 5, slow: 20 } }], shortEnabled: false, shortEntry: [], shortExit: [] });
  const r = B.run(JSON.parse(JSON.stringify(d)), cfg(5000000));
  assert.strictEqual(r.diag.warmup, 21); assert.ok(r.diag.entrySignals > 0); assert.ok(r.metrics.tradeCount > 0, "一年區間應有交易");
  const first = r.trades[0], i = d.dates.indexOf(first.date); assert.strictEqual(first.price, d.opens[i], "隔日開盤模式以開盤價成交");
  const poor = B.run(JSON.parse(JSON.stringify(d)), cfg(1000)); assert.strictEqual(poor.metrics.tradeCount, 0); assert.ok(poor.diag.rejectedCash > 0 && poor.diag.minCashNeeded > 1000);
  // 舊格式（只有策略代號、沒有參數）維持舊的 250 根暖機
  assert.strictEqual(B.run(JSON.parse(JSON.stringify(d)), Object.assign(cfg(5000000), { longEntry: ["ma_golden"], longExit: ["ma_death"] })).diag.warmup, 251);
});
test("回測：買進張數把手續費算進去，不會因股款＋手續費超過現金而靜默拒絕", async () => {
  const B = vmLoad(), d = flat(80, (i) => (i < 40 ? 100 : 100 + (i - 39))); d.code = "T"; d.opens = d.closes.slice(); d.highs = d.closes.slice(); d.lows = d.closes.slice();
  const r = B.run(JSON.parse(JSON.stringify(d)), { code: "T", capital: 100000, execType: "close", positionBase: "equity", posSize: 100, scoreThreshold: 1, longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [], shortEnabled: false, shortEntry: [], shortExit: [] });
  // 股價 100 元、本金 10 萬：不含手續費會算成 1 張（10 萬元＋142.5 元手續費 > 10 萬 → 被拒）；含手續費則正確算成 0 張並列入資金不足
  assert.strictEqual(r.trades.filter((t) => t.type === "entry").length, 0); assert.ok(r.diag.rejectedCash > 0);
});
