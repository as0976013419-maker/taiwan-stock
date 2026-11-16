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
/** 民國日期 "1151113" → "2026-11-13" */
const rocDate = (v) => { const m = String(v || "").match(/^(\d{2,3})(\d{2})(\d{2})$/); return m ? (1911 + +m[1]) + "-" + m[2] + "-" + m[3] : String(v || ""); };
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
      value: num(pick(r, ["TradeValue", "成交金額"])) || 0, date: rocDate(pick(r, ["Date"])),
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
      value: num(pick(r, ["TransactionAmount", "TradeValue"])) || 0, date: rocDate(pick(r, ["Date"])),
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
    // 上櫃：TPEx 批次資料（欄位名含空白且不一致，用正則找）
    try {
      const rows = await fetchJson(TPEX + "/tpex_3insti_daily_trading");
      for (const r of rows || []) {
        const code = String(r.SecuritiesCompanyCode || "").trim(); if (!code) continue;
        const find = (re) => { for (const k in r) if (re.test(k.replace(/\s/g, ""))) return Math.round((num(r[k]) || 0) / 1000); return 0; };
        m.set(code, { foreign: find(/^ForeignInvestorsIncludeMainlandAreaInvestors-Difference$/), trust: find(/^SecuritiesInvestmentTrustCompanies-Difference$/), dealer: find(/^Dealers-Difference$/), total: find(/^TotalDifference$/), date: rocDate(r.Date) });
      }
    } catch (e) { /* 上櫃法人資料失敗不影響上市 */ }
    return m;
  });
}
async function marginMap() {
  const [a, b] = await Promise.allSettled([
    cached("twse:margin", 30 * MIN, () => fetchJson(TWSE + "/exchangeReport/MI_MARGN")),
    cached("tpex:margin", 30 * MIN, () => fetchJson(TPEX + "/tpex_mainboard_margin_balance")),
  ]);
  const rows = a.status === "fulfilled" ? a.value : [];
  const m = new Map();
  for (const r of (b.status === "fulfilled" ? b.value : []) || []) {
    const code = String(r.SecuritiesCompanyCode || "").trim(); if (!code) continue;
    m.set(code, { bal: num(r.MarginPurchaseBalance), prev: num(r.MarginPurchaseBalancePreviousDay), limit: num(r.MarginPurchaseQuota), shortBal: num(r.ShortSaleBalance), shortPrev: num(r.ShortSaleBalancePreviousDay) });
  }
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
let _fmBlockedUntil = 0;
const finmindLimited = () => Date.now() < _fmBlockedUntil;
function finmind(dataset, code, start, end) {
  if (finmindLimited()) return Promise.reject(Object.assign(new Error("FinMind 請求額度已用盡"), { quota: true }));
  const url = `${FINMIND}?dataset=${dataset}&data_id=${encodeURIComponent(code)}&start_date=${start}` + (end ? `&end_date=${end}` : "");
  const headers = process.env.FINMIND_TOKEN ? { Authorization: "Bearer " + process.env.FINMIND_TOKEN } : {};
  return fetchJson(url, { timeout: 20000, headers, retries: 0 }).then((j) => {
    if (j && j.status && j.status !== 200) throw new Error("FinMind：" + (j.msg || j.status));
    return (j && j.data) || [];
  }).catch((e) => {
    // 免金鑰每小時約 300 次；超過會回 402。熔斷 10 分鐘，期間直接回錯誤、不再打上游。
    if (/402/.test(e.message) || /upper limit/i.test(e.message)) { _fmBlockedUntil = Date.now() + 10 * MIN; throw Object.assign(new Error("FinMind 請求額度已用盡"), { quota: true }); }
    throw e;
  });
}
/** 日 K：{code,dates,opens,highs,lows,closes,volumes}（volumes 單位：股） */
async function getHistory(code, start, end) {
  return cached(`hist:${code}:${start}:${end || ""}`, 6 * HOUR, async () => { // 當日最新一根由呼叫端用快照補上，所以可以快取久一點
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
  return cached(`chip:${code}`, 2 * HOUR, async () => {
    const rows = await finmind("TaiwanStockInstitutionalInvestorsBuySell", code, daysAgo(100));
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
  return cached(`margin:${code}`, 2 * HOUR, async () => {
    const rows = await finmind("TaiwanStockMarginPurchaseShortSale", code, daysAgo(100));
    return rows.sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
      date: r.date, bal: +r.MarginPurchaseTodayBalance || 0, limit: +r.MarginPurchaseLimit || 0, shortBal: +r.ShortSaleTodayBalance || 0,
    }));
  });
}
/** 月營收（近 26 個月）→ 最新月 YoY／MoM、近 12 個月明細、今年累計年增 */
async function getRevenue(code) {
  return cached(`rev:${code}`, 6 * HOUR, async () => {
    const rows = (await finmind("TaiwanStockMonthRevenue", code, daysAgo(820))).sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length < 2) return null;
    const key = (y, m) => y + "-" + m, map = new Map(rows.map((r) => [key(r.revenue_year, r.revenue_month), +r.revenue]));
    const yoyOf = (r) => { const p = map.get(key(r.revenue_year - 1, r.revenue_month)); return p > 0 ? (+r.revenue / p - 1) * 100 : null; };
    const months = rows.map((r, i) => ({ ym: r.revenue_year + "/" + String(r.revenue_month).padStart(2, "0"), revenue: +r.revenue, yoy: round(yoyOf(r)), mom: i && +rows[i - 1].revenue > 0 ? round((+r.revenue / +rows[i - 1].revenue - 1) * 100) : null })).slice(-12);
    const last = rows[rows.length - 1], L = months[months.length - 1];
    let ytd = 0, ytdPrev = 0; for (let m = 1; m <= last.revenue_month; m++) { ytd += map.get(key(last.revenue_year, m)) || 0; ytdPrev += map.get(key(last.revenue_year - 1, m)) || 0; }
    return { ym: L.ym, revenue: L.revenue, yoy: L.yoy, mom: L.mom, yoy3: months.slice(-3).map((m) => m.yoy), months, ytdYoY: ytdPrev > 0 ? round((ytd / ytdPrev - 1) * 100) : null,
      newHigh: L.revenue >= Math.max(...rows.map((r) => +r.revenue)) };
  });
}
/** 近五年每日本益比／淨值比／殖利率（用來算「目前估值在自身歷史的位置」） */
async function getPER(code) {
  return cached(`per:${code}`, 12 * HOUR, async () => {
    const rows = await finmind("TaiwanStockPER", code, daysAgo(1830));
    const r = rows[rows.length - 1]; if (!r) return null;
    return { pe: +r.PER || null, pb: +r.PBR || null, yield: +r.dividend_yield || null, date: r.date,
      hist: { pe: rows.map((x) => +x.PER).filter((x) => x > 0), pb: rows.map((x) => +x.PBR).filter((x) => x > 0), yield: rows.map((x) => +x.dividend_yield).filter((x) => x > 0), from: rows[0].date } };
  });
}
/** 近 9 季損益表：營收、毛利、營業利益、稅後淨利、EPS（單季） */
async function getFinancials(code) {
  return cached(`fin:${code}`, 24 * HOUR, async () => {
    const rows = await finmind("TaiwanStockFinancialStatements", code, daysAgo(900));
    const by = new Map();
    for (const r of rows) { const q = by.get(r.date) || { date: r.date }; q[r.type] = +r.value; by.set(r.date, q); }
    const qs = [...by.values()].sort((a, b) => a.date.localeCompare(b.date)).map((q) => {
      const rev = q.Revenue, ni = pick(q, ["IncomeAfterTaxes", "IncomeAfterTax", "EquityAttributableToOwnersOfParent"]);
      const d = new Date(q.date), label = d.getFullYear() + "Q" + (Math.floor(d.getMonth() / 3) + 1);
      return { date: q.date, label, revenue: rev || null, gross: q.GrossProfit === undefined ? null : q.GrossProfit, opInc: q.OperatingIncome === undefined ? null : q.OperatingIncome, netInc: ni === undefined ? null : ni, eps: q.EPS === undefined ? null : q.EPS,
        gm: rev > 0 && q.GrossProfit !== undefined ? round(q.GrossProfit / rev * 100, 1) : null, om: rev > 0 && q.OperatingIncome !== undefined ? round(q.OperatingIncome / rev * 100, 1) : null, nm: rev > 0 && ni !== undefined ? round(ni / rev * 100, 1) : null };
    });
    return qs.length ? qs.slice(-9) : null;
  });
}
/** 最新一季資產負債表重點 */
async function getBalance(code) {
  return cached(`bs:${code}`, 24 * HOUR, async () => {
    const rows = await finmind("TaiwanStockBalanceSheet", code, daysAgo(420)); if (!rows.length) return null;
    const last = rows.map((r) => r.date).sort().pop(), q = {}; for (const r of rows) if (r.date === last && !/_per$/.test(r.type)) q[r.type] = +r.value;
    const equity = pick(q, ["Equity", "EquityAttributableToOwnersOfParent", "TotalEquity"]), liab = pick(q, ["Liabilities", "TotalLiabilities"]);
    return { date: last, assets: q.TotalAssets || null, liabilities: liab || null, equity: equity || (q.TotalAssets && liab ? q.TotalAssets - liab : null), curAssets: q.CurrentAssets || null, curLiab: q.CurrentLiabilities || null, cash: q.CashAndCashEquivalents || null, inventory: q.Inventories || null };
  });
}
/** 近四年現金／股票股利（依除息年度加總） */
async function getDividends(code) {
  return cached(`div:${code}`, 24 * HOUR, async () => {
    const rows = await finmind("TaiwanStockDividend", code, daysAgo(2000)); if (!rows.length) return null; // 涵蓋整段 K 線期間，供還原權息使用
    const by = new Map(), events = []; let lastEx = null;
    for (const r of rows) {
      const cash = (+r.CashEarningsDistribution || 0) + (+r.CashStatutorySurplus || 0), stock = (+r.StockEarningsDistribution || 0) + (+r.StockStatutorySurplus || 0);
      const ex = r.CashExDividendTradingDate || r.StockExDividendTradingDate || r.date, y = String(ex).slice(0, 4);
      const o = by.get(y) || { year: y, cash: 0, stock: 0, times: 0 }; o.cash += cash; o.stock += stock; o.times++; by.set(y, o);
      if (cash > 0 && r.CashExDividendTradingDate) events.push({ date: r.CashExDividendTradingDate, cash, stock: 0 });
      if (stock > 0 && r.StockExDividendTradingDate) events.push({ date: r.StockExDividendTradingDate, cash: 0, stock });
      if (r.CashExDividendTradingDate && (!lastEx || r.CashExDividendTradingDate > lastEx.date)) lastEx = { date: r.CashExDividendTradingDate, cash: round(cash, 3), period: r.year };
    }
    return { years: [...by.values()].sort((a, b) => a.year.localeCompare(b.year)).map((o) => ({ year: o.year, cash: round(o.cash, 3), stock: round(o.stock, 3), times: o.times })).slice(-5), lastEx, events };
  });
}
/** 外資持股比例與發行股數 */
async function getHolding(code) {
  return cached(`hold:${code}`, 6 * HOUR, async () => {
    const rows = (await finmind("TaiwanStockShareholding", code, daysAgo(100))).sort((a, b) => a.date.localeCompare(b.date)); if (!rows.length) return null;
    const L = rows[rows.length - 1], at = (k) => rows[Math.max(0, rows.length - 1 - k)];
    return { date: L.date, ratio: +L.ForeignInvestmentSharesRatio, ratio5: +at(5).ForeignInvestmentSharesRatio, ratio20: +at(20).ForeignInvestmentSharesRatio, ratio60: +at(60).ForeignInvestmentSharesRatio, shares: +L.NumberOfSharesIssued || null };
  });
}
/** 近三日新聞標題（排除論壇貼文與個股概覽頁） */
async function getNews(code) {
  return cached(`news:${code}`, HOUR, async () => {
    const rows = await finmind("TaiwanStockNews", code, daysAgo(3)); const seen = new Set(), out = [];
    for (const r of rows.sort((a, b) => b.date.localeCompare(a.date))) {
      const t = String(r.title || "").replace(/\s+/g, " ").trim(); if (!t || /forum|同學會|個股概覽|爆料/.test(r.link + t) || seen.has(t)) continue;
      if (!/^https?:\/\//.test(r.link || "")) continue; seen.add(t); out.push({ date: String(r.date).slice(0, 16), title: t.slice(0, 80), source: r.source || "", link: r.link }); if (out.length >= 8) break;
    }
    return out;
  });
}
/**
 * 官方股數變動清單（分割、反分割、面額變更）：全市場一次取得、快取 24 小時，所有股票共用，不佔逐檔額度。
 * @returns Map<code, [{date, before, after, type}]>
 */
async function getSplitMap() {
  return cached("splits:all", 24 * HOUR, async () => {
    const url = `${FINMIND}?dataset=TaiwanStockSplitPrice&start_date=${daysAgo(2000)}`, headers = process.env.FINMIND_TOKEN ? { Authorization: "Bearer " + process.env.FINMIND_TOKEN } : {};
    const j = await fetchJson(url, { timeout: 20000, headers, retries: 0 }); if (j && j.status && j.status !== 200) throw new Error("FinMind：" + (j.msg || j.status));
    const m = new Map();
    for (const r of (j && j.data) || []) { const b = +r.before_price, a = +r.after_price; if (!(b > 0 && a > 0)) continue; const arr = m.get(r.stock_id) || []; arr.push({ date: r.date, before: b, after: a, type: String(r.type || "").trim() || "股數變動" }); m.set(r.stock_id, arr); }
    return m;
  });
}
/** 個股減資參考價（只有在出現「超過漲跌幅限制且查無分割公告」的跳動時才查詢） */
async function getCapitalReductions(code) {
  return cached(`reduce:${code}`, 24 * HOUR, async () => {
    const rows = await finmind("TaiwanStockCapitalReductionReferencePrice", code, daysAgo(2000));
    return rows.map((r) => ({ date: r.date, before: +pick(r, ["ClosingPriceonTheLastTradingDay", "before_price"]), after: +pick(r, ["PostReductionReferencePrice", "after_price"]), type: "減資" })).filter((x) => x.before > 0 && x.after > 0);
  });
}
/** 加權指數日 K（全站共用一份） */
async function getIndex() { return getHistory("TAIEX", daysAgo(1900)); }
/** 盤中即時報價（TWSE MIS）；失敗回 null，由呼叫端退回日收盤快照 */
async function getQuote(code) {
  return cached(`quote:${code}`, 20000, async () => {
    for (const ex of ["tse", "otc"]) {
      let j; try { j = await fetchJson(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${code}.tw&json=1&delay=0`, { timeout: 6000, retries: 0 }); } catch (e) { continue; }
      const m = j && j.msgArray && j.msgArray[0]; if (!m) continue;
      const day = String(m.d || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const prev = num(m.y), price = num(m.z) || num((m.b || "").split("_")[0]) || prev; if (!price) continue;
      return {
        code, name: m.n || code, market: ex === "tse" ? "上市" : "上櫃", price, prevClose: prev,
        change: prev ? round(price - prev) : 0, changePct: prev ? round((price / prev - 1) * 100) : 0,
        open: num(m.o), high: num(m.h), low: num(m.l), volume: num(m.v) || 0, // 張
        limitUp: num(m.u), limitDown: num(m.w), date: day, time: (day + " " + (m.t || "")).trim(),
        realtime: day === ymd(taipeiNow()) && (m.t || "") < "13:30:00", // 只有交易日盤中才標示「即時」；收盤後是當日最終價
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

module.exports = { demo: false, finmindLimited, getMarketSnapshot, getHistory, getChip, getMargin, getRevenue, getPER, getFinancials, getBalance, getDividends, getHolding, getNews, getIndex, getSplitMap, getCapitalReductions, getQuote, getDisposition };
