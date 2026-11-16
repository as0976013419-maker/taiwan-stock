# Yoe 台股個股分析＋回測

線上網址：https://taiwan-stock-a5k5.onrender.com

以 [taiwan-stock.netlify.app](https://taiwan-stock.netlify.app/) 的前端為基礎翻新，後端為全新撰寫。建構歷程見 [`docs/HISTORY.md`](docs/HISTORY.md)。

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
  src/quant.js           風險指標、相對強弱、趨勢模板、海龜通道、歷史訊號統計、部位試算
  src/scoring.js         100 分評分、動能分數、漲停價
  src/scan.js            七種掃描
  src/analyze.js         個股分析流程
  src/report.js          規則式報告（31 段，不需要 AI 金鑰）
  src/ai.js              Claude AI 解讀報告（選用）
```

## API

| 路徑 | 說明 |
|---|---|
| `GET /health` | 狀態；前端載入時用來喚醒主機 |
| `GET /search?q=` | 自動補全 → `[{code,name,type}]` |
| `GET /scan?mode=&limit=&universe=` | `volume` `change` `drop` `momentum` `sector` `limitup` `disposition`；結果快取 3 分鐘 |
| `POST /analyze` `{code}` | 報價、指標、籌碼、財報、量化指標、`scored`、`text`（規則式報告）、`stance`、`tags` |
| `POST /analyze-ai` `{code}` | AI 報告 `{text}`；未設金鑰回 `{text:null}` |
| `GET /history?code=&start=&end=` | 日 K 陣列（回測用） |

## 個股報告內容（共 31 段）

| 分頁 | 段落 |
|---|---|
| 行情 | 行情總覽、多週期績效（相對大盤）、支撐壓力（含隔日樞紐點）、位階分析 |
| 技術 | 技術分析、趨勢結構檢核（趨勢模板 8 項＋四階段）、長線趨勢、市場風格、歷史訊號統計 |
| 短中長線 | 短線（1~5 日）、中線（1~8 週）、長線（3~12 個月） |
| 籌碼 | 三大法人 1/5/10/20/60 日、籌碼屬性與估算成本、法人分析、外資持股、融資融券 |
| 基本面 | 月營收 6 個月明細、季財報三率與 EPS、估值（全市場／同業／自身五年百分位）、股利、產業、新聞標題 |
| 風險 | 風險清單、量化風險指標（ATR、波動、Beta、VaR、最大回撤…）、部位規模試算 |
| 策略 | 情境推演、交易員檢核表（趨勢模板／成長動能七項／海龜通道）、量化因子、綜合分析、最終裁定 |

- **歷史訊號統計**：以該股自己約五年的日 K 回算 11 種訊號出現後 5／10／20 日的上漲機率與平均報酬，並與「任意一天買進」的基準比較。屬於樣本內統計，未計交易成本、未還原除權息。
- **交易員檢核表**：把公開出版的交易方法條件寫成程式逐項比對；門檻沿用原著（為美股設計），在台股的有效性未經本專案回測驗證。
- **估值區間試算**：近四季 EPS × 自身五年本益比的第 10／50／90 百分位，是機械換算，不是目標價。

## 評分模型（100 分）

| 面向 | 滿分 | 細項 |
|---|---|---|
| 基本面 | 20 | 月營收年增率 8、EPS 年增（或本益比）5、ROE 4、毛利率趨勢 3 |
| 技術面 | 25 | 站上 MA20、MA20 向上、MA60 向上、多頭排列、突破 20 日高（各 5） |
| 量價 | 15 | 上漲放量、回檔量縮、量>均量（各 5） |
| 籌碼 | 20 | 外資連買 6、投信連買 6、法人合計 4、外資持股變化 4 |
| 融資 | 10 | 融資使用率 5、融資去槓桿 5 |
| 題材 | 10 | 族群熱度排名 6、族群上漲比 4 |

**限制**
- 各細項門檻是自行訂定的，**沒有經過歷史回測驗證預測力**。分數高不代表會漲。
- 個股分析有季財報時用實際數字（ROE＝近四季淨利÷股東權益、毛利率與去年同季比、單季 EPS 年增）；抓不到財報、以及掃描模式下，會退回替代算法（PB÷PE、營收動能、本益比高低）。
- 缺資料的細項顯示「—」、不計分，所以資料源故障時總分會偏低。
- 題材分數是「當日」族群強弱，不是產業研究。

## 資料額度

每次個股分析會對 FinMind 發出約 11 個請求（財報類快取 24 小時、K 線 6 小時）。免金鑰額度約每小時 300 次，**大約只夠 25 檔新股票**，掃描另計。用盡後畫面會提示哪些段落缺資料，約 10 分鐘後自動重試。

正式使用請到 FinMind 免費註冊取得權杖，設成環境變數 `FINMIND_TOKEN`。

## 部署

目前採單一服務：Render 讀取 `render.yaml`，前端與 API 同網域，推到 `main` 會自動重新部署。

若要前後端分離（前端 Netlify、後端 Render）：用 `netlify.toml`（publish = `frontend`），把 `frontend/js/config.js` 的 `API_BASE` 改成後端網址，後端的 `ALLOWED_ORIGINS` 設為前端網址。

環境變數見 `backend/.env.example`。金鑰只放在主機的環境變數，不要寫進程式碼或前端。主機對外連線若必須經過 HTTP 代理，啟動時加上 `NODE_USE_ENV_PROXY=1`（Node 22.21+）。

## 驗證狀態

| 項目 | 狀態 |
|---|---|
| 示範模式下全站端到端（首頁七個分頁、七種掃描、手機版、回測、參數優化、批量優化） | ✅ 瀏覽器自動化測試通過 |
| 單元測試 7 項 | ✅ 通過 |
| 真實資料（線上） | ✅ 2026-11-16 實測 2330、2454、2317、2882：31 段報告完整產生；數字未逐筆與證交所人工核對 |
| 金融股 | ⚠ 損益表科目不同，毛利率、營益率、流動比率顯示「—」 |
| AI 報告（`src/ai.js`） | ⚠ 未實測（沒有金鑰）；失敗時自動保留規則式報告 |
| 評分、裁定、交易方法門檻的預測力 | ⚠ 未回測驗證 |

## 免責
本專案為研究與學習工具，所有內容不構成投資建議。
