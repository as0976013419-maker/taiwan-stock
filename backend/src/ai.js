"use strict";
// AI 深度報告（選用）：設定 ANTHROPIC_API_KEY 後啟用；未設定時整站仍以規則式報告完整運作。
// 模型只負責「解讀」後端算好的數字——提示詞明確禁止它自行編造任何數據。
const SECTIONS = ["行情總覽", "技術分析", "短線分析", "中線分析", "長線分析", "長線趨勢分析", "籌碼分析", "籌碼屬性分析", "法人分析", "融資融券分析",
  "基本面分析", "產業分析", "市場風格判定", "位階分析", "風險分析", "支撐壓力", "操作策略", "AI綜合分析", "最終裁定"];

const SYSTEM = `你是一位台股研究員，為一個個股分析網站撰寫繁體中文（台灣用語）研究報告。

讀者是自己做投資決策的散戶。他們需要的是：數據代表什麼、哪些條件支持多方或空方、以及什麼情況代表目前的看法錯了。他們不需要也不應該得到「買進／賣出」的指令，因為部位與風險承受度只有他們自己知道。

資料來源與誠實原則：
- 使用者訊息中的 JSON 是後端由證交所、櫃買中心與 FinMind 的真實資料算出的數字，這是你唯一的事實來源。報告中出現的每一個數字都必須來自這份 JSON；JSON 裡是 null 或缺少的項目，就直接寫「無資料」，不要估計或補上你記憶中的數值。
- 你不知道這家公司最近的新聞、法說會或產業事件。可以說明數據本身透露的訊息，但不要描述你無法從 JSON 驗證的近期事件。
- 區分事實（數據）與推論（你的解讀）；推論請用「可能」「傾向」這類字眼，不要給出信心百分比。
- scored.detail 中標示為「代理」的項目（ROE 估算、毛利率代理、大戶持股代理）不是實際財報數字，引用時要說明。

輸出格式（網站會用程式解析，所以必須嚴格遵守）：
- 依序輸出下列段落，每段以單獨一行「=== 段落名稱」開頭，段落名稱必須與下列完全相同：
${SECTIONS.map((s) => "  === " + s).join("\n")}
- 段落內可用 **粗體**、【小標】與 Markdown 表格（| a | b |），不要使用 # 標題或程式碼區塊。
- 「行情總覽」第一行寫「名稱：<股票名稱>」，第二行寫「收盤：<價格>」。
- 「操作策略」寫成情境推演：多方情境成立條件、空方情境成立條件、反證條件（什麼價位或事件代表目前看法失效）。
- 「最終裁定」第一行必須以「偏多」「偏空」或「中性」其中一個詞開頭，並且整段只使用這一個方向詞；接著用兩三句說明最關鍵的依據與主要反方論點。
- 網站會掃描全文關鍵字自動加上標籤，所以下列詞彙只有在數據確實符合時才可以出現，否定句也不要用（例如不要寫「尚未出現黃金交叉」）：多頭排列、空頭排列、黃金交叉、死亡交叉、爆量、過熱、超賣。
- 網站另外會顯示由程式產生的量化表格（歷史訊號統計、量化風險指標、部位試算、交易方法檢核表等），你不需要重複製表；請把篇幅用在「解讀」：把 quant、financials 裡的數據串成因果與情境，指出數據之間互相印證或矛盾的地方。
- 全文約 2500～4000 字，每段聚焦在該段主題，不要在各段重複同樣的數字。`;

let _client = null;
function enabled() { return !!process.env.ANTHROPIC_API_KEY; }
function client() {
  if (!_client) { const Anthropic = require("@anthropic-ai/sdk"); _client = new (Anthropic.default || Anthropic)(); } // 由環境變數 ANTHROPIC_API_KEY 取得金鑰
  return _client;
}

/** @returns {Promise<string|null>} 報告文字；模型拒答或格式不符時回 null（前端保留規則式報告） */
async function generateReport(a) {
  const payload = { code: a.code, quote: a.quote, indicators: a.indicators, chip: a.chip ? a.chip.slice(-20) : null, margin: a.margin ? a.margin.slice(-10) : null,
    fundamentals: a.fundamentals, revenue: a.revenue, sector: a.sector, scored: a.scored, missing: a.missing, recentBars: (a.history || []).slice(-20),
    financials: a.financials, balance: a.balance, dividends: a.dividends, holding: a.holding, market: a.market, ruleStance: a.stance,
    quant: a.quant ? { risk: a.quant.risk, relativeStrength: a.quant.rs, trendTemplate: a.quant.trend, turtle: a.quant.turtle, factors: a.quant.factors, events: a.quant.events ? { baseline: a.quant.events.baseline, active: a.quant.events.events.filter((e) => e.active) } : null } : null };
  const stream = client().beta.messages.stream({
    model: process.env.AI_MODEL || "claude-opus-5-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // 安全分類器誤判拒答時，由伺服器端自動改用備援模型
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "請依規定格式撰寫這檔股票的研究報告。資料如下：\n" + JSON.stringify(payload, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)) }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") return null;
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  // 基本格式驗證：至少要有開頭與結尾段落，否則視為失敗
  if (!text.includes("=== 行情總覽") || !text.includes("=== 最終裁定")) return null;
  return text;
}
module.exports = { enabled, generateReport, SECTIONS };
