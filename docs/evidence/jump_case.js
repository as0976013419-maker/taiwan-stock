// 近期出現「查無公告」的跳動（150 根前價格為之後的 3 倍）：比較新舊版本是否仍輸出跨越斷點的指標
// 用法：DEMO=1 node jump_case.js <新版 backend> <舊版 backend>
const path = require("path");
const run = async (root) => {
  const demo = require(path.join(root, "src/demo")), { analyze } = require(path.join(root, "src/analyze"));
  const src = Object.assign({}, demo, { getHistory: async (c, s, e) => { const h = await demo.getHistory(c, s, e), k = h.dates.length - 150, o = { code: c, dates: h.dates, volumes: h.volumes };
    for (const f of ["opens", "highs", "lows", "closes"]) o[f] = h[f].map((x, i) => (i < k ? x * 3 : x)); return o; } });
  const a = await analyze(src, "2330"), q = a.quant || {}, r = q.risk || {}, rs = (k) => { const x = (q.rs || []).find((y) => y.k === k); return x ? x.ret : "—"; };
  return { 使用K線: a.indicators && a.indicators.bars, 一年報酬: rs(250), 六個月: rs(120), 最大回撤: r.maxDD, 一年波動: r.vol250, 最差單日: r.worstDay, MA240: a.indicators && a.indicators.ma240 && +a.indicators.ma240.toFixed(1),
    趨勢模板: q.trend ? q.trend.passed + "/8，" + q.trend.stageName : "不計算", 歷史訊號: q.events ? q.events.bars + " 根" : "不計算", 整體: a.stance };
};
(async () => { console.log("新版：", JSON.stringify(await run(process.argv[2]))); console.log("舊版：", JSON.stringify(await run(process.argv[3]))); })();
