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
test("歷史訊號統計：進場用隔日開盤、不輸出沒有根據的顯著性、樣本少要標示", async () => {
  const h = await demo.getHistory("2330", "2019-01-01"), ev = Q.eventStudy(h);
  // 前視偏誤檢查：把「訊號日之後」的價格全部改掉，訊號日期本身不能改變
  const cut = 900, h2 = { code: h.code, dates: h.dates.slice(0, cut), opens: h.opens.slice(0, cut), highs: h.highs.slice(0, cut), lows: h.lows.slice(0, cut), closes: h.closes.slice(0, cut), volumes: h.volumes.slice(0, cut) };
  const e2 = Q.eventStudy(h2);
  for (const e of ev.events) { const x = e2.events.find((y) => y.key === e.key); assert.ok(x.count <= e.count, e.key + "：截斷資料後事件數不應變多"); }
  // 沒有有效的顯著性檢定：不得輸出 t 值或強弱分級，一律標示未驗證；只保留描述統計
  for (const e of ev.events) for (const x of e.h) { assert.strictEqual(x.significance, "unverified"); assert.strictEqual(x.t, undefined); assert.strictEqual(x.grade, undefined);
    if (x.n) { assert.ok(x.nonOverlap <= x.n); assert.strictEqual(x.smallSample, x.nonOverlap < 10); } }
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
  assert.strictEqual(e.scored.applicable, 70); assert.ok(e.scored.naKeys.includes("rev_yoy")); assert.ok(!e.scored.naKeys.includes("margin_health"), "ETF 可融資，融資不是不適用"); assert.ok(e.scored.known <= 70);
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
  const cfg = (cap) => ({ code: "2603", corpChecked: true, capital: cap, execType: "open", positionBase: "equity", posSize: 100, stopLoss: 8, stopProfit: 25, scoreThreshold: 1, longEntry: [{ id: "ma_golden", params: { fast: 5, slow: 20 } }], longExit: [{ id: "ma_death", params: { fast: 5, slow: 20 } }], shortEnabled: false, shortEntry: [], shortExit: [] });
  const r = B.run(JSON.parse(JSON.stringify(d)), cfg(5000000));
  assert.strictEqual(r.diag.warmup, 21); assert.ok(r.diag.entrySignals > 0); assert.ok(r.metrics.tradeCount > 0, "一年區間應有交易");
  const first = r.trades[0], i = d.dates.indexOf(first.date); assert.strictEqual(first.price, d.opens[i], "隔日開盤模式以開盤價成交");
  const poor = B.run(JSON.parse(JSON.stringify(d)), cfg(1000)); assert.strictEqual(poor.metrics.tradeCount, 0); assert.ok(poor.diag.rejectedCash > 0 && poor.diag.minCashNeeded > 1000);
  // 拒單所需金額：最小與最大值分別等於各次拒單「一張含費」金額的最小與最大（舊版只記最大值卻寫成「約需」）
  const need = poor.diag.entryLog.filter((e) => !e.filled).map((e) => e.perLot);
  assert.ok(need.length >= 2); assert.strictEqual(poor.diag.minCashNeeded, Math.min(...need)); assert.strictEqual(poor.diag.maxCashNeeded, Math.max(...need));
  // 舊格式（只有策略代號、沒有參數）維持舊的 250 根暖機
  assert.strictEqual(B.run(JSON.parse(JSON.stringify(d)), Object.assign(cfg(5000000), { longEntry: ["ma_golden"], longExit: ["ma_death"] })).diag.warmup, 251);
});
test("回測：買進張數把手續費算進去，不會因股款＋手續費超過現金而靜默拒絕", async () => {
  const B = vmLoad(), d = flat(80, (i) => (i < 40 ? 100 : 100 + (i - 39))); d.code = "T"; d.opens = d.closes.slice(); d.highs = d.closes.slice(); d.lows = d.closes.slice();
  const r = B.run(JSON.parse(JSON.stringify(d)), { code: "T", corpChecked: true, capital: 100000, execType: "close", positionBase: "equity", posSize: 100, scoreThreshold: 1, longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [], shortEnabled: false, shortEntry: [], shortExit: [] });
  // 股價 100 元、本金 10 萬：不含手續費會算成 1 張（10 萬元＋142.5 元手續費 > 10 萬 → 被拒）；含手續費則正確算成 0 張並列入資金不足
  assert.strictEqual(r.trades.filter((t) => t.type === "entry").length, 0); assert.ok(r.diag.rejectedCash > 0);
});

// ── 監督審查（第一輪）回歸測試 ──
const btCfg = (o) => Object.assign({ code: "T", corpChecked: true /* 人工測試資料：明確標示公司行動已檢查 */, capital: 1000000, execType: "open", positionBase: "equity", posSize: 100, scoreThreshold: 1, longEntry: [{ id: "ma_golden", params: { fast: 5, slow: 20 } }], longExit: [{ id: "ma_death", params: { fast: 5, slow: 20 } }], shortEnabled: false, shortEntry: [], shortExit: [] }, o);
const ohlc = (closes, opens) => { const d = flat(closes.length, (i) => closes[i]); d.code = "T"; d.opens = opens ? opens.slice() : closes.slice(); d.highs = d.closes.map((c, i) => Math.max(c, d.opens[i])); d.lows = d.closes.map((c, i) => Math.min(c, d.opens[i])); return d; };
test("回測會計：期末權益變動＝已實現淨損益合計（舊版每筆多扣一次進場手續費）", async () => {
  const B = vmLoad(), h = await demo.getHistory("2603", "2000-01-01"), d = { code: "2603" }; for (const f of ["dates", "opens", "highs", "lows", "closes", "volumes"]) d[f] = h[f].slice(-500);
  for (const execType of ["open", "close"]) {
    const r = B.run(JSON.parse(JSON.stringify(d)), btCfg({ code: "2603", capital: 5000000, execType, stopLoss: 8, stopProfit: 25 }));
    const closed = r.trades.filter((t) => t.type === "exit"), sum = closed.reduce((t, x) => t + x.netPnl, 0); assert.ok(closed.length > 0);
    if (!r.diag.openAtEnd) assert.ok(Math.abs(r.metrics.finalEquity - 5000000 - sum) < 1e-6, `${execType}：權益變動 ${r.metrics.finalEquity - 5000000} ≠ 淨損益合計 ${sum}`);
  }
  // 持倉中：權益＝現金＋持股市值（以收盤價計），進場手續費只扣一次
  const c = Array.from({ length: 60 }, (_, i) => (i < 30 ? 100 : 120)), x = ohlc(c);
  const r = B.run(JSON.parse(JSON.stringify(x)), btCfg({ capital: 1000000, execType: "close", longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] }));
  const e = r.trades.find((t) => t.type === "entry"), fee = e.price * 1000 * e.qty * 0.001425;
  assert.ok(Math.abs(r.equity[r.equity.length - 1] - (1000000 - fee + (120 - e.price) * 1000 * e.qty)) < 1e-6);
});
test("回測停利：開盤觸發就以開盤價成交（舊版開盤觸發、收盤成交）", () => {
  const B = vmLoad(), c = Array.from({ length: 60 }, (_, i) => (i < 30 ? 100 : i < 40 ? 110 : i === 40 ? 112 : 111)), o = c.slice();
  o[40] = 140; // 第 40 天開盤跳空到 140（相對 110 進場 +27%），收盤回落 112
  const r = B.run(JSON.parse(JSON.stringify(ohlc(c, o))), btCfg({ capital: 1000000, execType: "open", stopProfit: 25, longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] }));
  const ex = r.trades.find((t) => t.type === "exit"); assert.strictEqual(ex.reason, "stopProfit"); assert.strictEqual(ex.price, 140, "應以觸發的開盤價成交，而不是收盤價 112");
  const r2 = B.run(JSON.parse(JSON.stringify(ohlc(c, o))), btCfg({ capital: 1000000, execType: "close", stopProfit: 25, longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] }));
  assert.ok(!r2.trades.some((t) => t.reason === "stopProfit"), "收盤模式只看收盤價：112 未達 +25%，不得出場");
});
test("回測期間：用起始日前資料暖機，起始日當天即可交易；績效只算回測期間", () => {
  const B = vmLoad(), c = Array.from({ length: 80 }, (_, i) => (i < 50 ? 100 : 110)), d = ohlc(c), start = d.dates[50];
  const cfg = btCfg({ capital: 1000000, execType: "close", tradeStart: start, longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] });
  const r = B.run(JSON.parse(JSON.stringify(d)), cfg);
  assert.strictEqual(r.trades[0].date, start, "起始日出現訊號就應在起始日成交，不得被暖機跳過"); assert.strictEqual(r.offset, 50);
  assert.strictEqual(r.equity.length, 30); assert.strictEqual(r.dates[0], start); assert.strictEqual(r.diag.startDelayed, false);
  // 起始日前資料不足：明示延後交易
  const r2 = B.run(JSON.parse(JSON.stringify(d)), Object.assign({}, cfg, { tradeStart: d.dates[5] })); assert.strictEqual(r2.diag.startDelayed, true); assert.strictEqual(r2.diag.tradeFrom, d.dates[21]);
});
test("回測：期間內有無法解釋的跳動就拒絕；跳動在回看範圍之前則照常執行", () => {
  const B = vmLoad(), c = Array.from({ length: 120 }, (_, i) => 100 + (i % 7)), d = ohlc(c), cfg = btCfg({ capital: 1000000, execType: "close", tradeStart: d.dates[80], longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] });
  assert.throws(() => B.run(JSON.parse(JSON.stringify(d)), Object.assign({}, cfg, { unexplained: [d.dates[90]] })), /無法可靠回測/);
  assert.throws(() => B.run(JSON.parse(JSON.stringify(d)), Object.assign({}, cfg, { unexplained: [d.dates[70]] })), /無法可靠回測/, "暖機回看範圍內也要拒絕");
  assert.doesNotThrow(() => B.run(JSON.parse(JSON.stringify(d)), Object.assign({}, cfg, { unexplained: [d.dates[30]] })));
});
test("個股分析：有無法解釋的跳動時，價格類計算只用跳動後的資料；長度不足的指標不計算", async () => {
  const U = require("../src/util"); U._test_clear();
  const jump = async (c, s, e) => { const h = await demo.getHistory(c, s, e), k = h.dates.length - 150, o = { code: c, dates: h.dates }; for (const f of ["opens", "highs", "lows", "closes"]) o[f] = h[f].map((x, i) => (i < k ? x * 3 : x)); o.volumes = h.volumes; return o; };
  const a = await analyzeFn(srcWith({ getHistory: jump }), "2330");
  assert.ok(a.adjust.cut && a.adjust.cut.kept === 150, JSON.stringify(a.adjust.cut)); assert.ok(a.adjust.unexplained.length === 1);
  assert.strictEqual(a.indicators.bars, 150); assert.strictEqual(a.quant.rs.find((r) => r.k === 250).ret, null); assert.strictEqual(a.quant.trend, null); assert.strictEqual(a.quant.events, null);
  assert.ok(a.quant.risk && a.quant.risk.days === 149, "風險指標只用跳動後的 150 根"); assert.ok(a.quant.risk.maxDD > -60, "不得出現跨越斷點的假回撤");
  assert.ok(/捨棄之前/.test(a.text)); assert.ok(!/NaN|undefined|Infinity|null/.test(a.text));
  // 跳動後資料不足 30 根：不產生任何技術指標與量化推論
  U._test_clear(); const short = async (c, s, e) => { const h = await jump(c, s, e), k = h.dates.length - 20; for (const f of ["opens", "highs", "lows", "closes"]) h[f] = h[f].map((x, i) => (i < k ? x * 3 : x / 3 * 3)); for (const f of ["opens", "highs", "lows", "closes"]) h[f] = h[f].map((x, i) => (i >= k ? x : x)); const o = Object.assign({}, h); for (const f of ["opens", "highs", "lows", "closes"]) o[f] = h[f].map((x, i) => (i < k ? x * 2 : x)); return o; };
  const b = await analyzeFn(srcWith({ getHistory: short }), "2330"); assert.strictEqual(b.indicators, null); assert.strictEqual(b.quant, null); assert.ok(!/NaN|undefined|Infinity|null/.test(b.text));
});
test("漲跌幅限制依官方基金分類（不依代號字尾）：國內 10%、國內槓桿依倍數、國外成分與國外期貨不設限、無法確認時不聲稱違反", () => {
  // 以下分類欄位取自證交所 OpenAPI t187ap47_L（基金基本資料彙總表，出表日 1151121）的原始內容
  const C = { "0050": { type: "國內成分證券指數股票型基金", foreign: "否", name: "元大台灣卓越50證券投資信託基金" },
    "00631L": { type: "槓桿/反向指數股票型基金", foreign: "否", name: "元大ETF傘型證券投資信託基金之台灣50單日正向2倍證券投資信託基金" },
    "00675L": { type: "槓桿/反向指數股票型基金", foreign: "否", name: "富邦臺灣加權ETF傘型證券投資信託基金之富邦臺灣加權單日正向兩倍證券投資信託基金" },
    "00632R": { type: "槓桿/反向指數股票型基金", foreign: "否", name: "元大ETF傘型證券投資信託基金之台灣50單日反向1倍證券投資信託基金" },
    "00646": { type: "國外成分證券指數股票型基金", foreign: "是", name: "元大標普500傘型證券投資信託基金之標普500證券投資信託基金" },
    "00647L": { type: "槓桿/反向指數股票型基金", foreign: "是", name: "元大標普500傘型證券投資信託基金之標普500單日正向2倍證券投資信託基金" },
    "00635U": { type: "指數股票型期貨信託基金", foreign: "是", name: "元大標普高盛黃金ER指數股票型期貨信託基金" },
    "00670L": { type: "槓桿/反向指數股票型基金", foreign: "是", name: "富邦NASDAQ-100 ETF 傘型證券投資信託基金之富邦NASDAQ-100單日正向兩倍證券投資信託基金" },
    "0061": { type: "連結式證券指數股票型基金", foreign: "是", name: "元大寶來滬深300證券投資信託基金" } };
  const L = (code) => Q.priceLimit(code, C[code]);
  assert.deepStrictEqual([L("2330").limit, L("0050").limit, L("00631L").limit, L("00675L").limit, L("00632R").limit], [0.105, 0.105, 0.205, 0.205, 0.105]);
  for (const c of ["00646", "00647L", "00670L", "00635U"]) { assert.strictEqual(L(c).limit, null, c); assert.strictEqual(L(c).known, true, c); assert.ok(/不設漲跌幅限制/.test(L(c).basis), c); }
  for (const x of [L("0061"), Q.priceLimit("00679B", null), Q.priceLimit("0050", null, "證交所基金分類取得失敗"), Q.priceLimit("020020", null)]) { assert.strictEqual(x.known, false); assert.ok(/分類無法確認/.test(x.basis)); }
  const jump = (pct) => flat(40, (i) => (i < 20 ? 100 : 100 * (1 + pct)));
  const ux = (code, pct, cls) => Q.adjustPrices(jump(pct), [], [], Q.limitOpts(Q.priceLimit(code, cls === undefined ? C[code] : cls))).unexplained;
  // 國內：0050 的 +15% 超過 10% → 無法解釋；國內 2 倍槓桿的 +15% 正常、+25% 無法解釋
  assert.strictEqual(ux("0050", 0.15).length, 1); assert.strictEqual(ux("00631L", 0.15).length, 0); assert.strictEqual(ux("00675L", 0.25).length, 1); assert.strictEqual(ux("2330", 0.15).length, 1);
  // 國外一般、國外槓桿、國外期貨：+15%、+25% 都是合法行情，不得判為異常（舊版 regex 會把 00646 的 +15%、00647L 的 +25% 判為異常）
  for (const c of ["00646", "00647L", "00635U"]) for (const p of [0.15, 0.25, -0.3]) assert.strictEqual(ux(c, p).length, 0, c + " " + p);
  // 分類無法確認：找出超過 10% 的變動但標示 unverified（不聲稱違反）；10% 以內不列
  const u = ux("00679B", 0.15, null); assert.strictEqual(u.length, 1); assert.strictEqual(u[0].unverified, true); assert.strictEqual(ux("00679B", 0.08, null).length, 0);
  assert.strictEqual(ux("0050", 0.15)[0].unverified, undefined);
});
test("股利：從未配息（查無紀錄）不是資料缺漏；取得失敗才是", async () => {
  const U = require("../src/util"); U._test_clear();
  const a = await analyzeFn(srcWith({ getDividends: async () => null }), "2330"); assert.strictEqual(a.adjust.dividendsAvailable, true); assert.ok(a.quant.rs.find((r) => r.k === 20).tr !== null);
  U._test_clear(); const b = await analyzeFn(srcWith({ getDividends: async () => { throw new Error("down"); } }), "2330");
  assert.strictEqual(b.adjust.dividendsAvailable, false); assert.ok(b.quant.rs.every((r) => r.tr === null), "股利取得失敗時不得顯示含息報酬"); assert.ok(/報酬偏低、波動與回撤偏高/.test(b.text));
});
test("ETF：不以股票的 100 分門檻分級，文字不把不適用寫成 0 分", async () => {
  const U = require("../src/util"); U._test_clear(); const e = await analyzeFn(demo, "0050"), s = await analyzeFn(demo, "2330");
  assert.strictEqual(e.scored.grade, "不分級（ETF）"); assert.ok(!/基本面 0\/20|題材 0\/10/.test(e.text)); assert.ok(/基本面 不適用/.test(e.text) && /題材 不適用/.test(e.text) && /ETF 不分級/.test(e.text));
  assert.ok(/融資 資料不足/.test(e.text), "示範資料的 ETF 沒有融資資料：應寫資料不足，而不是 0/10");
  assert.ok(["強勢觀察", "可試單", "等待整理", "不建議"].includes(s.scored.grade), "個股維持原分級");
});
test("/history：回傳公司行動檢查結果；股利取得失敗時標示未檢查，不冒然判定", async () => {
  const { server } = require("../server"); await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const U = require("../src/util"), keep = { s: demo.getSplitMap, d: demo.getDividends }, get = async () => (await fetch(`http://localhost:${port}/history?code=2330&start=2024-01-01&end=2030-01-01`)).json();
  try { const j = await get(); assert.ok(Array.isArray(j.unexplained)); assert.strictEqual(j.checkNote, null);
    // 兩個來源都失敗：兩項都要列出，不能只列第一個
    demo.getSplitMap = async () => { throw new Error("quota"); }; demo.getDividends = async () => { throw new Error("quota"); }; U._test_clear();
    let k = await get(); assert.strictEqual(k.unexplained, null); assert.ok(/股數變動清單/.test(k.checkNote) && /股利紀錄/.test(k.checkNote), k.checkNote);
    demo.getSplitMap = keep.s; U._test_clear(); k = await get(); assert.strictEqual(k.unexplained, null); assert.ok(!/股數變動清單/.test(k.checkNote) && /股利紀錄/.test(k.checkNote)); }
  finally { demo.getSplitMap = keep.s; demo.getDividends = keep.d; U._test_clear(); await new Promise((r) => server.close(r)); }
});

test("不變式：標為不適用的項目得分必須為 0（以真實結構的 ETF 融資資料驗證）", async () => {
  const S2 = require("../src/scoring"), snap = { isETF: true, changePct: 1, margin: { bal: 1000, prev: 1200, limit: 100000 } }; // ETF 有融資資料
  const sc = S2.scoreStock({ snap, ind: null, fund: {}, sector: null });
  for (const k of sc.naKeys) assert.ok(sc.detail[k] === "—" || sc.detail[k] === "0", k + " 不適用卻得分：" + sc.detail[k]);
  assert.ok(sc.detail._margin > 0, "ETF 的融資資料應計分"); assert.ok(!sc.naKeys.includes("margin_health"));
});

test("報告不得引用沒有根據的統計證據（顯著、校正後門檻、強／弱證據）", async () => {
  const U = require("../src/util");
  for (const code of ["2330", "2603", "0050"]) { U._test_clear(); const a = await analyzeFn(demo, code);
    assert.ok(!/達校正後門檻|弱（未校正）|與基準無法區分|證據：/.test(a.text), code); assert.ok(/顯著性未驗證|未驗證/.test(a.text)); assert.ok(!/獨立樣本|獨立 \d+ 次/.test(a.text), code + "：不重疊不等於獨立"); }
});
test("資料不足 250 根：52 週、250 日波動與趨勢模板第 6、7 項不計算，其他指標以實際天數標示", async () => {
  const U = require("../src/util"); U._test_clear(); const a = await analyzeFn(srcWith({ getHistory: cutHist(230) }), "2330");
  assert.strictEqual(a.indicators.hi250, null); assert.strictEqual(a.indicators.pos250, null); assert.strictEqual(a.quant.risk.vol250, null);
  assert.strictEqual(a.quant.trend.checks[5].pass, null); assert.strictEqual(a.quant.trend.checks[6].pass, null);
  assert.ok(/52 週區間 \| 資料不足/.test(a.text)); assert.ok(!/— ~ —/.test(a.text), "不足 250 根時不得出現空白區間"); assert.ok(a.text.includes(`近 ${a.quant.risk.days} 個交易日最大回撤`)); assert.ok(!/一年最大回撤|（一年）/.test(a.text));
});
test("Codex 反例 B／C：停利以觸發價成交；移動停損讀取物件形式與參數（多空、開盤與收盤模式）", () => {
  const B = vmLoad(), mk = (c, o) => { const d = ohlc(c, o); return JSON.parse(JSON.stringify(d)); };
  // B：100 元進場，次日開盤 130、收盤 90，停利 25%：舊版以 90 元出場、理由仍是停利（淨損 -94,866.75）
  let c = Array(60).fill(90).concat([100, 90, 90]), o = c.slice(); c[59] = 95; o[60] = 100; o[61] = 130;
  let r = B.run(mk(c, o), btCfg({ execType: "open", stopProfit: 25, longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] }));
  let x = r.trades.find((t) => t.type === "exit"); assert.strictEqual(x.price, 130); assert.strictEqual(x.reason, "stopProfit"); assert.ok(x.netPnl > 0);
  c = Array(60).fill(110).concat([100, 110, 110]); o = c.slice(); c[59] = 105; o[60] = 100; o[61] = 70;
  r = B.run(mk(c, o), btCfg({ execType: "open", stopProfit: 25, longEntry: [], longExit: [], shortEnabled: true, shortEntry: [{ id: "s_price_below_ma", params: { period: 20 } }], shortExit: [] }));
  x = r.trades.find((t) => t.type === "exit"); assert.strictEqual(x.price, 70); assert.ok(x.netPnl > 0);
  // C：收盤升到 120 再跌到 108，移動停損 8%（物件形式）→ 108 ≤ 120×0.92 出場；5%、10% 驗證有讀參數
  c = Array(60).fill(90).concat([100, 110, 120, 108, 108]); c[59] = 100;
  const trail = (pct) => B.run(mk(c), btCfg({ execType: "close", longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [{ id: "trailing_stop", params: { pct } }] }));
  x = trail(8).trades.find((t) => t.type === "exit"); assert.strictEqual(x.reason, "trailingStop"); assert.strictEqual(x.price, 108);
  assert.ok(trail(10).trades.find((t) => t.type === "exit"), "10%：108 ≤ 120×0.9=108 → 出場"); assert.ok(!trail(12).trades.find((t) => t.type === "exit"), "12%：108 > 105.6 → 不出場");
  // 空單
  c = Array(60).fill(110).concat([100, 90, 80, 87, 87]); c[59] = 100;
  r = B.run(mk(c), btCfg({ execType: "close", longEntry: [], longExit: [], shortEnabled: true, shortEntry: [{ id: "s_price_below_ma", params: { period: 20 } }], shortExit: [{ id: "s_trailing", params: { pct: 8 } }] }));
  x = r.trades.find((t) => t.type === "exit"); assert.strictEqual(x.reason, "trailingStop"); assert.strictEqual(x.price, 87);
  // open 模式時間順序：開盤 112 時只知道最高收盤 120（回撤 6.7% 未達 8%），不得用當日收盤 100 提前觸發；隔日開盤 100 才出場
  c = Array(60).fill(90).concat([100, 110, 120, 100, 100, 100]); o = c.slice(); c[59] = 95; o[60] = 100; o[63] = 112; o[64] = 100;
  r = B.run(mk(c, o), btCfg({ execType: "open", longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [{ id: "trailing_stop", params: { pct: 8 } }] }));
  x = r.trades.find((t) => t.type === "exit"); assert.strictEqual(x.date, o.length ? ohlc(c, o).dates[64] : null); assert.strictEqual(x.price, 100);
});
test("Codex 反例 D：80 根人工日 K 從 100 跳到 50（查無公告），不得輸出跨越斷點的風險指標", async () => {
  const U = require("../src/util"); U._test_clear();
  const src = srcWith({ getHistory: async (c) => { const h = flat(80, (i) => (i < 40 ? 100 : 50)); h.code = c; h.volumes = h.closes.map(() => 1e6); return h; }, getQuote: async () => null,
    getMarketSnapshot: async () => ({ stocks: new Map() }) });
  const a = await analyzeFn(src, "2330"); assert.strictEqual(a.adjust.unexplained.length, 1); assert.strictEqual(a.adjust.cut.kept, 40);
  assert.ok(a.quant === null || a.quant.risk === null, "跳動後只有 40 根（<60），風險指標不得計算"); assert.ok(!/-50/.test(JSON.stringify(a.quant && a.quant.risk)));
  // 掃描路徑：跳動序列（前 150 根 0.45p，之後 50 根緩升到快照價 p）的評分，必須等於只給跳動後 50 根的評分
  const snap = await demo.getMarketSnapshot(), p = (c) => snap.stocks.get(c).price;
  const jump = (c) => { const h = flat(200, (i) => (i < 150 ? 0.45 * p(c) : p(c) * (0.9 + 0.1 * (i - 150) / 49))); h.code = c; h.volumes = h.closes.map(() => 1e6); return h; };
  const post = (c) => { const h = jump(c); for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) h[k] = h[k].slice(150); return h; };
  const cols = (r) => r.stocks.map((x) => [x.code, x.techScore, x.volScore, x.score].join(":"));
  U._test_clear(); const r1 = await runScan(srcWith({ getHistory: async (c) => jump(c) }), { mode: "volume", limit: 8 });
  U._test_clear(); const r2 = await runScan(srcWith({ getHistory: async (c) => post(c) }), { mode: "volume", limit: 8 });
  assert.strictEqual(r1.stocks.length, 8); assert.deepStrictEqual(cols(r1), cols(r2));
});
test("回測期間內有官方股數變動：診斷要揭露換算單位（變動前的張數不是當時可交易的整張）", () => {
  const B = vmLoad(), c = Array.from({ length: 120 }, (_, i) => 100 + (i % 20 < 10 ? i % 20 : 20 - (i % 20))), d = ohlc(c), mid = d.dates[90], early = d.dates[10];
  const sa = [{ date: mid, ratio: 4.0002, type: "分割", before: 188.65, after: 47.16, official: true }];
  let r = B.run(JSON.parse(JSON.stringify(d)), btCfg({ tradeStart: d.dates[60], splitAdjusted: sa }));
  const J = (x) => JSON.parse(JSON.stringify(x)); // 引擎在 vm 中執行，物件原型不同
  assert.deepStrictEqual(J(r.diag.shareChanges), [{ date: mid, type: "分割", ratio: 4.0002, before: 188.65, after: 47.16 }]); assert.ok(r.diag.entriesBeforeShareChange > 0, "測試資料要有變動前的進場");
  assert.strictEqual(r.diag.entriesBeforeShareChange, r.trades.filter((t) => t.type === "entry" && t.date < mid).length);
  // 變動發生在回測起始日之前：期間內的價格都是變動後的實際單位，不需揭露
  r = B.run(JSON.parse(JSON.stringify(d)), btCfg({ tradeStart: d.dates[60], splitAdjusted: [Object.assign({}, sa[0], { date: early })] }));
  assert.deepStrictEqual(J(r.diag.shareChanges), []);
  // 畫面文字
  const ui = require("fs").readFileSync(require("path").join(__dirname, "../../frontend/js/bt-ui.js"), "utf8");
  assert.ok(/config\.splitAdjusted = Array\.isArray\(data\.splitAdjusted\)/.test(ui)); assert.ok(ui.includes("不是當時實際成交的重現"));
});
test("空單費稅方向：融券賣出套賣出費率（含證交稅）、回補套買進費率；多單不變；張數、拒單、紀錄與權益一致", () => {
  const B = vmLoad(), r2 = (x) => Math.round(x * 100) / 100, ex = (r) => r.trades.find((t) => t.type === "exit");
  const sum = (r) => r2(r.trades.filter((t) => t.type === "exit").reduce((a, t) => a + t.netPnl, 0));
  // Codex 反例：9 張（9,000 股）100 元放空、70 元回補
  let c = Array(60).fill(110).concat([100, 110, 110]), o = c.slice(); c[59] = 105; o[60] = 100; o[61] = 70;
  const sh = (extra) => B.run(JSON.parse(JSON.stringify(ohlc(c, o))), btCfg(Object.assign({ execType: "open", stopProfit: 25, longEntry: [], longExit: [], shortEnabled: true, shortEntry: [{ id: "s_price_below_ma", params: { period: 20 } }], shortExit: [] }, extra)));
  let r = sh({}), x = ex(r);
  assert.strictEqual(x.qty, 9); assert.strictEqual(r2(x.entryFees), 3982.5); assert.strictEqual(r2(x.exitFees), 897.75); assert.strictEqual(r2(x.netPnl), 265119.75);
  assert.strictEqual(r.diag.entryLog[0].perLot, Math.round(100 * 1000 * 1.004425), "一張所需金額含賣出費稅");
  assert.strictEqual(r2(r.metrics.finalEquity - 1000000), sum(r), "權益變動＝已實現淨損益");
  // 多單不變：100 元買進 9 張、130 元停利賣出
  c = Array(60).fill(90).concat([100, 90, 90]); o = c.slice(); c[59] = 95; o[60] = 100; o[61] = 130;
  r = B.run(JSON.parse(JSON.stringify(ohlc(c, o))), btCfg({ execType: "open", stopProfit: 25, longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] })); x = ex(r);
  assert.strictEqual(r2(x.entryFees), 1282.5); assert.strictEqual(r2(x.exitFees), 5177.25); assert.strictEqual(r2(x.netPnl), 263540.25); assert.strictEqual(r2(r.metrics.finalEquity - 1000000), sum(r));
  // ETF 自訂費率（買 0.1%、賣 0.2%）：空單進場 0.2%、回補 0.1%
  c = Array(60).fill(110).concat([100, 110, 110]); o = c.slice(); c[59] = 105; o[60] = 100; o[61] = 70;
  r = sh({ code: "0050", buyFee: 0.1, sellFee: 0.2 }); x = ex(r);
  assert.strictEqual(x.qty, 9); assert.strictEqual(r2(x.entryFees), 1800); assert.strictEqual(r2(x.exitFees), 630); assert.strictEqual(r2(x.netPnl), 267570);
  // 拒單：100,300 元夠付一張加 0.1425%（100,142.5），不夠付一張加 0.4425%（100,442.5）→ 空單應拒單並記錄所需金額
  r = sh({ capital: 100300 });
  assert.strictEqual(r.metrics.tradeCount, 0); assert.strictEqual(r.diag.rejectedCash, 1); assert.ok(Math.abs(r.diag.minCashNeeded - 100442.5) <= 0.5, "所需金額 100,442.5（顯示取整）");
});

test("Codex 反例：公司行動檢查未完成（corpChecked=false、未提供、備援來源）時停止回測並列出缺少的資料；已檢查且無事件則正常", () => {
  const B = vmLoad(), c = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 6)), d = ohlc(c);
  const cfg = (o) => btCfg(Object.assign({ execType: "close", longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [{ id: "price_below_ma", params: { period: 20 } }] }, o));
  const ok = B.run(JSON.parse(JSON.stringify(d)), cfg({ unexplained: [] })); assert.ok(ok.metrics.tradeCount > 0, "已檢查、無事件的正常資料要能交易");
  assert.throws(() => B.run(JSON.parse(JSON.stringify(d)), cfg({ corpChecked: false, corpMissing: ["股利紀錄取得失敗"] })), /公司行動檢查未完成（股利紀錄取得失敗）/);
  assert.throws(() => B.run(JSON.parse(JSON.stringify(d)), cfg({ corpChecked: undefined })), /公司行動檢查未完成（沒有提供公司行動檢查狀態）/, "未提供狀態視為未檢查");
  assert.throws(() => B.run(JSON.parse(JSON.stringify(d)), cfg({ corpChecked: "true" })), /公司行動檢查未完成/, "只接受明確的 true");
  // 前端：狀態取自後端回應並交給 worker；備援來源標示 fallbackSource
  const ui = require("fs").readFileSync(require("path").join(__dirname, "../../frontend/js/bt-ui.js"), "utf8");
  assert.ok(ui.includes("config.corpChecked = Array.isArray(data.unexplained) && !data.checkNote;")); assert.ok(/fallbackSource: true/.test(ui)); assert.ok(!/dg\.corpChecked === false/.test(ui));
});
test("漲跌幅分類貫穿個股分析、/history 與回測：國外 ETF 不截斷；國內 ETF 截斷；分類無法確認時標示無法校驗、不聲稱違反", async () => {
  const U = require("../src/util"), CLS = new Map([["0050", { type: "國內成分證券指數股票型基金", foreign: "否", name: "元大台灣卓越50證券投資信託基金" }],
    ["00646", { type: "國外成分證券指數股票型基金", foreign: "是", name: "元大標普500傘型證券投資信託基金之標普500證券投資信託基金" }]]);
  // 同一條人工日 K（測試資料）：第 200 根單日 +15%
  const hist = async (c) => { const h = await demo.getHistory("0050", "2000-01-01"), k = h.dates.length - 100, o = { code: c, dates: h.dates, volumes: h.volumes };
    for (const f of ["opens", "highs", "lows", "closes"]) o[f] = h[f].map((x, i) => (i < k ? x / 1.15 : x)); return o; }; // 之前的價格縮小，最後一段與示範快照一致
  const src = (over) => srcWith(Object.assign({ getHistory: hist, getQuote: async () => null, getEtfClassMap: async () => CLS }, over));
  U._test_clear(); const dom = await analyzeFn(src({}), "0050");
  assert.strictEqual(dom.adjust.unexplained.length, 1); assert.ok(dom.adjust.cut); assert.ok(/【無法解釋的價格跳動】/.test(dom.text)); assert.ok(/國內成分 ETF：漲跌幅限制 10%/.test(dom.text));
  U._test_clear(); const ovs = await analyzeFn(src({}), "00646");
  assert.strictEqual(ovs.adjust.unexplained.length, 0); assert.strictEqual(ovs.adjust.cut, null); assert.ok(!/無法解釋的價格跳動|無法校驗/.test(ovs.text)); assert.ok(/不設漲跌幅限制/.test(ovs.text));
  U._test_clear(); const unk = await analyzeFn(src({ getEtfClassMap: async () => { throw new Error("down"); } }), "00646");
  assert.strictEqual(unk.adjust.unexplained[0].unverified, true); assert.ok(unk.adjust.cut); assert.ok(/【大幅變動、無法校驗】/.test(unk.text)); assert.ok(/證交所基金分類取得失敗/.test(unk.text));
  assert.ok(!/【無法解釋的價格跳動】/.test(unk.text), "分類不明時不得寫成超過漲跌幅限制");
  // 回測引擎：分類不明的跳動一樣停止，但文字不聲稱違反
  const B = vmLoad(), d = ohlc(Array.from({ length: 120 }, (_, i) => (i < 90 ? 100 : 115)));
  assert.throws(() => B.run(JSON.parse(JSON.stringify(d)), btCfg({ unexplained: [d.dates[90]], unverifiedJumps: [d.dates[90]], priceLimit: unk.adjust.priceLimit })), (e) => /這不代表違反漲跌幅規則/.test(e.message) && !/超過漲跌幅限制/.test(e.message));
  assert.throws(() => B.run(JSON.parse(JSON.stringify(d)), btCfg({ unexplained: [d.dates[90]] })), /超過漲跌幅限制/);
});
test("/history：回傳依官方分類判定的漲跌幅依據", async () => {
  const { server } = require("../server"), U = require("../src/util"); await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  try { U._test_clear(); const j = await (await fetch(`http://localhost:${port}/history?code=0050&start=2024-01-01&end=2030-01-01`)).json();
    assert.strictEqual(j.priceLimit.known, true); assert.strictEqual(j.priceLimit.limit, 0.105); assert.ok(/國內成分 ETF/.test(j.priceLimit.basis));
    const s = await (await fetch(`http://localhost:${port}/history?code=2330&start=2024-01-01&end=2030-01-01`)).json(); assert.ok(/一般股票/.test(s.priceLimit.basis)); }
  finally { await new Promise((r) => server.close(r)); }
});

test("行情總覽的「今日漲停價」與跳動偵測使用同一份官方分類：國外 ETF 不適用、國內槓桿 20%、分類不明不計算、一般股票不變", async () => {
  const U = require("../src/util"), S2 = require("../src/scoring"), CLS = new Map([["00646", { type: "國外成分證券指數股票型基金", foreign: "是", name: "元大標普500傘型證券投資信託基金之標普500證券投資信託基金" }],
    ["00631L", { type: "槓桿/反向指數股票型基金", foreign: "否", name: "元大ETF傘型證券投資信託基金之台灣50單日正向2倍證券投資信託基金" }]]);
  const hist = async (c) => Object.assign(await demo.getHistory("0050", "2000-01-01"), { code: c }); // 測試資料：借用示範日 K
  const src = (over) => srcWith(Object.assign({ getHistory: hist, getQuote: async () => null, getEtfClassMap: async () => CLS }, over));
  const row = (a) => a.text.split("\n").find((l) => l.startsWith("| 今日漲停價"));
  U._test_clear(); let a = await analyzeFn(src({}), "00646"); assert.ok(/^\| 今日漲停價 \| 不適用：含國外成分.*不設漲跌幅限制/.test(row(a)), row(a));
  U._test_clear(); a = await analyzeFn(src({}), "00631L"); const want = S2.limitUpPrice(a.quote.prevClose, true, 0.2);
  assert.ok(row(a).includes("漲跌幅 20%"), row(a)); assert.ok(Math.abs(want / a.quote.prevClose - 1.2) < 0.01); assert.ok(row(a).replace(/,/g, "").includes(String(want)), row(a) + " ≠ " + want);
  U._test_clear(); a = await analyzeFn(src({ getEtfClassMap: async () => { throw new Error("down"); } }), "00646"); assert.ok(/^\| 今日漲停價 \| 未計算：漲跌幅分類無法確認/.test(row(a)), row(a));
  U._test_clear(); a = await analyzeFn(demo, "2330"); assert.ok(row(a).replace(/,/g, "").startsWith(`| 今日漲停價 | ${S2.limitUpPrice(a.quote.prevClose, false)}（距現價`), row(a));
  assert.strictEqual(S2.limitUpPrice(100, false), 110); assert.strictEqual(S2.limitUpPrice(50, true, 0.2), 60);
});
test("Codex 反例：/history 已知配股要回傳股數還原價並揭露換算事件；純現金股利不改可交易價位", async () => {
  const { server } = require("../server"), U = require("../src/util"), keep = { h: demo.getHistory, s: demo.getSplitMap, d: demo.getDividends };
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const raw = flat(80, (i) => (i < 40 ? 110 : 100)), ev = raw.dates[40]; // 人工日 K（測試資料）：前 40 根 110、後 40 根 100
  const get = async () => { U._test_clear(); return (await fetch(`http://localhost:${port}/history?code=2330&start=2000-01-01&end=2030-01-01`)).json(); };
  try {
    demo.getHistory = async (c) => Object.assign(JSON.parse(JSON.stringify(raw)), { code: c }); demo.getSplitMap = async () => new Map();
    // 配股：每股 1 元（面額 10 元 → 10% 配股），事件日價格 100 正是 110 ÷ 1.1
    demo.getDividends = async () => ({ events: [{ date: ev, cash: 0, stock: 1 }] });
    let j = await get();
    assert.ok(Math.abs(j.closes[0] - 100) < 1e-9 && Math.abs(j.opens[0] - 100) < 1e-9, "事件前價格要換算成配股後股數基準：" + j.closes[0]); assert.strictEqual(j.closes[40], 100);
    assert.ok(Math.abs(j.volumes[0] - raw.volumes[0] * 1.1) < 1e-6, "成交量同步換算");
    assert.deepStrictEqual(j.unexplained, []); assert.strictEqual(j.checkNote, null);
    assert.deepStrictEqual(j.splitAdjusted.map((x) => [x.date, x.type, x.stock, x.ratio]), [[ev, "配股", 1, 1.1]]);
    // 回測：與回測頁相同的設定方式，診斷要揭露配股的換算單位
    const B = vmLoad(), d = { code: "2330" }; for (const f of ["dates", "opens", "highs", "lows", "closes", "volumes"]) d[f] = j[f];
    const r = B.run(d, btCfg({ code: "2330", tradeStart: raw.dates[30], splitAdjusted: j.splitAdjusted, unexplained: j.unexplained.map((x) => x.date), execType: "close", longEntry: [{ id: "price_above_ma", params: { period: 20 } }], longExit: [] }));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.diag.shareChanges)).map((x) => [x.date, x.type, x.ratio, x.stock]), [[ev, "配股", 1.1, 1]]);
    // 對照：純現金股利 10 元 → 可交易價位不變（逐值等於原始資料），不列入股數換算
    demo.getDividends = async () => ({ events: [{ date: ev, cash: 10, stock: 0 }] });
    j = await get();
    for (const f of ["opens", "highs", "lows", "closes", "volumes"]) assert.deepStrictEqual(j[f], raw[f], f);
    assert.deepStrictEqual(j.splitAdjusted, []); assert.deepStrictEqual(j.unexplained, []); assert.strictEqual(j.checkNote, null);
  } finally { Object.assign(demo, { getHistory: keep.h, getSplitMap: keep.s, getDividends: keep.d }); U._test_clear(); await new Promise((r) => server.close(r)); }
});
