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
  const verdict = a.text.split("=== 最終裁定\n")[1];
  assert.ok(!(verdict.includes("偏多") && verdict.includes("偏空")));
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
