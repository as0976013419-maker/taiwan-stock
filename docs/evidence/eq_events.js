// 歷史訊號統計：只改名（indep→nonOverlap）、移除 t 與 grade、新增 significance/smallSample；描述統計數值必須完全相同
process.env.DEMO = "1"; const [NEW, OLD] = process.argv.slice(2);
const N = { demo: require(NEW + "/src/demo"), an: require(NEW + "/src/analyze") }, O = { demo: require(OLD + "/src/demo"), an: require(OLD + "/src/analyze") };
(async () => { let k = 0, bad = 0, other = 0;
  for (const c of (await N.demo.getMarketSnapshot()).stocks.keys()) { const a = await O.an.analyze(O.demo, c), b = await N.an.analyze(N.demo, c);
    const norm = (ev, old) => ev.events.map((e) => [e.key, e.count, e.h.map((x) => ({ n: x.n, nonOverlap: old ? x.indep : x.nonOverlap, win: x.win, mean: x.mean, median: x.median, sd: x.sd, excess: x.excess, net: x.net }))]);
    k++; if (JSON.stringify(norm(a.quant.events, true)) !== JSON.stringify(norm(b.quant.events, false))) { bad++; console.log("≠", c); }
    for (const e of b.quant.events.events) for (const x of e.h) if (x.significance !== "unverified" || "t" in x || "grade" in x) other++; }
  console.log(`比對 ${k} 檔：描述統計不同 ${bad} 檔；仍有 t／grade 或未標未驗證的欄位 ${other} 個`); })();
