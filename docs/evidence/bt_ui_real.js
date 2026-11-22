// 以真實資料在回測頁操作使用者回報的設定，讀取畫面上的摘要、診斷與交易記錄
// 用法：node bt_ui_real.js <輸出資料夾> <網址>
const { chromium } = require("playwright");
(async () => {
  const [OUT, B] = [process.argv[2], process.argv[3]];
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1400, height: 1100 } }), errs = [], hist = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("request", (r) => { if (/\/history\?/.test(r.url())) hist.push(r.url().replace(/^https?:\/\/[^/]+/, "")); });
  await p.goto(B + "/backtest");
  const run = async (cap) => {
    await p.fill("#stockCode", "2330"); await p.fill("#startDate", "2025-11-17"); await p.fill("#endDate", "2026-11-17"); await p.fill("#capital", String(cap));
    await p.selectOption("#execType", "open"); await p.selectOption("#positionBase", "equity"); await p.fill("#posSize", "100"); await p.fill("#stopLoss", "8"); await p.fill("#stopProfit", "25"); await p.fill("#scoreThreshold", "1");
    await p.evaluate(() => { setChecked("longEntryGroup", ["ma_golden"]); setChecked("longExitGroup", ["ma_death"]); });
    await p.click("#runBtn");
    await p.waitForFunction(() => /回測完成|錯誤/.test(document.getElementById("statusText").innerText), null, { timeout: 120000 });
    const st = await p.locator("#statusText").innerText(), sum = (await p.locator("#summaryContent").innerText()).replace(/\n+/g, " ｜ ");
    console.log(`\n### 本金 ${cap.toLocaleString()}\n狀態：${st}\n摘要：${sum.slice(0, 1400)}`);
    await p.click(".tab >> text=交易記錄"); console.log("交易記錄列數：", await p.locator("#tradesContent tr").count()); await p.click(".tab >> text=摘要");
    await p.locator("#summaryContent").screenshot({ path: `${OUT}/bt_real_${cap}.png` });
  };
  await run(1000000); await run(3000000);
  console.log("\n/history 請求：", JSON.stringify(hist), "\n頁面錯誤：", JSON.stringify(errs));
  await b.close();
})();
