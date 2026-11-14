# Yoe 台股個股分析＋回測

以 [taiwan-stock.netlify.app](https://taiwan-stock.netlify.app/) 為藍本重建的完整專案：前端兩頁 + 全新撰寫的後端。
建構歷程見 [`docs/HISTORY.md`](docs/HISTORY.md)。

## 30 秒啟動

```bash
cd backend
npm install
npm run demo        # 示範資料模式（離線可用，數字是假的）→ http://localhost:3001
npm start           # 真實資料模式（需能連到 TWSE / TPEx / FinMind）
npm test            # 單元測試
```

一個 Node 行程同時提供 API 與前端，不需要建置步驟。

## 結構

```
frontend/                純靜態，無框架、無打包
  index.html             個股分析首頁
  backtest.html          回測系統
  js/config.js           ★ 全站唯一的後端位址設定
  js/app.js              首頁邏輯（搜尋、掃描、報告渲染、PDF）
  js/bt-core.js          回測引擎（主執行緒與 Worker 共用同一份）
  js/bt-worker.js        Web Worker：回測／參數優化／批量優化
  js/bt-storage.js       localStorage 儲存與匯出
  js/bt-ui.js            回測頁 UI
backend/                 Node 18+，唯一相依套件是 @anthropic-ai/sdk（AI 報告用，選用）
  server.js              HTTP 路由、CORS、流量限制、靜態檔
  src/sources.js         真實資料：TWSE / TPEx OpenAPI、FinMind、TWSE MIS
  src/demo.js            示範資料（介面與 sources.js 相同）
  src/indicators.js      SMA/EMA/RSI/KD/MACD/布林
  src/scoring.js         100 分評分、動能分數、漲停價
  src/scan.js            七種掃描
  src/analyze.js         個股分析流程
  src/report.js          規則式報告（不需要 AI 金鑰）
  src/ai.js              Claude AI 深度報告（選用）
```

## API

| 路徑 | 說明 |
|---|---|
| `GET /health` | 狀態；前端載入時用來喚醒主機 |
| `GET /search?q=` | 自動補全 → `[{code,name,type}]` |
| `GET /scan?mode=&limit=&universe=` | `volume` `change` `drop` `momentum` `sector` `limitup` `disposition`；結果快取 3 分鐘 |
| `POST /analyze` `{code}` | 報價、指標、籌碼、融資、基本面、`scored`、`text`（規則式報告）、`aiReady` |
| `POST /analyze-ai` `{code}` | AI 報告 `{text}`；未設金鑰回 `{text:null}` |
| `GET /history?code=&start=&end=` | 日 K 陣列（回測用） |

## 評分模型（100 分）

| 面向 | 滿分 | 細項 |
|---|---|---|
| 基本面 | 20 | 月營收年增率 8、本益比 5、ROE 估算 4、毛利率代理 3 |
| 技術面 | 25 | 站上 MA20、MA20 向上、MA60 向上、多頭排列、突破 20 日高（各 5） |
| 量價 | 15 | 上漲放量、回檔量縮、量>均量（各 5） |
| 籌碼 | 20 | 外資連買 6、投信連買 6、法人合計 4、大戶持股代理 4 |
| 融資 | 10 | 融資使用率 5、融資去槓桿 5 |
| 題材 | 10 | 族群熱度排名 6、族群上漲比 4 |

**限制（請務必知道）**
- 門檻值是依原站介面上的配分反推後自行訂定，**沒有經過歷史回測驗證預測力**。分數高不代表會漲。
- 三個「代理」指標不是實際財報數字：ROE＝PB÷PE；毛利率以營收 YoY／MoM 是否同時不衰退替代；大戶持股以法人 20 日累計買超佔成交量比重替代。
- 缺資料的細項顯示「—」、不計分，所以資料源故障時總分會偏低。
- 題材分數是「當日」族群強弱，不是產業研究。

## 部署

**方案 A（建議）：單一服務。** 把整個 repo 推上 GitHub，在 Render 用 `render.yaml` 建立服務即可，前端與 API 同網域，`config.js` 不用改。

**方案 B：沿用原站的 Netlify + Render。** 後端同上；前端用 `netlify.toml`（publish = `frontend`），並把 `frontend/js/config.js` 的 `API_BASE` 改成後端網址、後端的 `ALLOWED_ORIGINS` 設為前端網址。

環境變數見 `backend/.env.example`。`ANTHROPIC_API_KEY` 只放在主機的環境變數，不要寫進程式碼或前端。

## 驗證狀態

| 項目 | 狀態 |
|---|---|
| 示範模式下全站端到端（首頁、7 種掃描、手機版、回測、參數優化、批量優化） | ✅ 已用瀏覽器自動化測試 |
| 單元測試 7 項 | ✅ 通過 |
| 真實資料路徑（`src/sources.js`） | ✅ 2026-11-14 以真實資料實測：2330 全部資料源到齊（`missing` 為空）、七種掃描、搜尋、上櫃股與 ETF 皆正常。收盤價未逐筆與證交所人工核對 |
| FinMind 免金鑰額度 | ⚠ 實測會用盡：每小時約 300 次，一次掃描會用掉 20～30 次。用盡後個股 K 線／籌碼序列會缺（畫面會提示），約 10 分鐘後自動重試。**正式上線建議設定 `FINMIND_TOKEN`**（FinMind 免費註冊即可取得） |
| AI 報告 `{text}`；未設金鑰回 `{text:null}` |
| `GET /history?code=&start=&end=` | 日 K 陣列（回測用） |

## 評分模型（100 分）

| 面向 | 滿分 | 細項 |
|---|---|---|
| 基本面 | 20 | 月營收年增率 8、本益比 5、ROE 估算 4、毛利率代理 3 |
| 技術面 | 25 | 站上 MA20、MA20 向上、MA60 向上、多頭排列、突破 20 日高（各 5） |
| 量價 | 15 | 上漲放量、回檔量縮、量>均量（各 5） |
| 籌碼 | 20 | 外資連買 6、投信連買 6、法人合計 4、大戶持股代理 4 |
| 融資 | 10 | 融資使用率 5、融資去槓桿 5 |
| 題材 | 10 | 族群熱度排名 6、族群上漲比 4 |

**限制（請務必知道）**
- 門檻值是依原站介面上的配分反推後自行訂定，**沒有經過歷史回測驗證預測力**。分數高不代表會漲。
- 三個「代理」指標不是實際財報數字：ROE＝PB÷PE；毛利率以營收 YoY／MoM 是否同時不衰退替代；大戶持股以法人 20 日累計買超佔成交量比重替代。
- 缺資料的細項顯示「—」、不計分，所以資料源故障時總分會偏低。
- 題材分數是「當日」族群強弱，不是產業研究。

## 部署

**方案 A（建議）：單一服務。** 把整個 repo 推上 GitHub，在 Render 用 `render.yaml` 建立服務即可，前端與 API 同網域，`config.js` 不用改。

**方案 B：沿用原站的 Netlify + Render。** 後端同上；前端用 `netlify.toml`（publish = `frontend`），並把 `frontend/js/config.js` 的 `API_BASE` 改成後端網址、後端的 `ALLOWED_ORIGINS` 設為前端網址。

環境變數見 `backend/.env.example`。`ANTHROPIC_API_KEY` 只放在主機的環境變數，不要寫進程式碼或前端。

## 驗證狀態

| 項目 | 狀態 |
|---|---|
| 示範模式下全站端到端（首頁、7 種掃描、手機版、回測、參數優化、批量優化） | ✅ 已用瀏覽器自動化測試 |
| 單元測試 7 項 | ✅ 通過 |
| **真實資料路徑（`src/sources.js`）** | ⚠ **未實測**：建置環境無法連到 TWSE／TPEx／FinMind。欄位名稱依公開規格撰寫並做了多名稱容錯，首次上線請先跑下方檢查 |
| AI 報告（`src/ai.js`） | ⚠ 未實測（沒有金鑰）；失敗時會自動保留規則式報告 |
| 原站後端的實際評分公式 | 無法取得，本專案為重新設計 |

上線後的檢查：

```bash
curl -s localhost:3001/health
curl -s "localhost:3001/search?q=2330"
curl -s -X POST localhost:3001/analyze -H 'Content-Type: application/json' -d '{"code":"2330"}' | head -c 600
curl -s "localhost:3001/scan?mode=volume&limit=5" | head -c 600
```

回應裡的 `missing` 陣列會列出哪個資料源沒抓到；收盤價請與證交所網站核對一次。

若主機對外連線必須經過 HTTP 代理（公司網路等），啟動時加上 `NODE_USE_ENV_PROXY=1`（Node 22.21+），否則 Node 內建的 `fetch` 不會讀 `HTTPS_PROXY`。

## 免責
本專案為研究與學習工具，所有內容不構成投資建議。
