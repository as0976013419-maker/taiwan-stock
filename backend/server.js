"use strict";
// Yoe 台股分析 — 後端伺服器（零框架，Node 18+ 內建 http / fetch）
//   GET  /health              健康檢查（也用來喚醒免費方案的休眠主機）
//   GET  /search?q=           代號／名稱自動補全
//   GET  /scan?mode=&limit=&universe=   七種掃描
//   POST /analyze {code}      個股資料＋評分＋規則式報告
//   POST /analyze-ai {code}   AI 深度報告（需 ANTHROPIC_API_KEY）
//   GET  /history?code=&start=&end=     日 K（回測系統使用）
//   其餘路徑                   靜態檔案（../frontend），所以單一服務就能跑完整網站
const http = require("http"), fs = require("fs"), path = require("path");
const { cached, cacheAge, daysAgo, ymd, taipeiNow, cacheSize } = require("./src/util");
const DEMO = process.env.DEMO === "1";
const src = DEMO ? require("./src/demo") : require("./src/sources");
const { runScan } = require("./src/scan");
const { analyze } = require("./src/analyze");
const ai = require("./src/ai");

const PORT = process.env.PORT || 3001;
const STATIC = path.resolve(process.env.STATIC_DIR || path.join(__dirname, "..", "frontend"));
const ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8" };

// ── 流量限制（每 IP 滑動視窗；保護上游資料源額度與 AI 費用）──
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const key = bucket + ":" + ip, now = Date.now(), arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600000) hits.delete(k); }, 600000).unref();

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length, "X-Content-Type-Options": "nosniff" }, headers));
  res.end(buf);
}
function readBody(req, max = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error("請求內容過大"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(Object.assign(new Error("JSON 格式錯誤"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const validCode = (c) => typeof c === "string" && /^[0-9]{4,6}[A-Za-z]?$/.test(c);
const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

const FALLBACK_LIST = [["2330", "台積電"], ["2317", "鴻海"], ["2454", "聯發科"], ["2308", "台達電"], ["2603", "長榮"], ["2412", "中華電"], ["2882", "國泰金"], ["2891", "中信金"], ["3711", "日月光投控"], ["0050", "元大台灣50"], ["0056", "元大高股息"], ["00878", "國泰永續高股息"]];
async function search(q) {
  q = String(q || "").trim().slice(0, 20); if (!q) return [];
  let rows;
  try { rows = [...(await src.getMarketSnapshot()).stocks.values()]; } catch (e) { rows = FALLBACK_LIST.map(([code, name]) => ({ code, name, market: "上市", isETF: /^00/.test(code), value: 0 })); }
  const up = q.toUpperCase(), score = (r) => r.code === up ? 0 : r.code.startsWith(up) ? 1 : r.name.startsWith(q) ? 2 : r.name.includes(q) ? 3 : r.code.includes(up) ? 4 : 9;
  return rows.map((r) => ({ r, s: score(r) })).filter((x) => x.s < 9).sort((a, b) => a.s - b.s || (b.r.value || 0) - (a.r.value || 0)).slice(0, 10)
    .map(({ r }) => ({ code: r.code, name: r.name, type: r.isETF ? "ETF" : r.market }));
}

async function api(req, res, url, ip) {
  const p = url.pathname, q = url.searchParams;
  if (p === "/health") return send(res, 200, { ok: true, demo: DEMO, ai: ai.enabled(), cache: cacheSize(), time: new Date().toISOString() });

  if (p === "/search" && req.method === "GET") {
    if (limited(ip, "search", 120, 60000)) return send(res, 429, []);
    return send(res, 200, await search(q.get("q")), { "Cache-Control": "public, max-age=60" });
  }
  if (p === "/scan" && req.method === "GET") {
    if (limited(ip, "scan", 20, 60000)) return send(res, 429, { error: "掃描次數過於頻繁，請稍後再試" });
    return send(res, 200, await runScan(src, { mode: q.get("mode") || "volume", limit: q.get("limit"), universe: q.get("universe") || "custom" }));
  }
  if (p === "/history" && req.method === "GET") {
    const code = q.get("code"), start = q.get("start") || daysAgo(1100), end = q.get("end") || ymd(taipeiNow());
    if (!validCode(code) || !validDate(start) || !validDate(end) || start > end) return send(res, 400, { error: "參數錯誤：code=代號, start/end=YYYY-MM-DD" });
    if (limited(ip, "history", 60, 60000)) return send(res, 429, { error: "請求過於頻繁" });
    const h = await src.getHistory(code.toUpperCase(), start, end);
    return send(res, 200, Object.assign({}, h, { demo: DEMO }), { "Cache-Control": "public, max-age=300" });
  }
  if (p === "/analyze" && req.method === "POST") {
    if (limited(ip, "analyze", 30, 60000)) return send(res, 429, { error: "分析次數過於頻繁，請稍後再試" });
    const body = await readBody(req);
    if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 20) return send(res, 400, { error: "請輸入股票代號" });
    const a = await analyze(src, body.code);
    return send(res, 200, Object.assign({}, a, { aiReady: ai.enabled() }));
  }
  if (p === "/analyze-ai" && req.method === "POST") {
    if (!ai.enabled()) return send(res, 200, { text: null, reason: "AI 未啟用（未設定 ANTHROPIC_API_KEY）" });
    const body = await readBody(req, 512 * 1024); // 相容舊前端：它會把整包資料傳回來，但這裡只信任 code
    if (!validCode(String(body.code || "").trim())) return send(res, 400, { error: "代號格式錯誤" });
    const code = String(body.code).trim().toUpperCase();
    // 只用伺服器端自己算的資料組提示詞，不採用用戶端傳來的數字（避免提示詞注入與濫用）
    const a = await analyze(src, code);
    // 重複點同一檔會命中 30 分鐘快取，不會重複計費；只有真的要呼叫模型時才算一次額度
    const hit = cacheAge("ai:" + code);
    if (!hit && limited(ip, "ai", 12, 3600000)) return send(res, 429, { text: null, error: "AI 分析次數已達每小時上限" });
    try {
      const text = await cached("ai:" + code, 30 * 60000, async () => { const t = await ai.generateReport(a); if (!t) throw new Error("AI 未產生有效報告"); return t; });
      return send(res, 200, { text, model: "ai" });
    } catch (e) { console.error("[ai]", e.status || "", e.message); return send(res, 200, { text: null, reason: "AI 報告產生失敗，已保留規則式報告" }); }
  }
  return null; // 不是 API
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method Not Allowed" });
  let rel; try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, { error: "Bad Request" }); }
  if (rel.endsWith("/")) rel += "index.html";
  let file = path.join(STATIC, path.normalize(rel));
  if (!file.startsWith(STATIC + path.sep)) return send(res, 403, { error: "Forbidden" }); // 防目錄穿越
  if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html"; // /backtest → backtest.html
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "<h1>404</h1><p><a href='/'>回首頁</a></p>", { "Content-Type": MIME[".html"] });
    send(res, 200, req.method === "HEAD" ? "" : buf, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", "X-Frame-Options": "SAMEORIGIN" });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const origin = req.headers.origin;
  if (ORIGINS.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && ORIGINS.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" }); return res.end(); }
  try {
    const handled = await api(req, res, url, ip);
    if (handled === null) serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 502;
    if (status >= 500) console.error("[error]", req.method, url.pathname, e.message);
    if (!res.headersSent) send(res, status, { error: e.status ? e.message : "資料來源暫時無法連線，請稍後再試（" + String(e.message).slice(0, 80) + "）" });
  }
});
server.requestTimeout = 90000;
if (require.main === module) server.listen(PORT, () => console.log(`[yoe-stock] http://localhost:${PORT}  demo=${DEMO} ai=${ai.enabled()} static=${STATIC}`));
module.exports = { server, search };
