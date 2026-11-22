// 漲跌幅分類核查：以證交所官方基金分類判定每檔上市 ETF 的漲跌幅限制，並與舊版「代號以 L 結尾＝20%、其他＝10%」比較
// 用法：node docs/evidence/limit_class.js <backend 路徑> [docs/evidence/t187ap47_L_subset.json]
// 不給第二個參數時，經正式程式的 getEtfClassMap() 即時抓取（需要網路；主機需經代理時加 NODE_USE_ENV_PROXY=1）
const path = require("path"), BE = path.resolve(process.argv[2]), Q = require(path.join(BE, "src/quant"));
const old = (c) => (/^00\d{2,4}L$/.test(c) ? 0.205 : 0.105);
(async () => {
  let m;
  if (process.argv[3]) { const j = require(path.resolve(process.argv[3])); m = new Map(j.rows.map((r) => [r["基金代號"], { type: r["基金類型"], foreign: r["是否包含國外成分股"], name: r["基金中文名稱"] }])); console.log("來源：存檔", j.source, "出表日期", j.rows[0]["出表日期"]); }
  else { m = await require(path.join(BE, "src/sources")).getEtfClassMap(); console.log("來源：即時抓取 證交所 OpenAPI t187ap47_L"); }
  const kinds = {}, wrong = []; let unk = 0;
  for (const [c, cls] of m) { const x = Q.priceLimit(c, cls), k = !x.known ? "無法確認" : x.limit === null ? "不設漲跌幅" : Math.round((x.limit - 0.005) * 100) + "%"; kinds[k] = (kinds[k] || 0) + 1;
    if (!x.known) unk++; else if (x.limit !== old(c)) wrong.push(c); }
  console.log(`上市基金 ${m.size} 檔：`, JSON.stringify(kinds)); console.log(`舊版規則與官方分類不符 ${wrong.length} 檔（例：${wrong.slice(0, 8).join("、")}）；分類無法確認 ${unk} 檔`);
  console.log("| 代號 | 新版判定 | 舊版 | 依據 |\n|---|---|---|---|");
  for (const c of ["0050", "00631L", "00675L", "00632R", "00646", "00647L", "00635U", "0061", "0080", "00679B"]) { const x = Q.priceLimit(c, m.get(c));
    console.log(`| ${c} | ${!x.known ? "無法確認" : x.limit === null ? "不設漲跌幅" : Math.round((x.limit - 0.005) * 100) + "%"} | ${Math.round((old(c) - 0.005) * 100)}% | ${x.basis} |`); }
})().catch((e) => { console.error("錯誤：", e.message); process.exit(1); });
