// 只有 230 根日 K 時，52 週／250 日相關欄位與文字（示範資料）
process.env.DEMO = "1"; const B = process.argv[2];
const demo = require(B + "/src/demo"), { analyze } = require(B + "/src/analyze");
(async () => { const src = Object.assign({}, demo, { getHistory: async (c) => { const h = await demo.getHistory(c, "2000-01-01"), o = { code: c }; for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) o[k] = h[k].slice(-230); return o; } });
  const a = await analyze(src, "2330"), r = a.quant.risk, t = a.quant.trend;
  console.log(JSON.stringify({ hi250: a.indicators.hi250, pos250: a.indicators.pos250, vol250: r.vol250, days: r.days, trend6: t && t.checks[5].pass, trend7: t && t.checks[6].pass }));
  for (const l of a.text.split("\n")) if (/52 週|一年最大回撤|最大回撤（|250 日年化|（一年）/.test(l)) console.log("  " + l.slice(0, 200)); })();
