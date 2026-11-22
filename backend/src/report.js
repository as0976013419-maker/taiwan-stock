"use strict";
// 規則式報告產生器 v5.1：把數據轉成前端可解析的「=== 段落」文字（共 31 段）。
// 所有數字都直接來自後端計算結果；沒有資料的項目顯示「—」，不估計、不補值。
// 多空方向（stance）與標籤（tags）以結構化欄位回傳，前端不再從文字裡猜。
const { pctStr } = require("./util");
const { limitUpPrice, roundTick, groupState } = require("./scoring");
const Q = require("./quant");

const ok = (v) => v !== null && v !== undefined && isFinite(v);
const f = (v, d = 2) => (ok(v) ? Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d }) : "—");
const sgn = (v, d = 0) => (ok(v) ? (v > 0 ? "+" : "") + f(v, d) : "—");
const pc = (v, d = 2) => (ok(v) ? (v > 0 ? "+" : "") + Number(v).toFixed(d) + "%" : "—");
const p0 = (v, d = 1) => (ok(v) ? Number(v).toFixed(d) + "%" : "—");
const yi = (v) => (ok(v) ? f(v / 1e8, Math.abs(v) >= 1e10 ? 0 : 1) + " 億" : "—"); // 元 → 億元
const mark = (b) => (b === "na" ? "不適用" : b === null || b === undefined ? "資料不足" : b ? "✔ 符合" : "✘ 未符合");
/** 多個子條件的「且」：任一未符合→未符合；全部符合→符合；其餘依是否有資料不足決定 */
const andState = (...xs) => (xs.some((x) => x === false) ? false : xs.every((x) => x === true) ? true : xs.some((x) => x === null || x === undefined) ? null : "na");
/**
 * 多空方向以「類別」計票：同一類的多個價格指標高度相關，各算一票會讓價格面壓過基本面與籌碼。
 * 每個類別內部先多數決成一票；少數方也有 2 個以上類別時視為分歧，不硬湊單一方向。
 * @param groups [[類別名, [[+1|-1, 說明], ...]], ...]
 */
function voteCategories(groups) {
  const cats = [];
  for (const [name, items] of groups) { const it = items.filter(Boolean); if (!it.length) continue; const t = it.reduce((a, x) => a + x[0], 0); cats.push({ name, sign: t > 0 ? 1 : t < 0 ? -1 : 0, items: it }); }
  const nb = cats.filter((c) => c.sign > 0).length, ns = cats.filter((c) => c.sign < 0).length, conflict = nb >= 2 && ns >= 2;
  const stance = conflict ? "中性" : nb - ns >= 2 ? "偏多" : ns - nb >= 2 ? "偏空" : "中性";
  return { stance, bull: nb, bear: ns, neutral: cats.length - nb - ns, total: cats.length, conflict, categories: cats };
}
const rankTxt = (p) => (ok(p) ? `高於 ${p}% 的股票` : "—");

function buildReport(a) {
  const { quote: q, indicators: i, chip, margin, fundamentals: fu, revenue: rev, scored: sc, sector } = a;
  const qn = a.quant || {}, risk = qn.risk, rs = qn.rs, tr = qn.trend, tu = qn.turtle, ev = qn.events, fac = qn.factors || {};
  const mkt = a.market, fin = a.financials, bal = a.balance, div = a.dividends, hold = a.holding, news = a.news || [];
  const S = [], sec = (t, lines) => S.push("=== " + t + "\n" + lines.filter((x) => x !== "" && x !== null && x !== undefined && x !== false).join("\n"));
  const has = !!i, etf = !!q.isETF, P = q.price;
  const rsOf = (k) => (rs || []).find((r) => r.k === k) || {};
  const sum = (arr, k, n) => arr.slice(-n).reduce((s, r) => s + r[k], 0);
  const streak = (k, dir) => { let n = 0; for (let j = chip.length - 1; j >= 0 && (dir > 0 ? chip[j][k] > 0 : chip[j][k] < 0); j--) n++; return n; };

  // ── 趨勢模板狀態：關鍵條件（第 1～3 項）未過，即使總數高也不算趨勢成立 ──
  const trendState = !tr ? null : tr.total === 8 && tr.passed === 8 ? "full" : tr.checks[0].pass && tr.checks[1].pass && tr.checks[2].pass && tr.passed >= 6 ? "mostly" : "no";
  const trendMiss = tr ? tr.checks.map((c, k) => [k + 1, c]).filter((x) => x[1].pass !== true).map((x) => `第 ${x[0]} 項（${x[1].name}${x[1].pass === null ? "，資料不足" : ""}）`) : [];
  const trendWord = { full: "完整符合", mostly: "大致成立但不完整", no: "未成立" };
  const c5 = chip && chip.length ? sum(chip, "total", 5) : null, c20 = chip && chip.length ? sum(chip, "total", 20) : null;
  const V = (cond, yes, no) => (cond === null || cond === undefined ? null : cond ? [1, yes] : [-1, no]);
  const vote = voteCategories([
    ["價格趨勢", has ? [V(i.close > i.ma20, "站上月線", "跌破月線"), ok(i.ma60) ? V(i.close > i.ma60, "站上季線", "位於季線之下") : null, i.maBull ? [1, "均線多頭排列"] : i.maBear ? [-1, "均線空頭排列"] : null,
      trendState === "full" || trendState === "mostly" ? [1, `趨勢模板${trendWord[trendState]}`] : trendState === "no" && tr.passed <= 3 ? [-1, `趨勢模板僅符合 ${tr.passed}/${tr.total}`] : null] : []],
    ["動能", has ? [ok(i.macdHist) ? V(i.macdHist > 0, "MACD 柱狀體為正", "MACD 柱狀體為負") : null, ok(i.k) ? V(i.k > i.d, "K 值在 D 值之上", "K 值在 D 值之下") : null] : []],
    ["相對強弱", [ok(rsOf(60).excess) ? V(rsOf(60).excess > 0, "近 3 個月強於大盤", "近 3 個月弱於大盤") : null]],
    ["籌碼", [c5 !== null ? V(c5 > 0, "法人近 5 日買超", "法人近 5 日賣超") : null]],
    ["基本面", [ok(fu.revYoY) ? V(fu.revYoY >= 0, "月營收年增", "月營收年減") : null, ok(fu.epsYoY) ? V(fu.epsYoY >= 0, "單季 EPS 年增", "單季 EPS 年減") : ok(fu.epsQ) && fu.epsQ < 0 ? [-1, "單季虧損"] : null]],
    ["大盤", [mkt ? V(mkt.above200, "大盤在 200 日均線之上", "大盤在 200 日均線之下") : null]],
  ]);
  const bull = [], bear = []; for (const c of vote.categories) for (const x of c.items) (x[0] > 0 ? bull : bear).push(x[1]);
  const stance = vote.stance;

  // ── 依時間尺度拆開的判斷：短線轉弱、中線整理、長線多頭可以同時成立，不該混成一個訊號 ──
  const horizons = [], T = (cond, yes, no) => (cond === null || cond === undefined ? null : cond ? [1, yes] : [-1, no]);
  const hz = (name, span, items) => { const it = items.filter(Boolean), pros = it.filter((x) => x[0] === 1).map((x) => x[1]), cons = it.filter((x) => x[0] === -1).map((x) => x[1]), d = pros.length - cons.length;
    horizons.push({ name, span, view: it.length < 3 ? "資料不足" : d >= 2 ? "偏多" : d <= -2 ? "偏空" : "中性", pros, cons }); };
  const fb0 = chip && chip.length ? streak("foreign", 1) : 0, fs0 = chip && chip.length ? streak("foreign", -1) : 0;
  hz("短線", "1~5 日", has ? [
    T(q.changePct > 0 ? true : q.changePct < 0 ? false : null, `當日上漲 ${pc(q.changePct)}`, `當日下跌 ${pc(q.changePct)}`),
    T(i.close >= i.ma5, "收盤在 5 日線之上", "收盤跌破 5 日線"), T(i.close >= i.ma10, "收盤在 10 日線之上", "收盤跌破 10 日線"),
    T(ok(i.k) ? i.k > i.d : null, "KD 的 K 在 D 之上", "KD 的 K 在 D 之下"), T(ok(i.ret5) ? i.ret5 > 0 : null, `近 5 日 ${pc(i.ret5)}`, `近 5 日 ${pc(i.ret5)}`),
    T(c5 === null ? null : c5 > 0, `法人近 5 日買超 ${f(c5, 0)} 張`, `法人近 5 日賣超 ${f(Math.abs(c5 || 0), 0)} 張`),
  ] : []);
  hz("中線", "1~8 週", has ? [
    T(i.close > i.ma20, "站上月線", "跌破月線"), T(ok(i.ma20Prev) ? i.ma20 > i.ma20Prev : null, "月線向上", "月線向下"),
    T(ok(i.ma60) ? i.close > i.ma60 : null, "站上季線", "位於季線之下"), T(ok(i.macdHist) ? i.macdHist > 0 : null, "MACD 柱狀體為正", "MACD 柱狀體為負"),
    T(ok(rsOf(60).excess) ? rsOf(60).excess > 0 : null, `近 3 個月強於大盤 ${pc(rsOf(60).excess, 1)}`, `近 3 個月弱於大盤 ${pc(rsOf(60).excess, 1)}`),
    T(c20 === null ? null : c20 > 0, `法人近 20 日買超 ${f(c20, 0)} 張`, `法人近 20 日賣超 ${f(Math.abs(c20 || 0), 0)} 張`),
    T(ok(fu.revYoY) ? fu.revYoY >= 0 : null, `月營收年增 ${pc(fu.revYoY, 1)}`, `月營收年減 ${pc(fu.revYoY, 1)}`),
  ] : []);
  hz("長線", "3~12 個月", has ? [
    T(ok(i.ma240) ? i.close > i.ma240 : null, "站上年線", "位於年線之下"),
    T(tr ? (tr.stage === 2 ? true : tr.stage === 4 ? false : null) : null, "處於第二階段（上升）", "處於第四階段（下降）"),
    T(tr ? (tr.passed >= 6 ? true : tr.passed <= 3 ? false : null) : null, `趨勢模板符合 ${tr ? tr.passed : 0}/${tr ? tr.total : 0}`, `趨勢模板僅符合 ${tr ? tr.passed : 0}/${tr ? tr.total : 0}`),
    T(ok(rsOf(250).excess) ? rsOf(250).excess > 0 : null, `近 1 年強於大盤 ${pc(rsOf(250).excess, 1)}`, `近 1 年弱於大盤 ${pc(rsOf(250).excess, 1)}`),
    T(ok(fu.epsTTMYoY) ? fu.epsTTMYoY >= 0 : null, `近四季 EPS 年增 ${pc(fu.epsTTMYoY, 1)}`, `近四季 EPS 年減 ${pc(fu.epsTTMYoY, 1)}`),
    T(mkt ? mkt.above200 : null, "大盤在 200 日均線之上", "大盤在 200 日均線之下"),
  ] : []);

  // ── 結構化標籤 ──
  const tags = [{ cls: stance === "偏多" ? "bull" : stance === "偏空" ? "bear" : "neutral", text: stance === "中性" ? "中性震盪" : "整體" + stance }];
  if (has) {
    if (i.maBull) tags.push({ cls: "bull", text: "多頭排列" }); if (i.maBear) tags.push({ cls: "bear", text: "空頭排列" });
    if (i.maCross === 1) tags.push({ cls: "bull", text: "均線黃金交叉" }); if (i.maCross === -1) tags.push({ cls: "bear", text: "均線死亡交叉" });
    if (i.volRatio >= 2) tags.push({ cls: "hot", text: "爆量 " + i.volRatio.toFixed(1) + " 倍" });
    if (i.rsi >= 80) tags.push({ cls: "warn", text: "RSI 過熱" }); if (i.rsi <= 20) tags.push({ cls: "bull", text: "RSI 超賣" });
    if (i.close >= i.hi20prev) tags.push({ cls: "bull", text: "創 20 日新高" });
  }
  if (tr) tags.push({ cls: tr.stage === 2 ? "bull" : tr.stage === 4 ? "bear" : "neutral", text: tr.stageName.replace("：", " ") });
  if (chip && chip.length) { const fb = streak("foreign", 1), fs = streak("foreign", -1); if (fb >= 3) tags.push({ cls: "bull", text: `外資連買 ${fb} 日` }); if (fs >= 3) tags.push({ cls: "bear", text: `外資連賣 ${fs} 日` }); }

  // 支撐／壓力候選
  const sup = has ? [["MA20", i.ma20], ["MA60", i.ma60], ["近 20 日低點", i.lo20], ["布林下軌", i.bollLo], ["MA240", i.ma240], ["近 60 日低點", i.lo60]].filter((x) => ok(x[1]) && x[1] < i.close).sort((x, y) => y[1] - x[1]) : [];
  const res = has ? [["前 20 日高點", i.hi20prev], ["MA20", i.ma20], ["MA60", i.ma60], ["布林上軌", i.bollUp], ["近 60 日高點", i.hi60], ["MA240", i.ma240], ["52 週高點", i.hi250]].filter((x) => ok(x[1]) && x[1] > i.close).sort((x, y) => x[1] - y[1]) : [];
  const merge = (arr) => { const out = []; for (const x of arr) { const y = out[out.length - 1]; if (y && Math.abs(x[1] / y[1] - 1) < 0.003) y[0] += "／" + x[0]; else out.push([x[0], x[1]]); } return out; };
  sup.splice(0, sup.length, ...merge(sup)); res.splice(0, res.length, ...merge(res));
  const s1 = sup[0], r1 = res[0];

  // ════════════ 行情 ════════════
  // 今日漲停價：與異常跳動偵測使用同一份官方分類（不設漲跌幅／分類無法確認的商品不計算，不假設 10%）
  const pl = (a.adjust && a.adjust.priceLimit) || Q.priceLimit(q.code, null, "沒有日 K 資料，未查詢分類");
  const luRatio = pl.known && pl.limit !== null ? Math.round((pl.limit - 0.005) * 1e4) / 1e4 : null;
  const lu = q.prevClose && luRatio ? limitUpPrice(q.prevClose, etf, luRatio) : null;
  // 各面向得分：不適用的面向寫「不適用」，不寫成 0 分
  // 不適用寫「不適用」、全部缺資料寫「資料不足」，都不寫成 0 分；部分缺資料時標示
  const part = (g, v, max) => { const st = groupState(sc, g); return st === "na" ? "不適用" : st === "missing" ? "資料不足" : `${v}/${max}${st === "partial" ? "（部分資料不足）" : ""}`; };
  const partsTxt = `基本面 ${part("fund", sc.detail._fund, 20)}、技術面 ${part("tech", sc.detail._tech, 25)}、量價 ${part("vol", sc.detail._vol, 15)}、籌碼 ${part("chip", sc.detail._chip, 20)}、融資 ${part("margin", sc.detail._margin, 10)}、題材 ${part("theme", sc.detail._theme, 10)}`;
  const scoreTxt = sc.etf ? `${sc.score} 分（適用滿分 ${sc.applicable}；ETF 不分級）` : `${sc.score} / 100（${sc.grade}）`;
  sec("行情總覽", [
    `名稱：${q.name}（${q.code}，${q.market || ""}${sector ? "・" + sector.sector : etf ? "・ETF" : ""}）`,
    `收盤：${f(P)}　漲跌：${ok(q.change) ? (q.change > 0 ? "+" : "") + f(q.change) : "—"}（${pctStr(q.changePct)}）`,
    "| 項目 | 數值 |", "|---|---|",
    `| 開盤 / 最高 / 最低 | ${f(q.open)} / ${f(q.high)} / ${f(q.low)} |`,
    `| 昨收 | ${f(q.prevClose)} |`,
    lu ? `| 今日漲停價 | ${f(lu)}（${luRatio !== 0.1 ? "漲跌幅 " + Math.round(luRatio * 100) + "%；" : ""}距現價 ${pc((lu / P - 1) * 100, 1)}） |` : q.prevClose ? `| 今日漲停價 | ${pl.known ? "不適用：" : "未計算："}${pl.basis} |` : "",
    `| 成交量 | ${f(q.volume, 0)} 張${q.realtime ? "（盤中累計）" : has && i.vma20 ? "（20 日均量 " + f(i.vma20 / 1000, 0) + " 張的 " + f(i.volRatio, 2) + " 倍）" : ""} |`,
    q.value ? `| 成交金額 | ${yi(q.value)}（${q.valueSource || ""}，${q.date || ""}） |` : `| 成交金額 | —（${q.date || "當日"} 的官方成交金額尚未取得；不以其他日期的數字代替） |`,
    fu.marketCap ? `| 市值 | ${yi(fu.marketCap)} |` : "",
    has ? (ok(i.hi250) ? `| 52 週區間 | ${f(i.lo250)} ~ ${f(i.hi250)}（近 250 個交易日；現價位於區間 ${f(i.pos250, 0)}%） |` : `| 52 週區間 | 資料不足（可用 ${i.bars} 根，需要 250 根） |`) : "",
    `| 綜合評分 | ${scoreTxt} |`,
    mkt ? `【大盤】加權指數 ${f(mkt.close, 0)}（${mkt.date}），位於 50 日均線${mkt.above50 ? "之上" : "之下"}、200 日均線${mkt.above200 ? "之上" : "之下"}；近 20 日 ${pc(mkt.ret20)}、近 60 日 ${pc(mkt.ret60)}。` : "",
    `資料時間：${q.time || q.date || "最近交易日"}${q.realtime ? "（盤中即時；成交量為當日累計，量能相關判斷改用前一完整交易日 " + (has && i.volAsOf ? i.volAsOf : "") + "）" : "（收盤）"}`,
    a.asOf ? `【各項資料日期與來源】報價 ${a.asOf.quote || "—"}（${q.source || "—"}）｜K 線 ${a.asOf.kline || "—"}（FinMind）｜法人 ${a.asOf.chip || "—"}｜融資券 ${a.asOf.margin || "—"}｜外資持股 ${a.asOf.holding || "—"}（以上 FinMind）｜月營收 ${a.asOf.revenue || "—"}｜季財報 ${a.asOf.financials || "—"}（FinMind，源自公開資訊觀測站）｜大盤 ${a.asOf.index || "—"}（加權指數）｜族群與官方估值 ${a.asOf.snapshot || "—"}（證交所／櫃買中心 OpenAPI）` : "",
    q.staleSources && q.staleSources.length ? `【資料落後】${q.staleSources.map((x) => x.source + " 仍停在 " + x.date).join("、")}；本頁報價採用 ${q.date} 的資料，落後來源的欄位（如成交金額、族群統計、官方估值）已分別標示日期或換算，不與當日數字混用。` : "",
    a.adjust && a.adjust.splits.length ? `【價格還原】依官方公告還原股數變動：${a.adjust.splits.map((x) => x.date + " " + x.type + "（參考價 " + f(x.before) + " → " + f(x.after) + "，" + x.ratio + " 倍）").join("、")}。該日之前的歷史價格與成交量已換算成現在的股數基準；之後的價格就是實際成交價。` : "",
    (() => { const u = (a.adjust && a.adjust.unexplained) || [], ux = u.filter((x) => !x.unverified), uv = u.filter((x) => x.unverified), L = (xs) => xs.slice(0, 5).map((x) => x.date + "（" + pc(x.movePct, 1) + "）").join("、") + (xs.length > 5 ? " 等 " + xs.length + " 次" : "");
      // 分類已確認：超過該商品的漲跌幅限制；分類無法確認：只能說「超過 10%」，不聲稱違反任何漲跌幅規則
      return (ux.length ? `【無法解釋的價格跳動】${L(ux)}：單日變動超過漲跌幅限制，但查無分割、面額變更、減資或股利紀錄，無法判斷是真實行情還是未收錄的公司行動，系統不做任何換算。` : "")
        + (uv.length ? `【大幅變動、無法校驗】${L(uv)}：單日變動超過 10%，查無分割、面額變更、減資或股利紀錄；${a.adjust.priceLimit ? a.adjust.priceLimit.basis : "漲跌幅分類無法確認"}，所以無法判定是正常行情還是未收錄的公司行動，這不代表違反漲跌幅規則。` : "")
        + (u.length ? `${a.adjust.cut ? "為避免跨越這個斷點，所有價格類計算（技術指標、多週期報酬、波動、回撤、歷史訊號、趨勢模板、支撐壓力）只使用 " + a.adjust.cut.from + " 起的 " + a.adjust.cut.kept + " 根 K 線（捨棄之前 " + a.adjust.cut.dropped + " 根）；回看長度超過這段資料的指標一律不計算。" : ""}` : ""); })(),
    a.adjust && !a.adjust.dividendsAvailable ? "【注意】股利資料暫時無法取得：「含息」報酬不顯示；報酬、波動、回撤與歷史訊號統計未還原除息，除息日被算成下跌，所以報酬偏低、波動與回撤偏高。" : "",
    "【可偵測範圍】只能偵測單日變動超過漲跌幅限制的公司行動；幅度在限制以內、又未收錄於資料源的股數變動（例如小比例配股）無法偵測。上市未滿 10 個交易日的資料不做偵測。" + (a.adjust && a.adjust.priceLimit ? "本檔漲跌幅依據：" + a.adjust.priceLimit.basis + (a.adjust.priceLimit.known && a.adjust.priceLimit.limit === null ? "；不設漲跌幅的商品無法用這個方法偵測，只依官方公告還原。" : "。") : ""),
    a.adjust && !a.adjust.actionsAvailable ? "【注意】官方股數變動清單暫時無法取得，若這檔股票曾分割或變更面額，長期報酬與均線會失真。" : "",
  ]);

  if (rs) {
    const beat = rs.filter((r) => ok(r.excess) && r.excess > 0).length, cnt = rs.filter((r) => ok(r.excess)).length;
    sec("多週期績效", [
      "| 期間 | 起訖（交易日數） | 個股（不含息） | 個股（含息） | 加權指數（不含息） | 超額報酬 |", "|---|---|---|---|---|---|",
      ...rs.map((r) => `| ${r.label} | ${r.from ? r.from + "～" + r.to + "（" + r.days + "）" : "—"} | ${r.note && !ok(r.ret) ? "無法計算" : pc(r.ret)} | ${pc(r.tr)} | ${pc(r.idx)} | ${pc(r.excess)} |`),
      ...rs.filter((r) => r.note).map((r) => `【${r.label}無法計算】${r.note}。`),
      "「1 年」固定為 250 個交易日，全站的一年報酬、52 週區間與趨勢模板都使用同一口徑。",
      cnt ? `【相對強弱】${cnt} 個期間中有 ${beat} 個優於大盤。${beat >= cnt - 1 ? "各週期一致領先，屬於市場上的相對強勢股。" : beat <= 1 ? "各週期多數落後，屬於相對弱勢股。" : "短中長週期的強弱不一致，需分辨是轉強初期還是轉弱初期。"}` : "大盤資料暫時無法取得，僅顯示個股報酬。",
      "【口徑】超額報酬＝個股不含息報酬 − 加權指數報酬。加權指數本身不含股利，所以用不含息對不含息比較才公平；「含息」欄是把現金股利加回後的實際報酬。" + (a.adjust && a.adjust.dividendsApplied ? `期間內已還原 ${a.adjust.dividendsApplied} 次現金股利。` : ""),
      mkt && q.date && mkt.date < q.date ? `指數資料更新至 ${mkt.date}，比個股晚一個交易日；超額報酬為近似值。` : "",
    ]);
  } else sec("多週期績效", ["歷史 K 線資料暫時無法取得。"]);

  if (has) {
    const n = (a.history || []).length, lastBar = n ? a.history[n - 1] : null;
    const pv = lastBar ? (lastBar.high + lastBar.low + lastBar.close) / 3 : null;
    sec("支撐壓力", ["| 類型 | 價位 | 距現價 | 依據 |", "|---|---|---|---|"].concat(
      res.slice(0, 4).reverse().map((x) => `| 壓力 | ${f(x[1])} | ${pc((x[1] / P - 1) * 100, 1)} | ${x[0]} |`), [`| 現價 | ${f(P)} |  |  |`],
      sup.slice(0, 4).map((x) => `| 支撐 | ${f(x[1])} | ${pc((x[1] / P - 1) * 100, 1)} | ${x[0]} |`),
      [res.length ? "" : "上方已無近期技術壓力（股價位於所有參考價位之上，屬於創高走勢）。", sup.length ? "" : "下方已無近期技術支撐（股價位於所有參考價位之下）。",
        pv ? `【隔日樞紐點】軸心 ${f(pv)}；壓力 R1 ${f(2 * pv - lastBar.low)}、R2 ${f(pv + lastBar.high - lastBar.low)}；支撐 S1 ${f(2 * pv - lastBar.high)}、S2 ${f(pv - (lastBar.high - lastBar.low))}。（由最近一根日 K 的高低收計算，短線當沖與隔日沖常用）` : "",
        risk && risk.atr14 ? `【波動參考】ATR(14) 為 ${f(risk.atr14)} 元（佔股價 ${p0(risk.atrPct, 2)}），代表近期平均每日真實波幅；支撐壓力若彼此相距不到 1 倍 ATR，實務上應視為同一區。` : ""]));
    sec("位階分析", [
      ok(i.pos250) ? `現價位於 52 週高低區間（${f(i.lo250)} ~ ${f(i.hi250)}）的 ${f(i.pos250, 0)}% 位置：${i.pos250 >= 80 ? "高位階，追價的風險報酬比較差，但強勢股常在高位階續強。" : i.pos250 <= 20 ? "低位階；低位階不等於便宜，需確認基本面沒有惡化。" : "中段位階。"}` : "",
      "| 乖離對象 | 均線價 | 乖離率 |", "|---|---|---|",
      `| 月線 MA20 | ${f(i.ma20)} | ${pc((i.close / i.ma20 - 1) * 100)} |`, ok(i.ma60) ? `| 季線 MA60 | ${f(i.ma60)} | ${pc((i.close / i.ma60 - 1) * 100)} |` : "", ok(i.ma240) ? `| 年線 MA240 | ${f(i.ma240)} | ${pc((i.close / i.ma240 - 1) * 100)} |` : "",
      risk ? `距近 ${risk.days} 個交易日收盤高點回落 ${p0(Math.abs(risk.curDD))}；同期間最大回撤 ${p0(Math.abs(risk.maxDD))}。` : "",
      fu.own ? `估值位階：目前本益比 ${f(fu.pe, 1)} 倍，位於自身近五年分布的第 ${fu.own.pePct} 百分位（中位數 ${f(fu.own.peMed, 1)} 倍）。` : "",
      ok(i.ma60) && Math.abs(i.close / i.ma60 - 1) > 0.2 ? "與季線乖離超過 20%，統計上屬於偏離均值較遠的狀態，回歸均線的壓力較大。" : "",
    ]);
  } else { sec("支撐壓力", ["無歷史資料，無法計算。"]); sec("位階分析", ["資料不足。"]); }

  // ════════════ 技術 ════════════
  if (!has) {
    sec("技術分析", ["歷史 K 線資料暫時無法取得，技術指標未計算。評分中的技術面與量價項目以「—」表示、未列入得分。"]);
    ["趨勢結構檢核", "長線趨勢分析", "市場風格判定", "歷史訊號統計", "短線分析", "中線分析", "長線分析"].forEach((t) => sec(t, ["歷史 K 線資料暫時無法取得。"]));
  } else {
    const rsiNote = i.rsi >= 80 ? "過熱區" : i.rsi <= 20 ? "超賣區" : i.rsi >= 70 ? "偏高" : i.rsi <= 30 ? "偏低" : "中性區間";
    sec("技術分析", [
      "| 指標 | 數值 | 解讀 |", "|---|---|---|",
      `| MA5 / MA10 / MA20 | ${f(i.ma5)} / ${f(i.ma10)} / ${f(i.ma20)} | 收盤${i.close >= i.ma5 ? "在" : "跌破"} MA5、${i.close >= i.ma20 ? "在" : "跌破"} MA20 |`,
      `| MA60 / MA120 / MA240 | ${f(i.ma60)} / ${f(i.ma120)} / ${f(i.ma240)} | ${i.maBull ? "短中期均線多頭排列" : i.maBear ? "短中期均線空頭排列" : "均線糾結，無明確排列"} |`,
      `| RSI(14) | ${f(i.rsi, 1)} | ${rsiNote} |`,
      `| KD(9) | K ${f(i.k, 1)} / D ${f(i.d, 1)} | ${i.kdCross === 1 ? "近三日 K 上穿 D" : i.kdCross === -1 ? "近三日 K 下穿 D" : (i.k > i.d ? "K 在 D 之上" : "K 在 D 之下")} |`,
      `| MACD(12,26,9) | DIF ${f(i.dif)} / DEA ${f(i.dea)} | 柱狀體 ${f(i.macdHist)}，${i.macdHist > i.macdHistPrev ? "較前一日增加" : "較前一日減少"}；DIF ${i.dif > 0 ? "在零軸之上" : "在零軸之下"} |`,
      `| 布林通道(20,2) | ${f(i.bollLo)} ~ ${f(i.bollUp)} | 股價${i.close > i.bollUp ? "突破上軌" : i.close < i.bollLo ? "跌破下軌" : "位於通道內"}；帶寬 ${p0((i.bollUp - i.bollLo) / i.bollMid * 100)} |`,
      risk ? `| ATR(14) | ${f(risk.atr14)} | 日均真實波幅佔股價 ${p0(risk.atrPct, 2)} |` : "",
      `| 量能${i.volPartial ? "（" + i.volAsOf + "）" : ""} | ${f(i.vol / 1000, 0)} 張 | 5 日均量 ${f(i.vma5 / 1000, 0)}、20 日均量 ${f(i.vma20 / 1000, 0)}；今日為 20 日均量 ${f(i.volRatio, 2)} 倍 |`,
      i.maCross === 1 ? "【均線】近三日 MA5 向上穿越 MA20。" : i.maCross === -1 ? "【均線】近三日 MA5 向下穿越 MA20。" : "",
      `【量價結構】近 10 日上漲日均量 ${f(i.upVolAvg / 1000, 0)} 張、下跌日均量 ${f(i.dnVolAvg / 1000, 0)} 張：${i.upVolAvg > i.dnVolAvg ? "上漲有量、下跌量縮，量價配合健康。" : "下跌日的量大於上漲日，賣壓較主動。"}`,
      `【指標一致性】${[i.close > i.ma20, i.macdHist > 0, i.k > i.d, i.rsi > 50].filter(Boolean).length} / 4 項短中期指標偏多（站上月線、MACD 柱為正、K>D、RSI>50）。`,
    ]);

    sec("趨勢結構檢核", tr ? [
      `趨勢模板符合 ${tr.passed} / ${tr.total} 項；階段判定：${tr.stageName}（150 日均線近一個月變動 ${pc(tr.slope150)}）。`,
      "| # | 條件 | 現況 | 結果 |", "|---|---|---|---|",
      ...tr.checks.map((c, k) => `| ${k + 1} | ${c.name} | ${c.detail} | ${mark(c.pass)} |`),
      trendState === "full" ? "【解讀】八項全部符合：均線由短到長依序排列且向上、股價接近高點，是該方法定義的上升趨勢。" : trendState === "mostly" ? `【解讀】關鍵條件（第 1～3 項）成立、共符合 ${tr.passed}/${tr.total} 項，但未完整符合；未符合：${trendMiss.join("、")}。` : tr.checks.slice(0, 3).some((c) => c.pass === false) ? `【解讀】關鍵條件未成立（${tr.checks.slice(0, 3).map((c, k) => [k + 1, c]).filter((x) => x[1].pass === false).map((x) => "第 " + x[0] + " 項").join("、")}），即使其他項目符合，也不屬於該方法定義的上升趨勢。` : `【解讀】符合 ${tr.passed}/${tr.total} 項，條件不足。`,
      "【階段分析】第一階段打底、第二階段上升、第三階段做頭、第四階段下降。趨勢交易只在第二階段持有，第四階段避開。",
      "說明：此檢核表是把公開出版的趨勢交易方法（趨勢模板與四階段分析）的條件寫成程式逐項比對，均線採 50／150／200 日。第 8 項原方法使用 RS 評等（全市場相對強度排名 ≥ 70），本站以相對加權指數的超額報酬替代；四階段原方法以 30 週均線判定，本站以 150 日均線近似。",
    ] : ["歷史資料不足 220 個交易日，無法進行趨勢模板檢核。"]);

    sec("長線趨勢分析", [
      ok(i.ma120) ? `半年線（MA120）${f(i.ma120)}、年線（MA240）${f(i.ma240)}。${ok(i.ma240) ? (i.ma60 > i.ma120 && i.ma120 > i.ma240 ? "季線 > 半年線 > 年線，長期均線呈上升結構。" : i.ma60 < i.ma120 && i.ma120 < i.ma240 ? "季線 < 半年線 < 年線，長期均線呈下降結構。" : "長期均線互相交錯，屬於大區間整理。") : ""}` : "資料長度不足以判斷半年線以上的趨勢。",
      tr ? `200 日均線 ${f(tr.m200)}，近一個月${tr.checks[2].pass ? "上升" : "下降或走平"}；${tr.stageName}。` : "",
      `近 250 個交易日報酬 ${ok(rsOf(250).ret) ? pc(rsOf(250).ret) + "（" + rsOf(250).from + "～" + rsOf(250).to + "）" : "無法計算"}${ok(rsOf(250).excess) ? "，相對大盤 " + pc(rsOf(250).excess) : ""}；52 週區間 ${ok(i.hi250) ? f(i.lo250) + " ~ " + f(i.hi250) : "資料不足（可用 " + i.span250 + " 根，需要 250 根）"}。`,
      ok(fac.mom12_1) ? `12-1 動能（過去 12 個月扣除最近 1 個月）為 ${pc(fac.mom12_1)}：這是學術上最常用的中長期動能定義，為正代表過去一年的贏家。` : "",
    ]);

    const hiBeta = risk && ok(risk.beta) ? (risk.beta >= 1.3 ? "高 Beta（放大大盤波動）" : risk.beta <= 0.7 ? "低 Beta（防禦型）" : "Beta 接近大盤") : null;
    sec("市場風格判定", [
      `技術結構：${i.maBull && i.ret20 > 5 ? "趨勢動能型（順勢）" : i.maBear ? "弱勢整理型" : ok(i.pos250) && i.pos250 < 30 ? "低位階整理型" : "區間震盪型"}。`,
      etf ? "屬性：ETF。" : `估值屬性：${fu.yield >= 4 && fu.pe > 0 && fu.pe <= 15 ? "偏價值／高殖利率" : fu.pe > 25 ? "偏成長（市場給予較高本益比）" : "中性"}。`,
      risk ? `波動屬性：年化波動 ${p0(risk.vol60)}（近 60 日）${hiBeta ? "，" + hiBeta + "（Beta " + f(risk.beta) + "、與大盤相關係數 " + f(risk.corr) + "）" : ""}。` : "",
      mkt ? `大盤環境：指數${mkt.above50 && mkt.above200 ? "位於 50 日與 200 日均線之上，屬於多頭環境，順勢做多的勝率較高" : !mkt.above50 && !mkt.above200 ? "位於 50 日與 200 日均線之下，屬於空頭環境，個股訊號的失敗率會上升" : "介於 50 日與 200 日均線之間，方向不明"}。` : "",
      "適用策略：趨勢動能型適合順勢與突破；區間震盪型適合支撐買、壓力賣；弱勢型的反彈以減碼或觀望為主。",
    ]);

    if (ev) {
      const act = ev.events.filter((e) => e.active && e.count > 0), b = ev.baseline;
      const cell = (h) => (h && h.n ? `${h.win}% / ${pc(h.mean)}（n=${h.n}）` : "—");
      const small = (h) => (h && h.smallSample ? "（樣本少）" : "");
      const ST = (e) => (e.stateNow === null ? "單日事件" : e.stateNow ? "條件目前仍成立" : "條件目前已不成立");
      sec("歷史訊號統計", [
        `以這檔股票自己過去 ${ev.years} 年（${ev.bars} 個交易日）的還原權息日 K 回算。進場價＝訊號隔日開盤價，持有 5／10／20 個交易日後以收盤價出場。表格為「歷史上漲比例 / 平均毛報酬（已走完持有期的樣本數）」，未扣交易成本。`,
        "| 訊號 | 事件次數 | 5 日 | 10 日 | 20 日 | 20 日不重疊事件數 | 20 日與基準差 | 顯著性 | 最近一次 |", "|---|---|---|---|---|---|---|---|---|",
        `| 基準（任意一天買進） | — | ${cell(b[0])} | ${cell(b[1])} | ${cell(b[2])} | ${b[2].nonOverlap || "—"} | — | — |  |`,
        ...ev.events.filter((e) => e.count > 0).map((e) => `| ${e.active ? "★ " : ""}${e.name} | ${e.count} | ${cell(e.h[0])} | ${cell(e.h[1])} | ${cell(e.h[2])} | ${e.h[2].nonOverlap || 0}${small(e.h[2])} | ${ok(e.h[2].excess) ? pc(e.h[2].excess) : "—"} | 未驗證 | ${e.lastDate || "—"} |`),
        act.length ? "【近三個交易日內發生的事件】" + (a.intraday ? "（盤中，收盤前可能改變）" : "") + act.map((e) => { const h = e.h[2]; return `${e.name}（${e.lastDate}；${ST(e)}；20 日：${h.n ? "歷史上漲比例 " + h.win + "%、平均毛報酬 " + pc(h.mean) + "，扣除來回費稅約 " + ev.cost + "% 後 " + (ok(h.net) ? pc(h.net) : "—") : "尚無成熟樣本"}；顯著性未驗證）`; }).join("；") + "。事件發生不等於條件仍成立。" : "【近三個交易日內發生的事件】無。",
        "【顯著性】本站目前沒有實作有效的顯著性檢定：事件的持有期彼此重疊、事件與基準取自同一段價格而相依，簡單的 t 檢定不成立。舊版以「不重疊事件數」搭配「全部事件的標準差」計算 t 值，並以固定門檻 2.9 宣稱多重檢定校正，這個做法沒有根據，已移除。表中所有訊號的顯著性一律為「未驗證」；「與基準差」只是描述性的平均差，不代表訊號有效。",
        "【怎麼讀】①「歷史上漲比例」是過去資料中出現的比例，未經校準，不是未來上漲的機率。②最近 5／10／20 日內發生的事件尚未走完持有期，已排除；各欄的 n 是已成熟的樣本數，所以三欄的 n 不同。③「不重疊事件數」是持有期互不重疊的事件數，不等於彼此獨立：價格的自我相關、與基準共用同一段資料，仍讓樣本相依。④不重疊事件少於 10 次的訊號標示「樣本少」，連描述統計都很不穩定。⑤表中報酬都是未扣成本的毛報酬。",
        "【驗證範圍】只有樣本內統計：用同一段資料找規律也用它驗證。樣本外驗證（例如以前段資料決定、後段資料檢驗）尚未執行。訊號的定義與參數是常見慣例，沒有為個股調整。",
      ]);
    } else sec("歷史訊號統計", ["歷史資料不足 250 個交易日，無法進行事件統計。"]);

    // ════════════ 短中長線 ════════════
    const actS = ev ? ev.events.filter((e) => e.active && e.h[0] && e.h[0].n >= 5) : [];
    sec("短線分析", [
      `【結構】近 5 日報酬 ${pc(i.ret5)}。收盤${i.close >= i.ma5 ? "在 MA5（" + f(i.ma5) + "）之上，短線結構未破壞" : "跌破 MA5（" + f(i.ma5) + "），短線轉弱"}；MA10 在 ${f(i.ma10)}。`,
      `【動能】KD：K ${f(i.k, 1)}、D ${f(i.d, 1)}；${i.k > 80 ? "K 值高於 80，短線漲多，強勢股可能高檔鈍化，弱勢股容易拉回。" : i.k < 20 ? "K 值低於 20，短線跌深，留意反彈但不代表止跌。" : "位於中段，方向需靠量能決定。"} RSI(14) ${f(i.rsi, 1)}。`,
      `【量能】今日量為 5 日均量的 ${f(i.vol / i.vma5, 2)} 倍、20 日均量的 ${f(i.volRatio, 2)} 倍；${i.volRatio >= 1.5 && i.close > i.prevClose ? "價漲量增，短線買盤積極。" : i.volRatio >= 1.5 && i.close < i.prevClose ? "價跌量增，短線賣壓沉重。" : i.volRatio < 0.7 ? "量縮，市場觀望。" : "量能持平。"}`,
      risk ? `【波動參考】ATR(14)＝${f(risk.atr14)} 元（平均真實波幅：近 14 日每日高低波動含跳空的平均），約為股價的 ${p0(risk.atrPct, 2)}。它描述波動大小，不是報酬的信賴區間；單日漲跌超過 1 倍 ATR 並不罕見，也不必然代表有消息。` : "",
      tu ? `【突破系統】前 20 日高點 ${f(tu.hi20)}（距現價 ${pc(tu.distHi20, 1)}）、前 10 日低點 ${f(tu.lo10)}。${tu.sys1 ? "收盤已站上 20 日高點，短線突破訊號成立。" : "尚未突破 20 日高點。"}${tu.exit1 ? "收盤已跌破 10 日低點，短線出場訊號成立。" : ""}` : "",
      actS.length ? "【歷史描述統計】" + actS.map((e) => `「${e.name}」過去 ${e.h[0].n} 次（不重疊 ${e.h[0].nonOverlap} 次），5 日後歷史上漲比例 ${e.h[0].win}%、平均毛報酬 ${pc(e.h[0].mean)}（描述統計，顯著性未驗證）`).join("；") + `（基準：${ev.baseline[0].win}%、${pc(ev.baseline[0].mean)}）。` : "",
      (() => { const reclaim = [["MA5", i.ma5], ["MA10", i.ma10]].filter((x) => ok(x[1]) && x[1] > i.close), near = [["MA5", i.ma5], ["MA10", i.ma10], ["近 20 日低點", i.lo20]].filter((x) => ok(x[1]) && x[1] < i.close).sort((x, y) => y[1] - x[1])[0] || s1;
        return `【觀察重點】${r1 ? "向上看 " + f(r1[1]) + "（" + r1[0] + "）能否帶量站上" : "上方沒有近期壓力，觀察能否續創新高"}；${near ? "向下看 " + f(near[1]) + "（" + near[0] + "）是否守住" : "下方沒有近期有效支撐"}。${reclaim.length ? reclaim.map((x) => x[0] + " " + f(x[1])).join("、") + " 位於現價之上，是需要收復的壓力，不是支撐。" : ""}`; })(),
    ]);
    sec("中線分析", [
      `【趨勢】近 20 日報酬 ${pc(i.ret20)}、近 60 日報酬 ${pc(i.ret60)}。月線（MA20）${f(i.ma20)}，方向${i.ma20 > i.ma20Prev ? "向上" : "向下"}；季線（MA60）${f(i.ma60)}${ok(i.ma60Prev) ? "，方向" + (i.ma60 > i.ma60Prev ? "向上" : "向下") : ""}。`,
      `【關鍵】中線多空分界在季線：收盤${ok(i.ma60) && i.close > i.ma60 ? "位於季線之上，中期趨勢由多方主導" : "位於季線之下，中期趨勢尚未轉強"}。`,
      ok(rsOf(20).excess) ? `【相對強弱】近 1 個月相對大盤 ${pc(rsOf(20).excess)}、近 3 個月 ${pc(rsOf(60).excess)}：${rsOf(20).excess > 0 && rsOf(60).excess > 0 ? "持續領先大盤，資金有在這檔股票上。" : rsOf(20).excess < 0 && rsOf(60).excess < 0 ? "持續落後大盤。" : rsOf(20).excess > 0 ? "近一個月由弱轉強。" : "近一個月由強轉弱。"}` : "",
      c20 !== null ? `【籌碼】法人近 20 日合計${c20 >= 0 ? "買超" : "賣超"} ${f(Math.abs(c20), 0)} 張${has && i.vma20 ? "，約佔同期成交量的 " + p0(Math.abs(c20) / (i.vma20 / 1000 * 20) * 100) : ""}。` : "",
      rev && rev.yoy3 ? `【基本面動能】近三個月營收年增率 ${rev.yoy3.map((x) => pc(x, 1)).join("、")}：${rev.yoy3.every((x, k) => k === 0 || (ok(x) && ok(rev.yoy3[k - 1]) && x >= rev.yoy3[k - 1])) ? "逐月加速。" : rev.yoy3.every((x) => ok(x) && x > 0) ? "維持成長。" : "成長動能不連續。"}` : "",
      tu ? `【突破系統】前 55 日高點 ${f(tu.hi55)}（距現價 ${pc(tu.distHi55, 1)}）、前 20 日低點 ${f(tu.lo20)}。${tu.sys2 ? "收盤已站上 55 日高點，中期突破訊號成立。" : "尚未突破 55 日高點。"}` : "",
      ev && ev.baseline[2].n ? `【歷史基準】這檔股票任意一天買進持有 20 個交易日的歷史上漲比例為 ${ev.baseline[2].win}%、平均報酬 ${pc(ev.baseline[2].mean)}、中位數 ${pc(ev.baseline[2].median)}。` : "",
    ]);
    sec("長線分析", [
      ok(i.ma240) ? `【趨勢】年線（MA240）${f(i.ma240)}，股價${i.close > i.ma240 ? "在年線之上" : "在年線之下"}；近 250 個交易日報酬 ${ok(rsOf(250).ret) ? pc(rsOf(250).ret) : "無法計算"}${ok(rsOf(750).ret) ? "、近 750 個交易日 " + pc(rsOf(750).ret) : ""}。${tr ? tr.stageName + "。" : ""}` : `歷史資料 ${i.bars} 根，不足以計算年線。`,
      etf ? "ETF 的長線表現主要取決於追蹤指數與配息政策，個股型基本面指標不適用。" : `【估值】本益比 ${f(fu.pe, 1)} 倍、股價淨值比 ${f(fu.pb, 2)} 倍、殖利率 ${ok(fu.yield) ? p0(fu.yield, 2) : "—"}${fu.own ? "；本益比位於自身五年分布第 " + fu.own.pePct + " 百分位" : ""}。`,
      !etf && ok(fu.epsTTM) ? `【獲利】近四季 EPS 合計 ${f(fu.epsTTM)} 元${ok(fu.epsTTMYoY) ? "（年增 " + pc(fu.epsTTMYoY, 1) + "）" : ""}；ROE ${ok(fu.roe) ? p0(fu.roe) : "—"}。長線報酬 ≈ 獲利成長 ＋ 估值變化 ＋ 股利，三者需分開判斷。` : "",
      !etf && ok(fu.epsTTMYoY) && fu.own ? `【組合判斷】${fu.epsTTMYoY > 15 && fu.own.pePct < 50 ? "獲利成長且估值低於歷史中位數：成長尚未被完全反映在價格上。" : fu.epsTTMYoY > 15 && fu.own.pePct >= 80 ? "獲利成長但估值已在歷史高檔：好消息有相當部分已反映，需要獲利持續超出預期才能支撐。" : fu.epsTTMYoY < 0 && fu.own.pePct >= 60 ? "獲利衰退而估值偏高：最不利的組合，本益比有下修壓力。" : fu.epsTTMYoY < 0 ? "獲利衰退但估值偏低：市場已反映悲觀預期，關鍵是衰退何時結束。" : "獲利與估值都在中間地帶，沒有明顯的錯價。"}` : "",
      div && div.years.length ? `【股利】近年現金股利：${div.years.slice(-3).map((y) => y.year + " 年 " + f(y.cash) + " 元").join("、")}。` : "",
    ]);
  }

  // ════════════ 籌碼 ════════════
  if (chip && chip.length) {
    const last = chip[chip.length - 1], N = [1, 5, 10, 20, 60].filter((n) => n <= chip.length || n === 1), row = (name, k) => `| ${name} | ${N.map((n) => sgn(sum(chip, k, n))).join(" | ")} |`;
    sec("籌碼分析", [
      `三大法人買賣超（單位：張；資料日期 ${last.date}，共 ${chip.length} 個交易日）`,
      `| 法人 | ${N.map((n) => (n === 1 ? "最新一日" : "近 " + n + " 日")).join(" | ")} |`, "|" + "---|".repeat(N.length + 1),
      row("外資", "foreign"), row("投信", "trust"), row("自營商", "dealer"), row("合計", "total"),
      has && i.vma20 ? `【力道】近 20 日法人合計買賣超佔同期成交量 ${pc(c20 / (i.vma20 / 1000 * Math.min(20, chip.length)) * 100, 1)}；絕對值超過 5% 屬於法人明顯介入。` : "",
      `【買賣天數】近 20 日外資買超 ${chip.slice(-20).filter((r) => r.foreign > 0).length} 天、投信買超 ${chip.slice(-20).filter((r) => r.trust > 0).length} 天。`,
    ]);
    const fb = streak("foreign", 1), fs = streak("foreign", -1), tb = streak("trust", 1), ts = streak("trust", -1);
    // 估算成本：近 20 日買超日以「買超張數 × 當日收盤」加權（需有對應日期的 K 線）
    const px = new Map((a.history || []).map((b) => [b.date, b.close])), cost = (k) => { let v = 0, w = 0; for (const r of chip.slice(-20)) { const p = px.get(r.date); if (p && r[k] > 0) { v += r[k] * p; w += r[k]; } } return w > 0 ? v / w : null; };
    const cf = cost("foreign"), ct = cost("trust");
    sec("籌碼屬性分析", [
      fb >= 3 ? `外資已連續買超 ${fb} 日，屬於外資主導的籌碼結構。` : fs >= 3 ? `外資已連續賣超 ${fs} 日，籌碼由外資端流出。` : "外資買賣超方向不連續，沒有明確的單邊態度。",
      tb >= 3 ? `投信連續買超 ${tb} 日，有作帳或認養的可能；投信買超集中後常伴隨季底結帳賣壓。` : ts >= 3 ? `投信連續賣超 ${ts} 日。` : "投信近期未出現連續性動作。",
      cf || ct ? `【估算成本】近 20 日買超日的加權均價：${cf ? "外資約 " + f(cf) + "（現價" + (P >= cf ? "高於" : "低於") + "成本 " + p0(Math.abs(P / cf - 1) * 100) + "）" : ""}${cf && ct ? "；" : ""}${ct ? "投信約 " + f(ct) + "（現價" + (P >= ct ? "高於" : "低於") + "成本 " + p0(Math.abs(P / ct - 1) * 100) + "）" : ""}。現價跌破主要買方成本時，停損賣壓的風險上升。` : "",
      "估算成本是以每日收盤價近似，並非實際成交均價；僅供判斷法人大致的損益狀態。",
    ]);
    const f5 = sum(chip, "foreign", 5), t5 = sum(chip, "trust", 5);
    sec("法人分析", [
      `近 5 日三大法人合計${c5 >= 0 ? "買超" : "賣超"} ${f(Math.abs(c5), 0)} 張、近 20 日合計${c20 >= 0 ? "買超" : "賣超"} ${f(Math.abs(c20), 0)} 張。`,
      Math.sign(f5) !== Math.sign(t5) && f5 !== 0 && t5 !== 0 ? `外資（${sgn(f5)}）與投信（${sgn(t5)}）近 5 日方向相反，籌碼呈現土洋對作，股價容易陷入區間。` : "外資與投信近 5 日方向一致，籌碼面訊號較單純。",
      Math.sign(c5) !== Math.sign(c20) && c5 !== 0 && c20 !== 0 ? `近 5 日與近 20 日的方向相反：法人態度正在${c5 > 0 ? "由賣轉買" : "由買轉賣"}，是值得追蹤的轉折。` : "",
      has ? (c20 > 0 && i.ret20 < 0 ? "【背離】法人近 20 日買超但股價下跌：有其他賣方（散戶、大股東或融資）在出貨，或法人在逢低承接。" : c20 < 0 && i.ret20 > 0 ? "【背離】法人近 20 日賣超但股價上漲：漲勢由非法人資金推動，延續性需要觀察。" : "法人買賣方向與股價走勢一致。") : "",
    ]);
  } else {
    const t = a.instToday;
    sec("籌碼分析", t ? ["歷史序列暫時無法取得，以下僅為最近一個交易日的數字：", "| 法人 | 買賣超（張） |", "|---|---|", `| 外資 | ${sgn(t.foreign)} |`, `| 投信 | ${sgn(t.trust)} |`, `| 自營商 | ${sgn(t.dealer)} |`, `| 合計 | ${sgn(t.total)} |`] : ["三大法人資料暫時無法取得。"]);
    sec("籌碼屬性分析", ["需要多日序列才能判斷連續性，目前無資料。"]); sec("法人分析", [t ? `單日合計${t.total >= 0 ? "買超" : "賣超"} ${f(Math.abs(t.total), 0)} 張；單日數字不足以判斷趨勢。` : "無資料。"]);
  }
  sec("外資持股", hold ? [
    `外資持股比例 ${p0(hold.ratio, 2)}（${hold.date}）。`,
    "| 期間 | 持股比例變化 |", "|---|---|", `| 近 5 日 | ${pc(hold.ratio - hold.ratio5)} |`, `| 近 20 日 | ${pc(hold.ratio - hold.ratio20)} |`, `| 近 60 日 | ${pc(hold.ratio - hold.ratio60)} |`,
    `${hold.ratio - hold.ratio20 > 0.3 ? "外資持股近一個月明顯上升，屬於中期加碼。" : hold.ratio - hold.ratio20 < -0.3 ? "外資持股近一個月明顯下降，屬於中期減碼。" : "外資持股近一個月變化不大。"}（變化單位為百分點）`,
    hold.shares ? `發行股數 ${f(hold.shares / 1e8, 2)} 億股${fu.marketCap ? "，市值約 " + yi(fu.marketCap) : ""}。` : "",
  ] : ["外資持股資料暫時無法取得。"]);
  if (margin && margin.length >= 2) {
    const m = margin[margin.length - 1], at = (k) => margin[Math.max(0, margin.length - 1 - k)], use = m.limit > 0 ? m.bal / m.limit * 100 : null, p5 = at(5), p20 = at(20);
    sec("融資融券分析", [
      "| 項目 | 最新 | 近 5 日變化 | 近 20 日變化 |", "|---|---|---|---|",
      `| 融資餘額（張） | ${f(m.bal, 0)} | ${sgn(m.bal - p5.bal)} | ${sgn(m.bal - p20.bal)} |`, `| 融券餘額（張） | ${f(m.shortBal, 0)} | ${sgn(m.shortBal - p5.shortBal)} | ${sgn(m.shortBal - p20.shortBal)} |`,
      use !== null ? `融資使用率 ${p0(use)}：${use < 15 ? "偏低，散戶槓桿不高。" : use < 30 ? "中等。" : "偏高，下跌時容易出現融資斷頭賣壓。"}` : "",
      m.bal > 0 ? `券資比 ${p0(m.shortBal / m.bal * 100)}${m.shortBal / m.bal > 0.3 ? "：偏高，若股價續強可能出現軋空。" : "。"}` : "",
      has ? (m.bal < p5.bal && i.ret5 >= 0 ? "【資價關係】融資減、股價不跌：籌碼由散戶流向較穩定的持有者，屬於健康的去槓桿。" : m.bal > p5.bal && i.ret5 < 0 ? "【資價關係】融資增、股價跌：散戶逆勢加碼攤平，若續跌會累積斷頭賣壓，是籌碼面最需要警戒的組合。" : m.bal > p5.bal && i.ret5 >= 0 ? "【資價關係】融資增、股價漲：散戶追價，行情由槓桿資金推動，回檔時波動會放大。" : "【資價關係】融資減、股價跌：多殺多後的籌碼沉澱，需等融資減幅收斂。") : "",
    ]);
  } else if (a.marginToday && ok(a.marginToday.bal)) {
    const m = a.marginToday, use = m.limit > 0 ? m.bal / m.limit * 100 : null;
    sec("融資融券分析", [`融資餘額 ${f(m.bal, 0)} 張（前一日 ${f(m.prev, 0)} 張）；融券餘額 ${f(m.shortBal, 0)} 張。`, use !== null ? `融資使用率 ${p0(use)}。` : "", "多日序列暫時無法取得，僅顯示最近一個交易日。"]);
  } else sec("融資融券分析", [etf ? "此標的無個股融資融券評分資料。" : "融資融券資料暫時無法取得（或該股無信用交易資格）。"]);

  // ════════════ 基本面 ════════════
  if (etf) {
    sec("基本面分析", ["ETF 不適用個股營收、本益比等基本面指標，評分中的基本面項目以「—」表示。評估重點應放在追蹤指數、費用率、折溢價與配息來源。"]);
    sec("獲利能力", ["ETF 不適用。"]); sec("估值分析", ["ETF 不適用個股估值指標；請參考淨值與折溢價。"]);
  } else {
    sec("基本面分析", [
      rev && rev.months ? `月營收（最新 ${rev.ym}）：${yi(rev.revenue)}，年增 ${pc(rev.yoy, 1)}、月增 ${pc(rev.mom, 1)}${ok(rev.ytdYoY) ? "；今年累計年增 " + pc(rev.ytdYoY, 1) : ""}${rev.newHigh ? "；單月營收創近兩年新高" : ""}。` : `月營收年增率 ${ok(fu.revYoY) ? pc(fu.revYoY, 1) : "—"}、月增率 ${ok(fu.revMoM) ? pc(fu.revMoM, 1) : "—"}。`,
      ...(rev && rev.months ? ["| 月份 | 營收 | 年增率 | 月增率 |", "|---|---|---|---|", ...rev.months.slice(-6).map((m) => `| ${m.ym} | ${yi(m.revenue)} | ${pc(m.yoy, 1)} | ${pc(m.mom, 1)} |`)] : []),
      rev && rev.months ? `近 6 個月中有 ${rev.months.slice(-6).filter((m) => m.yoy > 0).length} 個月年增為正。` : "",
      fu.rank && ok(fu.rank.revMkt) ? `【排名】營收年增率${rankTxt(fu.rank.revMkt)}（全市場 ${fu.rank.mktCount} 檔）${ok(fu.rank.revInd) ? "、在同產業 " + fu.rank.indCount + " 檔中高於 " + fu.rank.revInd + "%" : ""}。` : "",
      "月營收是台股最即時的基本面數據（每月 10 日前公布），領先季財報；連續數月年增加速通常先於獲利上修。",
    ]);
    if (fin && fin.length) {
      const L = fin[fin.length - 1], Y = fin.length >= 5 ? fin[fin.length - 5] : null, up3 = Y && [["gm", "毛利率"], ["om", "營益率"], ["nm", "淨利率"]].map(([k, n]) => [n, ok(L[k]) && ok(Y[k]) ? L[k] - Y[k] : null]);
      sec("獲利能力", [
        "| 季別 | 營收 | 毛利率 | 營益率 | 淨利率 | EPS（元） |", "|---|---|---|---|---|---|",
        ...fin.slice(-6).map((x) => `| ${x.label} | ${yi(x.revenue)} | ${ok(x.gm) ? p0(x.gm) : "—"} | ${ok(x.om) ? p0(x.om) : "—"} | ${ok(x.nm) ? p0(x.nm) : "—"} | ${f(x.eps)} |`),
        `【EPS】最新單季（${L.label}）${f(L.eps)} 元${ok(fu.epsYoY) ? "，較去年同季 " + pc(fu.epsYoY, 1) : ""}；近四季合計 ${f(fu.epsTTM)} 元${ok(fu.epsTTMYoY) ? "，年增 " + pc(fu.epsTTMYoY, 1) : ""}。`,
        up3 && up3.every((x) => x[1] !== null) ? `【三率】與去年同季相比：${up3.map((x) => x[0] + " " + pc(x[1], 1)).join("、")}（百分點）。${up3.every((x) => x[1] > 0) ? "三率同步上升，獲利結構改善。" : up3.every((x) => x[1] < 0) ? "三率同步下滑，獲利結構惡化。" : "三率變化方向不一。"}` : "",
        `【體質】ROE（近四季淨利 ÷ 最新股東權益）${ok(fu.roe) ? p0(fu.roe) : "—"}；負債比 ${ok(fu.debtRatio) ? p0(fu.debtRatio) : "—"}；流動比率 ${ok(fu.currentRatio) ? f(fu.currentRatio, 0) + "%" : "—"}${bal ? "（資產負債表日 " + bal.date + "）" : ""}。`,
        ok(fu.roe) ? (fu.roe >= 20 ? "ROE 高於 20%，屬於高資本報酬的公司。" : fu.roe >= 10 ? "ROE 在 10%～20% 之間，屬於一般水準。" : "ROE 低於 10%，資本使用效率偏低。") : "",
        "金融、保險等行業的損益表科目不同，毛利率與營益率可能顯示「—」。",
      ]);
    } else sec("獲利能力", ["季財報資料暫時無法取得。評分中的 EPS、ROE、毛利率項目已改用替代算法（本益比高低、PB÷PE 估算、營收動能），並非實際財報數字。"]);
    const o = fu.own, rk = fu.rank || {};
    sec("估值分析", [
      "| 指標 | 目前 | 全市場位置 | 同產業位置 | 自身五年位置 |", "|---|---|---|---|---|",
      `| 本益比 | ${f(fu.pe, 1)} 倍 | ${ok(rk.peMkt) ? "第 " + rk.peMkt + " 百分位" : "—"} | ${ok(rk.peInd) ? "第 " + rk.peInd + " 百分位" : "—"} | ${o ? "第 " + o.pePct + " 百分位" : "—"} |`,
      `| 股價淨值比 | ${f(fu.pb, 2)} 倍 | ${ok(rk.pbMkt) ? "第 " + rk.pbMkt + " 百分位" : "—"} | — | ${o && ok(o.pbPct) ? "第 " + o.pbPct + " 百分位" : "—"} |`,
      `| 殖利率 | ${ok(fu.yield) ? p0(fu.yield, 2) : "—"} | ${ok(rk.yieldMkt) ? "第 " + rk.yieldMkt + " 百分位" : "—"} | — | ${o && ok(o.yieldPct) ? "第 " + o.yieldPct + " 百分位" : "—"} |`,
      "百分位越高代表數值越大：本益比與淨值比的百分位高＝相對昂貴；殖利率的百分位高＝相對便宜。",
      fu.valuationBase ? `【口徑】交易所公布的是 ${fu.valuationBase.date} 收盤 ${f(fu.valuationBase.price)} 元時的數字（本益比 ${f(fu.valuationBase.pe, 2)}、淨值比 ${f(fu.valuationBase.pb, 2)}、殖利率 ${p0(fu.valuationBase.yield, 2)}）；上表已依現價 ${f(P)} 元等比例換算。全市場與同產業的百分位，是拿換算後的數字與其他股票 ${fu.valuationBase.date} 的官方數字相比，為近似值。` : "",
      o ? `【歷史區間】近五年（自 ${o.from}）本益比的第 10 百分位為 ${f(o.peLo, 1)} 倍、中位數 ${f(o.peMed, 1)} 倍、第 90 百分位 ${f(o.peHi, 1)} 倍。` : "",
      o && ok(fu.epsTTM) && fu.epsTTM > 0 ? `【區間試算】以近四季 EPS ${f(fu.epsTTM)} 元乘上述三個本益比：${f(fu.epsTTM * o.peLo, 0)} / ${f(fu.epsTTM * o.peMed, 0)} / ${f(fu.epsTTM * o.peHi, 0)} 元（偏低 / 中位 / 偏高）；現價 ${f(P)}。` : "",
      o && ok(fu.epsTTM) && fu.epsTTM > 0 ? "這是「如果獲利不變、估值回到歷史某個水準」的機械換算，不是目標價；獲利成長或衰退時區間會跟著移動。" : "",
      ok(fu.pe) && ok(fu.epsTTMYoY) && fu.epsTTMYoY > 0 ? `本益成長比（PEG＝本益比 ÷ EPS 年增率）約 ${f(fu.pe / fu.epsTTMYoY, 2)}；一般以低於 1 視為成長相對便宜。` : "",
    ]);
  }
  sec("股利政策", div && div.years.length ? [
    "| 除權息年度 | 現金股利（元） | 股票股利（元） | 配發次數 |", "|---|---|---|---|", ...div.years.slice(-4).map((y) => `| ${y.year} | ${f(y.cash)} | ${f(y.stock)} | ${y.times} |`),
    div.lastEx ? `最近一次除息：${div.lastEx.date}，每股 ${f(div.lastEx.cash)} 元（${div.lastEx.period}）。` : "",
    ok(fu.yield) ? `目前殖利率 ${p0(fu.yield, 2)}（由交易所依最近年度股利計算）。` : "",
    div.years.length >= 3 ? (div.years.slice(-3).every((y, k, arr) => k === 0 || y.cash >= arr[k - 1].cash) ? "近三年現金股利逐年持平或增加。" : "近三年現金股利有減少的年度；當年度若尚未配完，數字會偏低。") : "",
  ] : ["股利資料暫時無法取得。"]);
  sec("產業分析", [sector ? `所屬族群「${sector.sector}」${a.asOf && a.asOf.snapshot ? a.asOf.snapshot + " " : ""}熱度 ${sector.heat}/100，在所有族群中排名第 ${sector.rank}；族群平均漲跌 ${pctStr(sector.avgChangePct)}，上漲家數比 ${Math.round(sector.upRatio * 100)}%（共 ${sector.count} 檔）。` : etf ? "ETF 不適用族群統計。" : "族群統計暫時無法取得。",
    sector && !(a.asOf && a.asOf.snapshot && q.date && a.asOf.snapshot < q.date) ? (q.changePct > sector.avgChangePct ? `個股當日（${pctStr(q.changePct)}）強於族群平均。` : `個股當日（${pctStr(q.changePct)}）弱於族群平均。`) : "",
    sector && a.asOf && a.asOf.snapshot && q.date && a.asOf.snapshot < q.date ? `族群統計為 ${a.asOf.snapshot} 的收盤資料（交易所於盤後更新），比個股報價早一個交易日，兩者不直接比較。` : "",
    fu.rank && ok(fu.rank.peInd) ? `在同產業 ${fu.rank.indCount} 檔中：本益比位於第 ${fu.rank.peInd} 百分位${ok(fu.rank.revInd) ? "、營收年增率位於第 " + fu.rank.revInd + " 百分位" : ""}。${ok(fu.rank.revInd) && fu.rank.revInd >= 70 && fu.rank.peInd <= 50 ? "成長在同業前段、估值在同業後段，屬於同業中相對有利的組合。" : ok(fu.rank.revInd) && fu.rank.revInd <= 30 && fu.rank.peInd >= 70 ? "成長在同業後段、估值卻在同業前段，相對同業偏貴。" : ""}` : "",
    "族群熱度是單日指標，僅反映當日資金流向；產業的中長期景氣需另外參考產業報告。"]);
  sec("近期新聞", news.length ? ["以下為近三日的新聞標題（依時間新到舊），系統只列出標題、不判讀內容：", ...news.map((n) => `・${n.date}　${n.title}${n.source ? "（" + n.source + "）" : ""}`), "重大訊息請以公開資訊觀測站為準。"] : ["近三日沒有取得新聞資料。重大訊息請至公開資訊觀測站查詢。"]);

  // ════════════ 風險 ════════════
  const risks = [];
  if (has && i.rsi >= 80) risks.push("RSI 高於 80，短線過熱，拉回機率升高。");
  if (has && i.volRatio >= 2 && q.changePct < 0) risks.push("下跌伴隨成交量明顯放大，可能是籌碼鬆動。");
  if (has && i.maBear) risks.push("均線呈下降結構，反彈容易遇到上方均線壓力。");
  if (tr && tr.stage === 4) risks.push("處於第四階段（下降趨勢），統計上逆勢做多的失敗率較高。");
  if (tr && tr.stage === 3) risks.push("長期均線走平且股價在其附近震盪，可能是做頭階段。");
  if (c5 !== null && c5 < 0 && c20 < 0) risks.push("法人近 5 日與近 20 日都站在賣方。");
  if (ok(fu.revYoY) && fu.revYoY < 0) risks.push("月營收年減，基本面動能轉弱。");
  if (ok(fu.epsYoY) && fu.epsYoY < 0) risks.push(`最新單季 EPS 年減 ${p0(Math.abs(fu.epsYoY))}。`);
  if (fu.own && fu.own.pePct >= 90) risks.push(`本益比位於自身五年第 ${fu.own.pePct} 百分位，估值已在歷史高檔，獲利不如預期時修正幅度可能較大。`);
  else if (fu.pe > 40) risks.push("本益比高於 40 倍，獲利不如預期時估值修正幅度可能較大。");
  if (ok(fu.debtRatio) && fu.debtRatio > 70 && !/金融/.test(q.industry || "")) risks.push(`負債比 ${p0(fu.debtRatio)}，財務槓桿偏高。`);
  if (has && i.pos250 >= 85) risks.push("位於 52 週區間高檔，利多鈍化風險。");
  if (risk && risk.vol60 >= 50) risks.push(`近 60 日年化波動 ${p0(risk.vol60)}，屬於高波動股，部位應相應縮小。`);
  if (risk && ok(risk.beta) && risk.beta >= 1.5) risks.push(`Beta ${f(risk.beta)}，大盤下跌時跌幅會被放大。`);
  if (risk && risk.avgValue20 < 5e7) risks.push(`近 20 日日均成交值僅 ${yi(risk.avgValue20)}，流動性偏低，大單進出會有明顯滑價。`);
  if (margin && margin.length >= 6 && has) { const m = margin[margin.length - 1], p = margin[margin.length - 6]; if (m.bal > p.bal && i.ret5 < 0) risks.push("融資增加而股價下跌，累積斷頭賣壓。"); }
  if (mkt && !mkt.above200) risks.push("大盤位於 200 日均線之下，系統性風險偏高。");
  risks.push("突發事件（法說會、財報、政策、國際股市、匯率）不在本模型評估範圍內；個股的單日跳空無法用停損完全控制。");
  sec("風險分析", risks.map((r, n) => (n + 1) + ". " + r));

  if (risk) {
    const pos = 1000000;
    sec("量化風險指標", [
      `以近 ${risk.days} 個交易日的日報酬計算：`,
      "| 指標 | 數值 | 說明 |", "|---|---|---|",
      `| ATR(14) | ${f(risk.atr14)} 元（${p0(risk.atrPct, 2)}） | 平均每日真實波幅 |`,
      `| 年化波動率 | 20 日 ${p0(risk.vol20)}／60 日 ${p0(risk.vol60)}／250 日 ${ok(risk.vol250) ? p0(risk.vol250) : "資料不足"} | ${!ok(risk.vol250) ? "長期波動資料不足，無法比較" : risk.vol20 > risk.vol250 * 1.3 ? "近期波動明顯高於長期，處於波動擴張期" : risk.vol20 < risk.vol250 * 0.7 ? "近期波動明顯低於長期，處於波動收斂期（常出現在大行情之前）" : "近期波動與長期相近"} |`,
      `| Beta／相關係數 | ${f(risk.beta)}／${f(risk.corr)} | 相對加權指數；Beta>1 代表波動大於大盤 |`,
      `| 最大回撤（近 ${risk.days} 日） | ${p0(risk.maxDD)} | 期間內由高點到低點的最大跌幅 |`,
      `| 目前回撤 | ${p0(risk.curDD)} | 距近 ${risk.days} 個交易日收盤高點 |`,
      `| 單日 VaR 95% | ${p0(risk.var95, 2)} | 歷史上 95% 的交易日跌幅不超過此值 |`,
      `| 單日 CVaR 95% | ${p0(risk.cvar95, 2)} | 最差 5% 交易日的平均跌幅 |`,
      `| 最大單日跌幅／漲幅 | ${p0(risk.worstDay, 2)}／${pc(risk.bestDay)} |  |`,
      `| 最大向下跳空 | ${p0(risk.worstGap, 2)} | 開盤相對前一日收盤；停損單無法防範的部分 |`,
      `| 夏普比率／索提諾比率 | ${f(risk.sharpe)}／${f(risk.sortino)} | 以無風險利率 0 計算的年化值 |`,
      `| 上漲日比例 | ${f(risk.upDayRatio, 0)}% |  |`,
      `| 日均成交值（20 日） | ${yi(risk.avgValue20)} | 流動性 |`,
      `【換算成金額】持有 ${f(pos, 0)} 元部位時：正常單日波動約 ±${f(pos * risk.atrPct / 100, 0)} 元；歷史上最差 5% 的交易日平均虧損約 ${f(Math.abs(pos * risk.cvar95 / 100), 0)} 元；若重演同期間最大回撤，帳面虧損約 ${f(Math.abs(pos * risk.maxDD / 100), 0)} 元。`,
      `VaR 以歷史模擬法計算，假設未來的報酬分布與過去 ${risk.days} 個交易日相似；極端事件的損失可能超過上列數字。`,
    ]);
    const stops = []; if (s1) stops.push(["跌破 " + s1[0], s1[1] * 0.99]); if (tu) stops.push(["海龜 2N", P - 2 * tu.N]);
    const sz = Q.sizing(P, risk.atr14, stops, 1000000, 1, (x) => roundTick(x, etf, -1));
    const gap = ok(risk.worstGap) ? Math.abs(risk.worstGap) : null;
    sec("部位規模試算", sz && sz.length ? [
      "固定比例風險法：先決定「這筆交易最多虧多少」，再由停損距離反推可以買多少。以本金 100 萬元、單筆風險 1%（1 萬元）為例：",
      "| 停損方式 | 停損價 | 停損距離 | 可買股數（整張＋零股） | 部位金額 | 佔本金 | 跳空壓力損失（佔本金） |", "|---|---|---|---|---|---|---|",
      ...sz.map((x) => { const sh = x.weight > 100 ? Math.floor(1000000 / P) : x.shares, val = sh * P, loss = gap === null ? null : val * Math.max(x.distPct, gap) / 100;
        return `| ${x.name} | ${f(x.stop)} | ${p0(x.distPct)} | ${f(sh, 0)} 股（${Math.floor(sh / 1000)} 張＋${sh % 1000} 股） | ${f(val, 0)} 元${x.weight > 100 ? "（受本金上限限制）" : ""} | ${p0(Math.min(x.weight, 100))} | ${loss === null ? "—" : f(loss, 0) + " 元（" + p0(loss / 10000, 2) + "）"} |`; }),
      gap !== null ? `【跳空壓力】以近 ${risk.days} 個交易日內最大向下跳空 ${p0(gap, 2)} 估算：若開盤直接跳過停損價，實際損失約為部位 × max(停損距離, 跳空幅度)，可能超過設定的 1 萬元。停損價已取到合法升降單位（向下取）。` : "",
      "【與海龜方法的差異】上表是「停損距離對應本金 1%」；海龜原方法是「1N 的價格波動＝本金 1%」來決定一個單位，停損設在 2N 時單筆風險約為本金 2%。兩種設定的部位大小不同，請勿混用。",
      "【怎麼用】本金或風險比例不同時等比例換算：例如本金 300 萬、風險 0.5%，股數乘以 1.5。停損距離越遠，可買的股數越少——這就是波動大的股票部位要小的原因。",
      P * 1000 > 1000000 * 0.5 ? `這檔股票一張約 ${f(P * 1000, 0)} 元；上表不足一張的部分需以零股交易，零股的成交量與撮合方式與整股不同。` : "",
      risk.avgValue20 ? (() => { const big = Math.min(Math.max(...sz.map((x) => x.value)), 1000000), r = big / risk.avgValue20 * 100; return `【流動性檢查】上表最大部位約佔這檔股票日均成交值的 ${r < 0.01 ? "不到 0.01%" : p0(r, 2)}。比例低通常衝擊較小，但不保證能以預期價格成交：本站未納入委託簿深度、盤中流動性變化與漲跌停鎖死無法成交的情況。`; })() : "",
      "此為風險管理的計算示範，不是建議的部位大小；跳空開盤時實際虧損會大於設定的風險金額。",
    ] : ["資料不足，無法試算。"]);
  } else { sec("量化風險指標", ["歷史 K 線資料暫時無法取得。"]); sec("部位規模試算", ["歷史 K 線資料暫時無法取得。"]); }

  // ════════════ 策略 ════════════
  if (has) {
    const A = risk ? risk.atr14 : null, trig = r1 ? r1[1] : i.hi20prev, stopL = s1 ? s1[1] : (A ? P - 2 * A : i.ma20), R = A ? 2 * A : P - stopL;
    sec("操作策略", [
      "以下為情境推演與觀察條件，不是買賣指令；進出與部位由使用者自行決定。",
      mkt ? `【前提：大盤】${mkt.above50 && mkt.above200 ? "大盤處於多頭環境，順勢做多的條件成立。" : !mkt.above200 ? "大盤位於 200 日均線之下。順勢交易的原則是：大盤空頭時降低部位或暫停做多，因為多數個股會跟著大盤走。" : "大盤方向不明，宜降低單筆風險。"}` : "",
      `【多方情境】成立條件：收盤帶量（高於 20 日均量）站上 ${f(trig)}${r1 ? "（" + r1[0] + "）" : ""}，且法人未轉賣。${A ? "若以 " + f(trig) + " 為假設進場價、停損 2 倍 ATR（" + f(trig - R) + "，每股風險 " + f(R) + " 元），2R／3R 的算術價位為 " + f(trig + 2 * R) + "／" + f(trig + 3 * R) + "，這只是條件式算術，不代表價格會到達。" : ""}`,
      (() => { if (!A) return ""; const nx = res.find((x) => x[1] > trig * 1.003), slip = 0.1, cost = 0.585 + 2 * slip; if (!nx) return "【空間檢查】假設進場價之上沒有近期壓力，無法以壓力估算可用空間。";
        const space = nx[1] - trig, rm = space / R, net = (space - trig * cost / 100) / R;
        return `【空間檢查】從假設進場價 ${f(trig)} 到下一個壓力 ${f(nx[1])}（${nx[0]}）的空間為 ${f(space)} 元，約 ${f(rm, 2)} R；扣除來回費稅約 0.585% 與假設滑價每邊 ${slip}% 後約 ${f(net, 2)} R。${rm < 1 ? "空間不足 1R：條件成立後，到下一個壓力前的潛在報酬仍小於停損風險，能算出 2R 價位不代表這筆交易合理。" : rm < 2 ? "空間在 1R～2R 之間，2R 價位位於下一個壓力之上，需先突破該壓力。" : ""}`; })(),
      `【拉回情境】若未突破而拉回：${s1 ? "第一個支撐 " + f(s1[1]) + "（" + s1[0] + "）" + (sup[1] ? "、第二個 " + f(sup[1][1]) + "（" + sup[1][0] + "）" : "") + "。" + (A && r1 ? "若在支撐附近進場、停損設在支撐下方 1 倍 ATR（" + f(s1[1] - A) + "），到上方壓力 " + f(r1[1]) + " 約 " + f((r1[1] - s1[1]) / A, 2) + " R（未扣費稅）。" : "") : "下方沒有近期技術支撐，拉回的深度難以預估。"}`,
      `【空方／風險情境】成立條件：${s1 ? "收盤跌破 " + f(s1[1]) + "（" + s1[0] + "）" : "反彈無法站回月線 " + f(i.ma20)}且量能放大；${sup[1] ? "下一個支撐在 " + f(sup[1][1]) + "（" + sup[1][0] + "）。" : "下方支撐不明確。"}`,
      `【反證條件】目前判斷為「${stance}」。若${stance === "偏多" ? (s1 ? "收盤跌破 " + f(s1[1]) : "跌破月線") + "，或法人轉為連續賣超、營收年增轉負" : stance === "偏空" ? (r1 ? "帶量站回 " + f(r1[1]) : "站回月線") + "且法人轉買" : "價格帶量脫離 " + (s1 ? f(s1[1]) : "—") + " ~ " + (r1 ? f(r1[1]) : "—") + " 區間"}，代表這個看法已經失效，應重新評估而不是加碼攤平。`,
      "【紀律】先定停損與部位、再進場（見「部位規模試算」）；虧損的部位不加碼；獲利的部位以移動停損（例如 10 日低點或 2 倍 ATR）保護，讓獲利延續。",
      ev && ev.baseline[2].n ? `【基準】這檔股票歷史上任意一天買進持有 20 個交易日，上漲比例為 ${ev.baseline[2].win}%、平均毛報酬 ${pc(ev.baseline[2].mean)}（樣本內）。這是比較用的基準，不是對下一筆交易的預測。` : "",
    ]);
  } else sec("操作策略", ["資料不足，暫不提供情境推演。"]);

  // 交易方法檢核表
  const cs = [];
  if (!etf) {
    const e6 = rsOf(120).excess, e3 = rsOf(60).excess;
    const cState = !ok(fu.epsQ) ? null : fu.epsQ <= 0 ? false : ok(fu.epsYoY) ? fu.epsYoY >= 25 : fu.epsYoYNote && /不適用/.test(fu.epsYoYNote) ? "na" : null;
    const cText = !ok(fu.epsQ) ? "無財報資料" : fu.epsQ <= 0 ? `本季 EPS ${f(fu.epsQ)} 元（虧損）` : ok(fu.epsYoY) ? pc(fu.epsYoY, 1) : `本季 EPS ${f(fu.epsQ)} 元；${fu.epsYoYNote || "資料不足"}`;
    const aEps = !ok(fu.epsTTM) ? null : fu.epsTTM <= 0 ? false : ok(fu.epsTTMYoY) ? fu.epsTTMYoY >= 25 : fu.epsTTMYoYNote && /不適用/.test(fu.epsTTMYoYNote) ? "na" : null;
    const aRoe = ok(fu.roe) ? fu.roe >= 17 : null;
    cs.push(["C 當季獲利", "單季 EPS 較去年同季成長 ≥ 25%", cText, cState, "fund"]);
    cs.push(["A 年度獲利", "近四季 EPS 年增 ≥ 25% 且 ROE ≥ 17%（替代：原方法要求近 3 年年度 EPS 每年成長，本站只比較近四季與前四季）", `${ok(fu.epsTTMYoY) ? pc(fu.epsTTMYoY, 1) : !ok(fu.epsTTM) ? "無財報資料" : fu.epsTTM <= 0 ? "近四季 EPS 合計為負" : fu.epsTTMYoYNote || "資料不足"}、ROE ${ok(fu.roe) ? p0(fu.roe) : "資料不足"}`, andState(aEps, aRoe), "fund"]);
    cs.push(["N 新高", "股價距 52 週高點 15% 以內（原方法另含新產品、新管理層等質性條件，本站未納入）", has && ok(i.hi250) ? "距高點 " + pc((P / i.hi250 - 1) * 100, 1) : "資料不足（未滿 52 週）", has && ok(i.hi250) ? P >= i.hi250 * 0.85 : null, "mkt"]);
    cs.push(["S 供需", "上漲日均量大於下跌日均量（替代：原方法看流通股數與需求）", has && ok(i.upVolAvg) && ok(i.dnVolAvg) ? `${f(i.upVolAvg / 1000, 0)} 張 vs ${f(i.dnVolAvg / 1000, 0)} 張` : "—", has && ok(i.upVolAvg) && ok(i.dnVolAvg) ? i.upVolAvg > i.dnVolAvg : null, "mkt"]);
    cs.push(["L 領導股", "近 3 個月與 6 個月都強於大盤（替代：原方法使用 RS 評等 ≥ 80）", ok(e3) ? `${pc(e3, 1)}、${pc(e6, 1)}` : "無大盤資料", ok(e3) && ok(e6) ? e3 > 0 && e6 > 0 : null, "mkt"]);
    cs.push(["I 法人", "法人近 20 日買超且外資持股上升（替代：原方法看優質機構持有家數增加）", `${c20 !== null ? sgn(c20) + " 張" : "—"}、外資持股 ${hold ? pc(hold.ratio - hold.ratio20) : "—"}`, andState(c20 !== null ? c20 > 0 : null, hold ? hold.ratio > hold.ratio20 : null), "mkt"]);
    cs.push(["M 大盤", "指數在 50 日與 200 日均線之上", mkt ? (mkt.above50 ? "50 日之上" : "50 日之下") + "、" + (mkt.above200 ? "200 日之上" : "200 日之下") : "無大盤資料", mkt ? mkt.above50 && mkt.above200 : null, "mkt"]);
  }
  const csPass = cs.filter((x) => x[3] === true).length, csTot = cs.filter((x) => x[3] === true || x[3] === false).length;
  const csNA = cs.filter((x) => x[3] === "na").length, csNull = cs.filter((x) => x[3] === null || x[3] === undefined).length;
  const fundCS = cs.filter((x) => x[4] === "fund"), mktCS = cs.filter((x) => x[4] === "mkt");
  const growth = fundCS.length ? andState(...fundCS.map((x) => x[3])) : null;
  const growthWord = growth === true ? "成立" : growth === false ? "未成立（" + fundCS.filter((x) => x[3] === false).map((x) => x[0][0]).join("、") + " 未符合）" : growth === "na" ? "不適用（比較基期為負）" : "資料不足";
  const trendOk = trendState === "full" || trendState === "mostly";

  sec("交易員檢核表", [
    "把三套公開出版、被專業交易員廣泛引用的方法寫成程式，逐條比對這檔股票目前的數據。它們回答的是「現在符不符合這套方法的進場條件」，不是任何人對這檔股票的看法。",
    tr ? `【一、趨勢模板】符合 ${tr.passed} / ${tr.total} 項，${trendWord[trendState]}；${tr.stageName}。${trendState === "full" ? "符合該方法的選股條件。" : "未達該方法要求的全數符合" + (trendMiss.length ? "（" + trendMiss.join("、") + "）" : "") + "。"}（逐項結果見「技術」分頁）` : "【一、趨勢模板】資料不足。",
    ...(cs.length ? [`【二、成長動能七項（CAN SLIM 架構的簡化版）】可判定的 ${csTot} 項中符合 ${csPass} 項${csNull ? "；資料不足 " + csNull + " 項" : ""}${csNA ? "；不適用 " + csNA + " 項" : ""}：`, "| 項目 | 條件（含本站替代說明） | 現況 | 結果 |", "|---|---|---|---|", ...cs.map((x) => `| ${x[0]} | ${x[1]} | ${x[2]} | ${mark(x[3])} |`),
      "C、A 兩項是基本面成長；N、S、L、I、M 是價格、供需、法人與大盤條件。兩組分開判讀，不以總數相加代替。這是以公開資料做的簡化代理，不等於完整重現原方法。"] : ["【二、成長動能七項】ETF 不適用。"]),
    tu ? `【三、海龜通道】N（20 日 ATR）＝${f(tu.N)}。短期系統：${tu.sys1 ? "已突破" : "未突破"} 20 日高點 ${f(tu.hi20)}，出場線為 10 日低點 ${f(tu.lo10)}；長期系統：${tu.sys2 ? "已突破" : "未突破"} 55 日高點 ${f(tu.hi55)}，出場線為 20 日低點 ${f(tu.lo20)}。原方法的停損為進場價減 2N（以現價計約 ${f(tu.stop2N)}），並以「1N 的價格波動＝本金 1%」決定一個單位。本站只提供通道價位參考，未實作原方法的分批加碼（每 0.5N 加一單位）、單位上限與前次獲利過濾規則，不等同完整交易系統。` : "",
    tr && cs.length ? `【綜合】價格趨勢（趨勢模板）：${trendWord[trendState]}；基本面成長（C、A）：${growthWord}；價格與市場面（N、S、L、I、M）：可判定 ${mktCS.filter((x) => x[3] === true || x[3] === false).length} 項中符合 ${mktCS.filter((x) => x[3] === true).length} 項。${trendOk && growth === true ? "趨勢與成長同時成立，是這些方法共同定義的型態。" : trendOk && growth === false ? "價格趨勢成立，但基本面成長條件未符合：延續性需靠基本面跟上。" : !trendOk && growth === true ? "基本面成長成立，但價格趨勢未成立：這些方法會等股價轉入上升階段後才考慮。" : !trendOk && growth === false ? "趨勢與成長條件都未成立，不符合這些方法的進場標準。" : "部分條件資料不足或不適用，無法用這些方法下結論。"}` : "",
    "重要：這些方法原本是為美股設計，門檻（如 25%、17%）直接沿用原著；套用在台股的有效性沒有經過本站回測驗證。",
  ]);

  sec("量化因子", [
    "把這檔股票放進常見的因子框架。因子是「長期統計上與報酬有關的特徵」，單一因子在個別股票、個別期間都可能失效。",
    "| 因子 | 指標 | 數值 | 位置／解讀 |", "|---|---|---|---|",
    `| 動能 | 12-1 個月報酬 | ${pc(fac.mom12_1)} | ${ok(fac.mom12_1) ? (fac.mom12_1 > 20 ? "強動能" : fac.mom12_1 > 0 ? "正動能" : "負動能") : "—"} |`,
    `| 動能 | 6 個月／3 個月報酬 | ${pc(fac.mom6)}／${pc(fac.mom3)} | ${ok(rsOf(120).excess) ? "6 個月相對大盤 " + pc(rsOf(120).excess) : "—"} |`,
    `| 短期反轉 | 近 1 個月報酬 | ${pc(fac.rev1m)} | ${ok(fac.rev1m) ? (fac.rev1m > 15 ? "短期漲幅大，統計上有回吐傾向" : fac.rev1m < -15 ? "短期跌幅大，統計上有反彈傾向" : "中性") : "—"} |`,
    etf ? "" : `| 價值 | 本益比 | ${f(fu.pe, 1)} 倍 | ${fu.rank && ok(fu.rank.peMkt) ? "全市場第 " + fu.rank.peMkt + " 百分位（越低越便宜）" : "—"} |`,
    etf ? "" : `| 價值 | 股價淨值比／殖利率 | ${f(fu.pb, 2)} 倍／${ok(fu.yield) ? p0(fu.yield, 2) : "—"} | ${fu.rank && ok(fu.rank.yieldMkt) ? "殖利率在全市場第 " + fu.rank.yieldMkt + " 百分位" : "—"} |`,
    etf ? "" : `| 品質 | ROE／毛利率／負債比 | ${ok(fu.roe) ? p0(fu.roe) : "—"}／${ok(fu.gm) ? p0(fu.gm) : "—"}／${ok(fu.debtRatio) ? p0(fu.debtRatio) : "—"} | ${ok(fu.roe) ? (fu.roe >= 15 ? "高品質" : fu.roe >= 8 ? "中等" : "偏低") : "—"} |`,
    etf ? "" : `| 成長 | 營收年增／EPS 年增 | ${ok(fu.revYoY) ? pc(fu.revYoY, 1) : "—"}／${ok(fu.epsYoY) ? pc(fu.epsYoY, 1) : "—"} | ${fu.rank && ok(fu.rank.revMkt) ? "營收年增在全市場第 " + fu.rank.revMkt + " 百分位" : "—"} |`,
    risk ? `| 低波動 | 250 日年化波動／Beta | ${ok(risk.vol250) ? p0(risk.vol250) : "資料不足"}／${f(risk.beta)} | ${!ok(risk.vol250) ? "—" : risk.vol250 < 25 ? "低波動" : risk.vol250 < 40 ? "中等波動" : "高波動"} |` : "",
    risk ? `| 流動性 | 日均成交值 | ${yi(risk.avgValue20)} | ${risk.avgValue20 >= 1e9 ? "高流動性" : risk.avgValue20 >= 1e8 ? "中等" : "偏低"} |` : "",
    fu.marketCap ? `| 規模 | 市值 | ${yi(fu.marketCap)} | ${fu.marketCap >= 1e11 ? "大型股" : fu.marketCap >= 1e10 ? "中型股" : "小型股"} |` : "",
    "百分位是與當日全市場個股比較；動能與波動為個股自身的時間序列值，未做橫斷面排名。",
  ]);

  sec("綜合分析", [
    `綜合評分 ${scoreTxt}：${partsTxt}。`,
    `（適用滿分 ${sc.applicable}；其中 ${sc.applicable - sc.known} 分的項目資料不足、未計分${sc.naKeys && sc.naKeys.length ? "；ETF 不適用基本面與題材項目，這部分不計分也不從分母扣除，分數不宜與個股直接比較" : ""}。）`,
    ...vote.categories.map((c) => `【${c.name}：${c.sign > 0 ? "偏多" : c.sign < 0 ? "偏空" : "互相抵銷"}】` + c.items.map((x) => x[1]).join("、")),
    has && tr && sc.detail._tech <= 5 && trendOk ? "【時間尺度】評分的技術面（站上月線、月線與季線方向、20 日突破）衡量 1～3 個月的結構，目前偏弱；趨勢模板衡量 50～200 日的長期結構，目前仍成立。兩者不矛盾，代表長期趨勢中的短中期修正。" : "",
    has && tr && sc.detail._tech >= 20 && trendState === "no" ? "【時間尺度】短中期技術面偏強，但長期趨勢模板未成立：屬於長期結構尚未轉強時的反彈或初升。" : "",
    tr || cs.length ? `【方法檢核】趨勢模板 ${tr ? tr.passed + "/" + tr.total + "（" + trendWord[trendState] + "）" : "—"}；成長動能七項 ${cs.length ? csPass + "/" + csTot + "（基本面成長：" + growthWord + "）" : "不適用"}${tr ? "；" + tr.stageName : ""}。` : "",
    risk ? `【風險輪廓】60 日年化波動 ${p0(risk.vol60)}、Beta ${f(risk.beta)}、近 ${risk.days} 個交易日最大回撤 ${p0(risk.maxDD)}。` : "",
    a.missing && a.missing.length ? "【資料缺口】" + a.missing.join("、") + "；相關段落與評分項目未計入。" : "",
    "本報告為規則式分析：只陳述數據符合哪些條件與歷史統計，不包含對新聞、法說會或產業事件的判讀。",
  ]);
  const hzLine = (h) => `【${h.name}（${h.span}）：${h.view}】支持：${h.pros.length ? h.pros.join("、") : "無"}｜相反：${h.cons.length ? h.cons.join("、") : "無"}`;
  sec("最終裁定", [
    `${stance === "中性" ? "中性震盪" : stance}（整體，綜合短中長期）：${vote.total} 個類別中 ${vote.bull} 個偏多、${vote.bear} 個偏空、${vote.neutral} 個互相抵銷。${vote.conflict ? "多空兩方都有 2 個以上類別支持，屬於分歧，不硬湊單一方向。" : ""}`,
    "每個類別（價格趨勢、動能、相對強弱、籌碼、基本面、大盤）只算一票，避免高度相關的價格指標重複計票。不同時間尺度的結論可能不同，請依自己的持有期間看對應的那一行：",
    ...horizons.map(hzLine),
    horizons.length === 3 && new Set(horizons.map((h) => h.view)).size > 1 ? `【週期不一致】${horizons.map((h) => h.name + h.view).join("、")}。這不是矛盾：${horizons[2].view === "偏多" && horizons[0].view === "偏空" ? "長期趨勢仍在但短線正在修正，對長線持有者是觀察支撐是否守住，對短線交易者則是逆風。" : horizons[2].view === "偏空" && horizons[0].view === "偏多" ? "長期趨勢向下中的短線反彈，延續性通常較差。" : "代表趨勢正在轉換或整理，方向尚未確立。"}` : "",
    `【判斷失效條件】${r1 ? "收盤站上 " + f(r1[1]) + "（" + r1[0] + "）" : "續創新高"}會削弱偏空的看法；${s1 ? "收盤跌破 " + f(s1[1]) + "（" + s1[0] + "）" : "跌破近期低點"}會削弱偏多的看法。`,
    `【證據強度】①整體方向是「類別票數」，各週期方向是「條件數量」，都沒有加權，也沒有經過回測證明能預測漲跌；它們不是機率。②歷史訊號統計只有描述統計，沒有有效的顯著性檢定，不能作為裁定的證據。③基本面與估值數字來自官方與財報，屬於事實；「偏多／偏空」是對這些事實的機械歸納，屬於推論。`,
    "這是依固定規則計算的結果，屬於機率性判斷而非預測，請搭配回測系統與自己的研究使用。",
  ]);
  return { text: S.join("\n\n"), stance, tags, horizons, stanceDetail: { bull: vote.bull, bear: vote.bear, neutral: vote.neutral, total: vote.total, conflict: vote.conflict, categories: vote.categories.map((c) => ({ name: c.name, sign: c.sign, items: c.items.map((x) => x[1]) })) } };
}
module.exports = { buildReport, voteCategories, andState };
