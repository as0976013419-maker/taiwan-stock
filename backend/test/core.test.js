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

test("還原權息：分割與除息不得被算成虧損", () => {
  // 實際案例型態：0050 於 2025-06-18 一拆四（原始 K 線單日 -74.78%），網站曾把三年報酬算成 -21.9%
  const h = flat(60, (i) => (i < 30 ? 100 : i < 45 ? 25 : 23.75)); h.volumes = h.closes.map((_, i) => (i < 30 ? 1000 : 4000));
  const a = Q.adjustPrices(h, [{ date: h.dates[45], cash: 1.25, stock: 0 }]);
  assert.strictEqual(a.splits.length, 1); assert.strictEqual(a.splits[0].ratio, 4); assert.strictEqual(a.dividendsApplied, 1);
  assert.ok(Math.abs(a.total.closes[59] / a.total.closes[0] - 1) < 1e-9, "含息還原後整段報酬應為 0");
  assert.ok(Math.abs(a.price.closes[59] / a.price.closes[0] - 1 + 0.05) < 1e-9, "不含息序列保留 5% 的除息缺口");
  assert.strictEqual(a.price.volumes[0], 4000, "分割前的成交量要換算成分割後的股數");
  const r = Q.riskMetrics(Object.assign({}, a.total), null); assert.ok(r === null || r.maxDD > -1, "還原後不應出現 -75% 的假回撤");
});
test("還原權息：正常漲跌停（±10%）與上市初期不會被誤判成分割", () => {
  const h = flat(40, (i) => 100 * Math.pow(1.1, i % 2 ? 1 : 0)); // 每天在 100 與 110 之間跳動
  assert.strictEqual(Q.adjustPrices(h, []).splits.length, 0);
  const ipo = flat(40, (i) => (i < 3 ? 100 * (1 + i * 0.4) : 180)); // 前幾天無漲跌幅限制
  assert.strictEqual(Q.adjustPrices(ipo, []).splits.length, 0);
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
