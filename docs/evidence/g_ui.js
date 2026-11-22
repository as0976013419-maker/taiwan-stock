// 回測頁實測 G：以存下的 0050 真實原始日 K ＋官方分割紀錄，經分支的 adjustPrices 換算後，攔截 /history 回傳（與正式站 /history 的處理相同）
// 用法：node g_ui.js <h_0050.json 所在資料夾> <backend 路徑> <輸出資料夾> <網址>
const { chromium } = require("playwright"), fs = require("fs"), path = require("path");
const [DIR, BE, OUT, B] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(path.join(DIR, "h_0050.json"), "utf8")); raw.code = "0050";
const { adjustPrices, priceLimit, limitOpts } = require(path.resolve(BE, "src/quant"));
const a = adjustPrices(raw, [], [{ date: "2025-06-18", before: 188.65, after: 47.16, type: "分割" }], limitOpts(priceLimit("0050", { type: "國內成分證券指數股票型基金", foreign: "否", name: "元大台灣卓越50證券投資信託基金" })) /* 證交所 t187ap47_L 的 0050 分類 */);
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1400, height: 4000 }, deviceScaleFactor: 2 }), errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.route(/\/history\?/, (route) => { const u = new URL(route.request().url()), s = u.searchParams.get("start"), e = u.searchParams.get("end"), o = { code: "0050" };
    const idx = a.price.dates.map((d, i) => (d >= s && d <= e ? i : -1)).filter((i) => i >= 0);
    for (const k of ["dates", "opens", "highs", "lows", "closes", "volumes"]) o[k] = idx.map((i) => a.price[k][i]);
    route.fulfill({ contentType: "application/json", body: JSON.stringify(Object.assign(o, { demo: false, splitAdjusted: a.splits, unexplained: [], checkNote: null })) }); });
  await p.goto(B + "/backtest");
  await p.fill("#stockCode", "0050"); await p.fill("#startDate", "2024-12-02"); await p.fill("#endDate", "2025-12-31"); await p.fill("#capital", "1000000");
  await p.selectOption("#execType", "open"); await p.selectOption("#positionBase", "equity"); await p.fill("#posSize", "100"); await p.fill("#stopLoss", "8"); await p.fill("#stopProfit", "25"); await p.fill("#scoreThreshold", "1");
  await p.evaluate(() => { setChecked("longEntryGroup", ["ma_golden"]); setChecked("longExitGroup", ["ma_death"]); });
  await p.click("#runBtn");
  await p.waitForFunction(() => /回測完成|錯誤/.test(document.getElementById("statusText").innerText), null, { timeout: 120000 });
  const diag = await p.locator(".signal-box", { hasText: "回測診斷" }).innerText();
  console.log("狀態：", await p.locator("#statusText").innerText()); console.log(diag);
  await p.locator(".signal-box", { hasText: "回測診斷" }).screenshot({ path: path.join(OUT, "g_backtest_diag.png") });
  console.log("頁面錯誤：", JSON.stringify(errs)); await b.close();
})();
