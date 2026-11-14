# 從 0 到 1：taiwan-stock.netlify.app 的建構歷程

> 取樣時間：2026-11-14。來源是線上兩個頁面（`/` 約 89 KB、`/backtest` 約 187 KB）的原始碼。
> **原站沒有公開 git 紀錄或更新日誌**，所以下列順序是從程式碼裡的「地層」反推的：
> 版本字串、註解、防禦式寫法（後加的功能才會有 `if (el)` 判斷）、殘留的舊品牌與舊後端網址。
> 每一階段都標明【證據】；沒有直接證據的地方標為【推論】。原站後端原始碼不公開，後端部分一律是推論。

## 架構總覽（現況）

```
瀏覽器 ── Netlify（純靜態：index.html、backtest.html，各自單檔內嵌 CSS/JS）
   │
   ├─ 首頁  → https://taiwan-stock-api-1.onrender.com    /search /scan /analyze /analyze-ai
   └─ 回測  → https://taiwan-stock-api-lm71.onrender.com /history  ──失敗→ 直接打 FinMind
                                   │
                    Render 上的 Node 後端（本機開發埠 3001）
                                   │
              TWSE、FinMind、富果(Fugle)、LLM（產生「=== 段落」格式的報告）
```

## 階段 0｜單頁原型：輸入代號 → AI 報告
- 一個 `index.html`：搜尋框＋「分析」按鈕，後端回傳一大段文字，前端用 `parseSection()` 以 `=== 段落名` 切成 19 段，分進 7 個分頁（行情／技術／短中長線／籌碼／基本面／風險／策略）。
- 設計語彙在這時定案：深色主題、CSS 變數（`--bg`…`--accent`）、IBM Plex Mono＋Noto Sans TC、紅漲綠跌。
- 【證據】`parseSection` 註解「純字串搜尋，無 regex 問題」＝早期曾用正則切段落出過錯後重寫；多空、股名、股價全靠對 AI 文字做關鍵字／正則比對（`偏多`、`名稱：`、`收盤：`），代表當時後端只回文字、沒有結構化資料。
- 【證據】當時品牌叫「台股.AI」：回測頁 logo 仍是 `台股<span>.</span>AI`，首頁 CSS 還留著 `.welcome-logo span{color:var(--accent)}`（那個藍色的點）。

## 階段 1｜前後端分離與部署
- 前端上 Netlify；後端是 Node 服務，本機 `localhost:3001`、正式環境 Render。
- 【證據】`window.RENDER_URL` 依 hostname 自動切換；多處註解在處理 Render 免費方案的冷啟動（「頁面載入 1.5s 後才打 API，讓 Render 先醒」「冷啟動可能需要 30s」、60 秒逾時）。
- 【證據】後端至少重建過一次：首頁用 `taiwan-stock-api-1`，回測頁還指向較舊的 `taiwan-stock-api-lm71`。

## 階段 2｜搜尋體驗
- 自動補全（`/search?q=`）：250 ms debounce、鍵盤上下選取、Esc 關閉。
- 熱門股列：先是寫死的 10 檔（`HOTS_DEFAULT`），後來改成載入後向 `/scan?mode=volume&limit=10` 取當日熱門，失敗就維持預設。
- 【證據】註解「取消上一次未完成的 fetch（避免 race condition + memory leak）」「確認搜尋框目前值仍匹配（避免 stale result）」＝實際遇過舊結果蓋掉新結果的 bug 後補上 `AbortController`。

## 階段 3｜熱門掃描（分三波加入）
1. 第一波：成交量、漲幅、動能排行。
2. 第二波：跌幅、族群熱度（另一套 `renderSectorScan` 版面，可展開看領漲股）。
3. 第三波：鎖漲停、處置股（文案寫「富果即時資料」→ 這時接了 Fugle）。
- 【證據】`setMode()` 裡前三個按鈕直接 `getElementById(...).classList`，後四個都先 `if (btn)` 才操作——典型的「後來才加、怕舊版 HTML 沒有這顆按鈕」寫法。
- 【證據】曾有「掃描範圍」下拉選單（`scanUniverse`：熱門池／大型股~800檔／全市場~1700檔），JS 還在讀它，但 HTML 元素已被移除。
- 後端加了 3 分鐘快取（「⚡ 快取結果（3分鐘內有效）」）與版本標記 `_v`。

## 階段 4｜量化評分卡
- 在 AI 文字之外，後端開始回傳結構化的 `scored`：總分 100＝基本面 20＋技術面 25＋量價 15＋籌碼 20＋融資 10＋題材 10，共 20 個細項，四級分級（80 強勢觀察／65 可試單／50 等待整理／其餘不建議）。
- 掃描表格同步加上分數環、等級、六面向小計欄。
- 【證據】`renderReport(code, text, scored)` 的 `scored` 是後加的第三個參數，評分卡 HTML 被「前置」在原本的 hero 區塊之前。

## 階段 5｜兩段式分析（解決等待時間）
- `/analyze` 拆成兩步：先快速回數據與評分（註解「< 5s」），再非同步呼叫 `/analyze-ai` 取 AI 文字。
- 【證據】`text = text || ""; // 防止 null.indexOf/match 崩潰`＝拆成兩段後，第一次渲染沒有文字而當掉過。

## 階段 6｜PDF、主題、手機版
- 「下載 PDF 報告」：用 `@media print` 把 7 個分頁全部展開、強制白底，再呼叫 `window.print()`。
- 深／淺色主題切換（`localStorage`）。
- 手機版 RWD：【證據】CSS 最後多了一段排版風格完全不同（多行、有縮排）的 `/* 手機版 RWD */`，是事後補上的；含「防 iOS 自動縮放」的 16px 輸入框。

## 階段 7｜回測系統（獨立演進到 v4.1）
- 獨立頁面 `/backtest`，內部其實是模組化專案打包成單檔：`bt/core.js`（指標／訊號／執行／績效四個引擎）、`bt/storage.js`、`bt/worker.js`、UI 層。
- 功能：10 種做多進場＋10 種出場、9＋10 種做空策略，每個策略可調參數；共振分數閾值；當日收盤或隔日開盤成交；固定／複利部位；停損停利；手續費與證交稅（股票／ETF 自動判斷）；策略儲存；JSON／CSV 匯出；參數優化與批量優化都在 Web Worker 跑。
- 【證據】`<title>` 還是 v4.0、頁首顯示 v4.1 ✓、引擎 `version:'4.1.0', buildDate:'2026-05-15'`；註解留有修過的問題：「無 lookahead bias」「正確的做空會計」「production hardening」「Blob URL memory leak fix」「Race condition fix」。v1～v3 沒有留下痕跡。
- 資料來源：先打後端 `/history`，8 秒內沒回就直接改打 FinMind。

## 階段 8｜改名「偷吃你財」
- 首頁換上 logo 圖（以 base64 內嵌，約 22 KB）與新名稱，文字顏色寫死成白色。
- 【證據】歡迎區的大標題被清空但容器還在；回測頁沒跟著改名。

## 取樣時發現的問題（新版已處理）
| # | 問題 | 影響 |
|---|---|---|
| 1 | 兩頁指向不同的後端網址 | 回測頁多等 8 秒才退回 FinMind |
| 2 | 回測引擎 1,100 行在同一個 HTML 裡複製了兩份，且主執行緒那份少了 `_emptyMetrics` | 沒有交易時主執行緒計算會丟 ReferenceError |
| 3 | 掃描結果的股名、標籤等未跳脫就寫進 `innerHTML` | 後端或上游資料若含 HTML 會被執行（XSS） |
| 4 | 處置股警語設了 `opacity:.15` 且隨即被清空 | 警語從未顯示 |
| 5 | 「快取結果」提示與版本號寫入後立刻被覆蓋 | 提示從未顯示 |
| 6 | 報告表格每列之間插入 `<br>` | 表格上方出現大片空白 |
| 7 | 掃描名次輸入框上限 30，JS 卻允許 100；`var(--blue)` 未定義；`scanUniverse` 元素不存在 | 行為不一致 |
| 8 | 股名與股價用正則從 AI 文字猜 | AI 換個寫法就顯示「—」 |
| 9 | 淺色主題下 logo 文字是白色 | 看不見 |
