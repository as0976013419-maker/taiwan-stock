"use strict";
// 真實資料來源層
//   全市場快照：TWSE OpenAPI、TPEx OpenAPI（免金鑰）
//   個股歷史/籌碼/融資/營收/本益比：FinMind v4（免金鑰可用，設 FINMIND_TOKEN 可提高額度）
//   盤中即時報價：TWSE MIS
// 每個上游都獨立快取、獨立失敗（Promise.allSettled），任何一個掛掉只會讓對應欄位變成「—」。
const { cached, fetchJson, num, pick, round, daysAgo, taipeiNow, ymd } = require("./util");
const INDUSTRY = require("./industries");

const TWSE = "https://openapi.twse.com.tw/v1";
const TPEX = "https://www.tpex.org.tw/openapi/v1";
const FINMIND = "https://api.finmindtrade.com/api/v4/data";
const MIN = 60000, HOUR = 3600000;

const isETF = (code) => /^00/.test(code);
const isCommon = (code) => /^\d{4}$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code); // 排除權證、特別股以外的雜項

// ── 全市場：行情 ─────────────────────────────────────────────
async function twseQuotes() {
  const rows = await cached("twse:day_all", 3 * MIN, () => fetchJson(TWSE + "/exchangeReport/STOCK_DAY_ALL"));
  const out = [];
  for (const r of rows || []) {
    const code = String(pick(r, ["Code", "證券代號"]) || "").trim(); if (!isCommon(code)) continue;
    const close = num(pick(r, ["ClosingPrice", "收盤價"])); if (!close) continue;
    const chgRaw = String(pick(r, ["Change", "漲跌價差"]) || "0");
    let change = num(chgRaw) || 0; if (/^-/.test(chgRaw.trim())) change = -Math.abs(change);
    const prev = close - change;
    out.push({
      code, name: String(pick(r, ["Name", "證券名稱"]) || code).trim(), market: "上市", isETF: isETF(code),
      price: close, change: round(change), prevClose: round(prev), changePct: prev > 0 ? round(change / prev * 100) : 0,
      open: num(pick(r, ["OpeningPrice", "開盤價"])), high: num(pick(r, ["HighestPrice", "最高價"])), low: num(pick(r, ["LowestPrice", "最低價"])),
      volume: Math.round((num(pick(r, ["TradeVolume", "成交股數"])) || 0) / 1000), // 張
      value: num(pick(r, ["TradeValue", "成交金額"])) || 0, date: String(pick(r, ["Date"]) || ""),
    });
  }
  return out;
}
async function tpexQuotes() {
  const rows = await cached("tpex:quotes", 3 * MIN, () => fetchJson(TPEX + "/tpex_mainboard_daily_close_quotes"));
  const out = [];
  for (const r of rows || []) {
    const code = String(pick(r, ["SecuritiesCompanyCode", "Code"]) || "").trim(); if (!isCommon(code)) continue;
    const close = num(pick(r, ["Close", "ClosingPrice"])); if (!close) continue;
    const change = num(pick(r, ["Change"])) || 0, prev = close - change;
    out.push({
      code, name: String(pick(r, ["CompanyName", "Name"]) || code).trim(), market: "上櫃", isETF: isETF(code),
      price: close, change: round(change), prevClose: round(prev), changePct: prev > 0 ? round(change / prev * 100) : 0,
      open: num(pick(r, ["Open"])), high: num(pick(r, ["High"])), low: num(pick(r, ["Low"])),
      volume: Math.round((num(pick(r, ["TradingShares", "TradeVolume"])) || 0) / 1000),
      value: num(pick(r, ["TransactionAmount", "TradeValue"])) || 0, date: String(pick(r, ["Date"]) || ""),
    });
  }
  return out;
}

// ── 全市場：基本面／產業／營收 ────────────────────────────────
async function valuationMap() {
  const m = new Map();
  const [a, b] = await Promise.allSettled([
    cached("twse:bwibbu", HOUR, () => fetchJson(TWSE + "/exchangeReport/BWIBBU_ALL")),
    cached("tpex:per", HOUR, () => fetchJson(TPEX + "/tpex_mainboard_peratio_analysis")),
  ]);
  for (const r of (a.status === "fulfilled" ? a.value : []) || [])
    m.set(String(r.Code).trim(), { pe: num(r.PEratio), pb: num(r.PBratio), yield: num(r.DividendYield) });
  for (const r of (b.status === "fulfilled" ? b.value : []) || [])
    m.set(String(pick(r, ["SecuritiesCompanyCode", "Code"])).trim(), { pe: num(pick(r, ["PriceEarningRatio", "PEratio"])), pb: num(pick(r, ["PriceBookRatio", "PBratio"])), yield: num(pick(r, ["YieldRatio", "DividendYield"])) });
  return m;
}
async function industryMap() {
  const m = new Map();
  const [a, b] = await Promise.allSettled([
    cached("twse:basic", 12 * HOUR, () => fetchJson(TWSE + "/opendata/t187ap03_L")),
    cached("tpex:basic", 12 * HOUR, () => fetchJson(TPEX + "/mopsfin_t187ap03_O")),
  ]);
  const add = (rows) => { for (const r of rows || []) {
    const code = String(pick(r, ["公司代號", "SecuritiesCompanyCode"]) || "").trim();
    const ind = String(pick(r, ["產業別", "SecuritiesIndustryCode"]) || "").trim();
    if (code) m.set(code, INDUSTRY[ind] || ind || "其他");
  } };
  add(a.status === "fulfilled" ? a.value : []); add(b.status === "fulfilled" ? b.value : []);
  return m;
}
async function revenueMap() {
  const m = new Map();
  const [a, b] = await Promise.allSettled([
    cached("twse:rev", 6 * HOUR, () => fetchJson(TWSE + "/opendata/t187ap05_L")),
    cached("tpex:rev", 6 * HOUR, () => fetchJson(TPEX + "/mopsfin_t187ap05_O")),
  ]);
  const add = (rows) => { for (const r of rows || []) {
    const code = String(pick(r, ["公司代號", "SecuritiesCompanyCode"]) || "").trim(); if (!code) continue;
    m.set(code, { yoy: num(pick(r, ["營業收入-去年同月增減(%)"])), mom: num(pick(r, ["營業收入-上月比較增減(%)"])), ym: String(pick(r, ["資料年月"]) || "") });
  } };
  add(a.status === "fulfilled" ? a.value : []); add(b.status === "fulfilled" ? b.value : []);
  return m;
}

// ── 全市場：三大法人（T86）／融資融券 ─────────────────────────
async function instMap() {
  return cached("twse:t86", 10 * MIN, async () => {
    const m = new Map();
    // 盤後約 15:00 後才有當日資料：往前找最近一個有資料的交易日
    for (let back = 0; back < 6; back++) {
      const d = taipeiNow(); d.setDate(d.getDate() - back);
      const ds = ymd(d).replace(/-/g, "");
      let j; try { j = await fetchJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ds}&selectType=ALLBUT0999&response=json`, { retries: 0 }); } catch (e) { continue; }
      if (!j || j.stat !== "OK" || !Array.isArray(j.data) || !j.data.length) continue;
      const f = j.fields || [], idx = (re) => f.findIndex((x) => re.test(x));
      const iF = idx(/^外陸資買賣超股數/), iF2 = idx(/^外資自營商買賣超/), iT = idx(/^投信買賣超/), iD = idx(/^自營商買賣超股數$/), iA = idx(/^三大法人買賣超/);
      for (const row of j.data) {
        const code = String(row[0]).trim(), lot = (i) => i >= 0 ? Math.round((num(row[i]) || 0) / 1000) : 0;
        m.set(code, { foreign: lot(iF) + lot(iF2), trust: lot(iT), dealer: lot(iD), total: lot(iA), date: ds });
      }
      break;
    }
    return m;
  });
}
async function marginMap() {
  const rows = await cached("twse:margin", 30 * MIN, () => fetchJson(TWSE + "/exchangeReport/MI_MARGN"));
  const m = new Map();
  for (const r of rows || []) {
    const code = String(pick(r, ["股票代號", "Code"]) || "").trim(); if (!code) continue;
    m.set(code, {
      bal: num(pick(r, ["融資今日餘額"])), prev: num(pick(r, ["融資前日餘額"])), limit: num(pick(r, ["融資限額"])),
      shortBal: num(pick(r, ["融券今日餘額"])), shortPrev: num(pick(r, ["融券前日餘額"])),
    });
  }
  return m;
}

/** 全市場快照：Map<code, row>。任何輔助資料失敗都不影響行情本身。 */
async function getMarketSnapshot() {
  return cached("snapshot", 3 * MIN, async () => {
    const [q1, q2, val, ind, rev, inst, mar] = await Promise.allSettled([twseQuotes(), tpexQuotes(), valuationMap(), industryMap(), revenueMap(), instMap(), marginMap()]);
    const quotes = [].concat(q1.status === "fulfilled" ? q1.value : [], q2.status === "fulfilled" ? q2.value : []);
    if (!quotes.length) throw new Error("行情來源暫時無法連線（TWSE/TPEx）");
    const g = (r) => (r.status === "fulfilled" ? r.value : new Map());
    const V = g(val), I = g(ind), R = g(rev), N = g(inst), M = g(mar);
    const stocks = new Map();
    for (const q of quotes) {
      const v = V.get(q.code) || {}, r = R.get(q.code) || {}, n = N.get(q.code), mg = M.get(q.code);
      stocks.set(q.code, Object.assign(q, {
        industry: q.isETF ? "ETF" : (I.get(q.code) || "其他"),
        pe: v.pe || null, pb: v.pb || null, yield: v.yield || null,
        revYoY: r.yoy === undefined ? null : r.yoy, revMoM: r.mom === undefined ? null : r.mom,
        inst: n || null, margin: mg || null,
      }));
    }
    return { stocks, asOf: new Date().toISOString(), sources: { twse: q1.status === "fulfilled", tpex: q2.status === "fulfilled" } };
  });
}

// ── 個股：FinMind ────────────────────────────────────────────
function finmind(dataset, code, start, end) {
  const url = `${FINMIND}?dataset=${dataset}&data_id=${encodeURIComponent(code)}&start_date=${start}` + (end ? `&end_date=${end}` : "");
  const headers = process.env.FINMIND_TOKEN ? { Authorization: "Bearer " + process.env.FINMIND_TOKEN } : {};
  return fetchJson(url, { timeout: 20000, headers }).then((j) => {
    if (j && j.status && j.status !== 200) throw new Error("FinMind：" + (j.msg || j.status));
    return (j && j.data) || [];
  });
}
/** 日 K：{code,dates,opens,highs,lows,closes,volumes}（volumes 單位：股） */
async function getHistory(code, start, end) {
  return cached(`hist:${code}:${start}:${end || ""}`, 30 * MIN, async () => {
    const rows = (await finmind("TaiwanStockPrice", code, start, end)).filter((r) => +r.close > 0).sort((a, b) => a.date.localeCompare(b.date));
    return {
      code, dates: rows.map((r) => r.date),
      opens: rows.map((r) => +r.open || +r.close), highs: rows.map((r) => +r.max || +r.close), lows: rows.map((r) => +r.min || +r.close),
      closes: rows.map((r) => +r.close), volumes: rows.map((r) => +r.Trading_Volume || 0),
    };
  });
}
/** 近 N 日三大法人買賣超（張），舊→新 */
async function getChip(code) {
  return cached(`chip:${code}`, 30 * MIN, async () => {
    const rows = await finmind("TaiwanStockInstitutionalInvestorsBuySell", code, daysAgo(45));
    const by = new Map();
    for (const r of rows) {
      const d = by.get(r.date) || { date: r.date, foreign: 0, trust: 0, dealer: 0 };
      const net = ((+r.buy || 0) - (+r.sell || 0)) / 1000;
      if (/^Foreign/.test(r.name)) d.foreign += net; else if (r.name === "Investment_Trust") d.trust += net; else if (/^Dealer/.test(r.name)) d.dealer += net;
      by.set(r.date, d);
    }
    return [...by.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, foreign: Math.round(d.foreign), trust: Math.round(d.trust), dealer: Math.round(d.dealer), total: Math.round(d.foreign + d.trust + d.dealer) }));
  });
}
/** 近 N 日融資融券餘額（張），舊→新 */
async function getMargin(code) {
  return cached(`margin:${code}`, 30 * MIN, async () => {
    const rows = await finmind("TaiwanStockMarginPurchaseShortSale", code, daysAgo(45));
    return rows.sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
      date: r.date, bal: +r.MarginPurchaseTodayBalance || 0, limit: +r.MarginPurchaseLimit || 0, shortBal: +r.ShortSaleTodayBalance || 0,
    }));
  });
}
/** 月營收（近 15 個月）→ 最新月的 YoY／MoM 與近 3 月 YoY */
async function getRevenue(code) {
  return cached(`rev:${code}`, 6 * HOUR, async () => {
    const rows = (await finmind("TaiwanStockMonthRevenue", code, daysAgo(520))).sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length < 2) return null;
    const key = (r) => r.revenue_year + "-" + r.revenue_month, map = new Map(rows.map((r) => [key(r), +r.revenue]));
    const yoyOf = (r) => { const p = map.get((r.revenue_year - 1) + "-" + r.revenue_month); return p > 0 ? (+r.revenue / p - 1) * 100 : null; };
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    return {
      ym: last.revenue_year + "/" + String(last.revenue_month).padStart(2, "0"), revenue: +last.revenue,
      yoy: round(yoyOf(last)), mom: prev && +prev.revenue > 0 ? round((+last.revenue / +prev.revenue - 1) * 100) : null,
      yoy3: rows.slice(-3).map((r) => round(yoyOf(r))),
    };
  });
}
async function getPER(code) {
  return cached(`per:${code}`, 6 * HOUR, async () => {
    const rows = await finmind("TaiwanStockPER", code, daysAgo(14));
    const r = rows[rows.length - 1]; if (!r) return null;
    return { pe: +r.PER || null, pb: +r.PBR || null, yield: +r.dividend_yield || null, date: r.date };
  });
}
/** 盤中即時報價（TWSE MIS）；失敗回 null，由呼叫端退回日收盤快照 */
async function getQuote(code) {
  return cached(`quote:${code}`, 20000, async () => {
    for (const ex of ["tse", "otc"]) {
      let j; try { j = await fetchJson(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${code}.tw&json=1&delay=0`, { timeout: 6000, retries: 0 }); } catch (e) { continue; }
      const m = j && j.msgArray && j.msgArray[0]; if (!m) continue;
      const prev = num(m.y), price = num(m.z) || num((m.b || "").split("_")[0]) || prev; if (!price) continue;
      return {
        code, name: m.n || code, market: ex === "tse" ? "上市" : "上櫃", price, prevClose: prev,
        change: prev ? round(price - prev) : 0, changePct: prev ? round((price / prev - 1) * 100) : 0,
        open: num(m.o), high: num(m.h), low: num(m.l), volume: num(m.v) || 0, // 張
        limitUp: num(m.u), limitDown: num(m.w), time: (m.d || "") + " " + (m.t || ""), realtime: true,
      };
    }
    return null;
  });
}
/** 處置股＋注意股清單 */
async function getDisposition() {
  return cached("disposition", 30 * MIN, async () => {
    const [p, n] = await Promise.allSettled([fetchJson(TWSE + "/announcement/punish"), fetchJson(TWSE + "/announcement/notice")]);
    const out = new Map();
    for (const r of (n.status === "fulfilled" ? n.value : []) || []) {
      const code = String(pick(r, ["Code", "證券代號"]) || "").trim(); if (!code) continue;
      out.set(code, { code, name: String(pick(r, ["Name", "證券名稱"]) || "").trim(), type: "注意股", reason: String(pick(r, ["TradingInfoForAttention", "注意交易資訊"]) || "").slice(0, 60), period: "" });
    }
    for (const r of (p.status === "fulfilled" ? p.value : []) || []) {
      const code = String(pick(r, ["Code", "證券代號"]) || "").trim(); if (!code) continue;
      out.set(code, { code, name: String(pick(r, ["Name", "證券名稱"]) || "").trim(), type: "處置股", reason: String(pick(r, ["ReasonsOfDisposition", "處置條件"]) || "").slice(0, 60), period: String(pick(r, ["DispositionPeriod", "處置起迄時間"]) || "") });
    }
    if (p.status !== "fulfilled" && n.status !== "fulfilled") throw new Error("處置/注意股來源暫時無法連線");
    return [...out.values()];
  });
}

module.exports = { demo: false, getMarketSnapshot, getHistory, getChip, getMargin, getRevenue, getPER, getQuote, getDisposition };
