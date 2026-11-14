"use strict";
// 規則式報告產生器：把數據轉成前端可解析的「=== 段落」文字。
// 沒有設定 AI 金鑰時，這就是完整報告；有金鑰時先顯示這份，再由 AI 版本取代。
// 注意：前端會掃描全文關鍵字產生標籤（多頭排列/空頭排列/黃金交叉/死亡交叉/爆量/過熱/超賣），
//       所以這些詞「只在條件成立時」才能出現在文字裡。
const { pctStr } = require("./util");
const f = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
const sgn = (v) => (v === null || v === undefined) ? "—" : (v > 0 ? "+" : "") + f(v, 0);

function buildReport(a) {
  const { quote: q, indicators: i, chip, margin, fundamentals: fu, revenue: rev, scored: sc, sector } = a;
  const S = [], sec = (t, lines) => S.push("=== " + t + "\n" + lines.filter(Boolean).join("\n"));
  const has = !!i, etf = !!q.isETF;

  // 多空條件計數（裁定與策略共用）
  const bull = [], bear = [];
  if (has) {
    (i.close > i.ma20 ? bull : bear).push(i.close > i.ma20 ? "股價站上月線" : "股價跌破月線");
    if (i.ma60 !== null) (i.close > i.ma60 ? bull : bear).push(i.close > i.ma60 ? "站上季線" : "位於季線之下");
    if (i.maBull) bull.push("均線多頭排列"); if (i.maBear) bear.push("均線空頭排列");
    if (i.macdHist !== null) (i.macdHist > 0 ? bull : bear).push(i.macdHist > 0 ? "MACD 柱狀體為正" : "MACD 柱狀體為負");
    if (i.k !== null) (i.k > i.d ? bull : bear).push(i.k > i.d ? "K 值在 D 值之上" : "K 值在 D 值之下");
  }
  const c5 = chip && chip.length ? chip.slice(-5).reduce((s, r) => s + r.total, 0) : null;
  if (c5 !== null) (c5 > 0 ? bull : bear).push("法人近五日合計" + (c5 > 0 ? "買超" : "賣超"));
  if (fu.revYoY !== null && fu.revYoY !== undefined) (fu.revYoY >= 0 ? bull : bear).push("月營收年" + (fu.revYoY >= 0 ? "增" : "減"));
  const net = bull.length - bear.length;
  const stance = net >= 3 ? "偏多" : net <= -3 ? "偏空" : "中性";

  sec("行情總覽", [
    `名稱：${q.name}（${q.code}，${q.market || ""}${sector ? "・" + sector.sector : ""}）`,
    `收盤：${f(q.price)}　漲跌：${sgn(q.change) === "—" ? "—" : (q.change > 0 ? "+" : "") + f(q.change)}（${pctStr(q.changePct)}）`,
    "| 項目 | 數值 |", "|---|---|",
    `| 開盤 / 最高 / 最低 | ${f(q.open)} / ${f(q.high)} / ${f(q.low)} |`,
    `| 昨收 | ${f(q.prevClose)} |`, `| 成交量 | ${f(q.volume, 0)} 張 |`,
    has && i.vma20 ? `| 20 日均量 | ${f(i.vma20 / 1000, 0)} 張（今日為均量的 ${f(i.volRatio, 2)} 倍） |` : "",
    `| 綜合評分 | ${sc.score} / 100（${sc.grade}） |`,
    `資料時間：${q.time || q.date || "最近交易日"}${q.realtime ? "（盤中即時）" : "（日收盤）"}`,
  ]);

  if (!has) {
    sec("技術分析", ["歷史 K 線資料暫時無法取得，技術指標未計算。評分中的技術面與量價項目以「—」表示、未列入得分。"]);
  } else {
    const rsiNote = i.rsi >= 80 ? "，進入過熱區" : i.rsi <= 20 ? "，進入超賣區" : i.rsi >= 70 ? "，偏高" : i.rsi <= 30 ? "，偏低" : "，位於中性區間";
    sec("技術分析", [
      "| 指標 | 數值 | 解讀 |", "|---|---|---|",
      `| MA5 / MA20 / MA60 | ${f(i.ma5)} / ${f(i.ma20)} / ${f(i.ma60)} | ${i.maBull ? "多頭排列" : i.maBear ? "空頭排列" : "均線糾結，無明確排列"} |`,
      `| RSI(14) | ${f(i.rsi, 1)} | ${rsiNote.slice(1)} |`,
      `| KD(9) | K ${f(i.k, 1)} / D ${f(i.d, 1)} | ${i.kdCross === 1 ? "近三日 KD 黃金交叉" : i.kdCross === -1 ? "近三日 KD 死亡交叉" : (i.k > i.d ? "K 在 D 之上" : "K 在 D 之下")} |`,
      `| MACD | DIF ${f(i.dif)} / DEA ${f(i.dea)} | 柱狀體 ${f(i.macdHist)}（${i.macdHist > i.macdHistPrev ? "較前一日放大" : "較前一日縮小"}） |`,
      `| 布林通道(20,2) | ${f(i.bollLo)} ~ ${f(i.bollUp)} | 股價${i.close > i.bollUp ? "突破上軌" : i.close < i.bollLo ? "跌破下軌" : "位於通道內"} |`,
      i.maCross === 1 ? "【均線】近三日 MA5 向上穿越 MA20，形成均線黃金交叉。" : i.maCross === -1 ? "【均線】近三日 MA5 向下穿越 MA20，形成均線死亡交叉。" : "",
      i.volRatio >= 2 ? `【量能】今日成交量為 20 日均量的 ${f(i.volRatio, 1)} 倍，屬於爆量。` : `【量能】今日量為 20 日均量的 ${f(i.volRatio, 2)} 倍。`,
    ]);
    sec("短線分析", [
      `近 5 日報酬 ${pctStr(i.ret5)}。短線以 MA5（${f(i.ma5)}）與 MA10（${f(i.ma10)}）為多空參考：收盤${i.close >= i.ma5 ? "在 MA5 之上，短線結構未破壞" : "在 MA5 之下，短線轉弱"}。`,
      `KD：K ${f(i.k, 1)}、D ${f(i.d, 1)}；${i.k > 80 ? "K 值高於 80，短線漲多，容易震盪。" : i.k < 20 ? "K 值低於 20，短線跌深，留意反彈但不代表止跌。" : "位於中段，方向需靠量能決定。"}`,
      `觀察重點：${f(i.hi20prev)}（前 20 日高點）是否帶量站上；${f(i.ma10)} 是否守住。`,
    ]);
    sec("中線分析", [
      `近 20 日報酬 ${pctStr(i.ret20)}、近 60 日報酬 ${pctStr(i.ret60)}。`,
      `月線（MA20）${f(i.ma20)}，方向${i.ma20 > i.ma20Prev ? "向上" : "向下"}；季線（MA60）${f(i.ma60)}${i.ma60Prev !== null ? "，方向" + (i.ma60 > i.ma60Prev ? "向上" : "向下") : ""}。`,
      `中線關鍵在季線：收盤${i.ma60 !== null && i.close > i.ma60 ? "位於季線之上，中期趨勢仍由多方主導" : "位於季線之下，中期趨勢尚未轉強"}。`,
    ]);
    sec("長線分析", [
      i.ma240 !== null ? `年線（MA240）${f(i.ma240)}，股價${i.close > i.ma240 ? "在年線之上" : "在年線之下"}；近一年報酬 ${pctStr(i.ret240)}。` : `歷史資料 ${i.bars} 根，不足以計算年線。`,
      etf ? "ETF 的長線表現主要取決於追蹤指數與配息政策，個股型基本面指標不適用。" : `估值：本益比 ${f(fu.pe, 1)}、股價淨值比 ${f(fu.pb, 2)}、殖利率 ${f(fu.yield, 2)}%。長線報酬來源是獲利成長與估值變化，兩者需分開判斷。`,
    ]);
    sec("長線趨勢分析", [
      i.ma120 !== null ? `半年線（MA120）${f(i.ma120)}、年線 ${f(i.ma240)}。${i.ma240 !== null ? (i.ma60 > i.ma120 && i.ma120 > i.ma240 ? "季線 > 半年線 > 年線，長期均線呈上升結構。" : i.ma60 < i.ma120 && i.ma120 < i.ma240 ? "季線 < 半年線 < 年線，長期均線呈下降結構。" : "長期均線互相交錯，屬於大區間整理。") : ""}` : "資料長度不足以判斷半年線以上的趨勢。",
      `一年區間：${f(i.lo240)} ~ ${f(i.hi240)}。`,
    ]);
  }

  // 籌碼
  if (chip && chip.length) {
    const last = chip[chip.length - 1], s5 = chip.slice(-5), sum = (k, arr) => arr.reduce((s, r) => s + r[k], 0);
    const streak = (k) => { let n = 0; for (let j = chip.length - 1; j >= 0 && chip[j][k] > 0; j--) n++; return n; };
    const sell = (k) => { let n = 0; for (let j = chip.length - 1; j >= 0 && chip[j][k] < 0; j--) n++; return n; };
    sec("籌碼分析", [
      "| 法人 | 最新一日（張） | 近 5 日合計（張） | 近 20 日合計（張） |", "|---|---|---|---|",
      `| 外資 | ${sgn(last.foreign)} | ${sgn(sum("foreign", s5))} | ${sgn(sum("foreign", chip.slice(-20)))} |`,
      `| 投信 | ${sgn(last.trust)} | ${sgn(sum("trust", s5))} | ${sgn(sum("trust", chip.slice(-20)))} |`,
      `| 自營商 | ${sgn(last.dealer)} | ${sgn(sum("dealer", s5))} | ${sgn(sum("dealer", chip.slice(-20)))} |`,
      `| 合計 | ${sgn(last.total)} | ${sgn(sum("total", s5))} | ${sgn(sum("total", chip.slice(-20)))} |`,
      `資料日期：${last.date}`,
    ]);
    const fs = streak("foreign"), ts = streak("trust"), fsell = sell("foreign"), tsell = sell("trust");
    sec("籌碼屬性分析", [
      fs >= 3 ? `外資已連續買超 ${fs} 日，屬於外資主導的籌碼結構。` : fsell >= 3 ? `外資已連續賣超 ${fsell} 日，籌碼由外資端流出。` : "外資買賣超方向不連續，沒有明確的單邊態度。",
      ts >= 3 ? `投信連續買超 ${ts} 日，有作帳或認養的可能，但需留意投信買超集中後的結帳賣壓。` : tsell >= 3 ? `投信連續賣超 ${tsell} 日。` : "投信近期未出現連續性動作。",
      "說明：「大戶持股」項目以法人近 20 日累計買超佔成交量比重作為代理指標，並非集保大戶級距的實際數字。",
    ]);
    sec("法人分析", [
      `近 5 日三大法人合計${sum("total", s5) >= 0 ? "買超" : "賣超"} ${f(Math.abs(sum("total", s5)), 0)} 張。`,
      Math.sign(sum("foreign", s5)) !== Math.sign(sum("trust", s5)) && sum("foreign", s5) !== 0 && sum("trust", s5) !== 0 ? "外資與投信方向相反，籌碼呈現土洋對作，股價容易陷入區間。" : "外資與投信方向一致，籌碼面訊號較單純。",
    ]);
  } else {
    sec("籌碼分析", ["三大法人資料暫時無法取得。"]); sec("籌碼屬性分析", ["無資料。"]); sec("法人分析", ["無資料。"]);
  }
  if (margin && margin.length >= 2) {
    const m = margin[margin.length - 1], p = margin[Math.max(0, margin.length - 6)], use = m.limit > 0 ? m.bal / m.limit * 100 : null;
    sec("融資融券分析", [
      `融資餘額 ${f(m.bal, 0)} 張（約 5 個交易日前為 ${f(p.bal, 0)} 張，${m.bal < p.bal ? "減少" : "增加"} ${f(Math.abs(m.bal - p.bal), 0)} 張）；融券餘額 ${f(m.shortBal, 0)} 張。`,
      use !== null ? `融資使用率 ${f(use, 1)}%：${use < 15 ? "偏低，散戶槓桿不高。" : use < 30 ? "中等。" : "偏高，下跌時容易出現融資斷頭賣壓。"}` : "",
      has ? (m.bal < p.bal && i.ret5 >= 0 ? "融資減、股價不跌：籌碼由散戶流向較穩定的持有者，屬於健康的去槓桿。" : m.bal > p.bal && i.ret5 < 0 ? "融資增、股價跌：散戶逆勢加碼，若續跌會累積賣壓。" : "融資與股價變化沒有出現明顯背離。") : "",
      m.bal > 0 ? `券資比 ${f(m.shortBal / m.bal * 100, 1)}%。` : "",
    ]);
  } else sec("融資融券分析", [etf ? "此標的無個股融資融券評分資料。" : "融資融券資料暫時無法取得（或該股無信用交易資格）。"]);

  // 基本面
  if (etf) sec("基本面分析", ["ETF 不適用個股營收、本益比等基本面指標，評分中的基本面項目以「—」表示。評估重點應放在追蹤指數、費用率、折溢價與配息來源。"]);
  else sec("基本面分析", [
    "| 項目 | 數值 | 評分標準 |", "|---|---|---|",
    `| 月營收年增率 | ${rev && rev.yoy !== null ? pctStr(rev.yoy) + "（" + rev.ym + "）" : fu.revYoY !== null && fu.revYoY !== undefined ? pctStr(fu.revYoY) : "—"} | ≥20% 滿分 |`,
    `| 月營收月增率 | ${fu.revMoM !== null && fu.revMoM !== undefined ? pctStr(fu.revMoM) : "—"} | 與年增同為正 → 穩定 |`,
    `| 本益比 | ${f(fu.pe, 1)} | ≤15 滿分 |`, `| 股價淨值比 | ${f(fu.pb, 2)} |  |`,
    `| ROE（估算＝PB÷PE） | ${sc.roe !== null ? f(sc.roe, 1) + "%" : "—"} | ≥15% 滿分 |`, `| 殖利率 | ${fu.yield ? f(fu.yield, 2) + "%" : "—"} |  |`,
    rev && rev.yoy3 ? `近三個月營收年增率：${rev.yoy3.map(pctStr).join("、")}。` : "",
    "限制：ROE 為由 PB 與 PE 反推的估算值；毛利率以營收動能作為代理指標。正式判斷仍應以公開資訊觀測站的財報為準。",
  ]);
  sec("產業分析", [sector ? `所屬族群「${sector.sector}」今日熱度 ${sector.heat}/100，在所有族群中排名第 ${sector.rank}；族群平均漲跌 ${pctStr(sector.avgChangePct)}，上漲家數比 ${Math.round(sector.upRatio * 100)}%（共 ${sector.count} 檔）。` : "族群統計暫時無法取得。",
    sector ? (q.changePct > sector.avgChangePct ? "個股今日表現強於族群平均。" : "個股今日表現弱於族群平均。") : "", "族群熱度是單日指標，僅反映當日資金流向。"]);
  sec("市場風格判定", [has ? `依技術結構分類：${i.maBull && i.ret20 > 5 ? "趨勢動能型（順勢）" : i.maBear ? "弱勢整理型" : i.pos240 !== null && i.pos240 < 30 ? "低位階整理型" : "區間震盪型"}。` : "資料不足，無法分類。",
    etf ? "屬性：ETF。" : (fu.yield >= 4 && fu.pe > 0 && fu.pe <= 15 ? "估值屬性：偏價值／高殖利率。" : fu.pe > 25 ? "估值屬性：偏成長（市場給予較高本益比）。" : "估值屬性：中性。")]);
  sec("位階分析", [has && i.pos240 !== null ? `現價位於近一年高低區間（${f(i.lo240)} ~ ${f(i.hi240)}）的 ${f(i.pos240, 0)}% 位置：${i.pos240 >= 80 ? "高位階，追價的風險報酬比較差。" : i.pos240 <= 20 ? "低位階，但低位階不等於便宜，需確認基本面沒有惡化。" : "中段位階。"}` : "資料不足。",
    has && i.ma60 !== null ? `與季線乖離 ${pctStr((i.close / i.ma60 - 1) * 100)}。` : ""]);

  const risks = [];
  if (has && i.rsi >= 80) risks.push("RSI 高於 80，短線過熱，拉回機率升高。");
  if (has && i.volRatio >= 2 && q.changePct < 0) risks.push("下跌伴隨成交量明顯放大，可能是籌碼鬆動。");
  if (has && i.maBear) risks.push("均線呈下降結構，反彈容易遇到上方均線壓力。");
  if (c5 !== null && c5 < 0) risks.push("法人近五日站在賣方。");
  if (fu.revYoY !== null && fu.revYoY !== undefined && fu.revYoY < 0) risks.push("月營收年減，基本面動能轉弱。");
  if (fu.pe > 40) risks.push("本益比高於 40 倍，獲利不如預期時估值修正幅度可能較大。");
  if (has && i.pos240 >= 85) risks.push("位於一年區間高檔，利多鈍化風險。");
  risks.push("系統性風險（國際股市、匯率、政策）不在本模型評估範圍內。");
  sec("風險分析", risks.map((r, n) => (n + 1) + ". " + r));

  if (has) {
    const sup = [["MA20", i.ma20], ["MA60", i.ma60], ["近 20 日低點", i.lo20], ["布林下軌", i.bollLo]].filter((x) => x[1] !== null && x[1] < i.close).sort((a, b) => b[1] - a[1]);
    const res = [["前 20 日高點", i.hi20prev], ["MA20", i.ma20], ["MA60", i.ma60], ["布林上軌", i.bollUp], ["近一年高點", i.hi240]].filter((x) => x[1] !== null && x[1] > i.close).sort((a, b) => a[1] - b[1]);
    sec("支撐壓力", ["| 類型 | 價位 | 依據 |", "|---|---|---|"].concat(res.slice(0, 3).reverse().map((x) => `| 壓力 | ${f(x[1])} | ${x[0]} |`), [`| 現價 | ${f(i.close)} |  |`], sup.slice(0, 3).map((x) => `| 支撐 | ${f(x[1])} | ${x[0]} |`),
      [res.length ? "" : "上方無近期技術壓力（股價位於各參考價位之上）。", sup.length ? "" : "下方無近期技術支撐（股價位於各參考價位之下）。"]));
    const s1 = sup[0], r1 = res[0];
    sec("操作策略", [
      "以下為情境推演與觀察條件，不是買賣指令；部位與進出由使用者自行決定。",
      `【多方情境成立條件】${r1 ? "帶量站上 " + f(r1[1]) + "（" + r1[0] + "）" : "維持在所有短中期均線之上"}，且法人買超延續。`,
      `【空方情境成立條件】${s1 ? "收盤跌破 " + f(s1[1]) + "（" + s1[0] + "）" : "反彈無法站回月線 " + f(i.ma20)}，且量能放大。`,
      `【反證條件】目前判斷為「${stance}」。若${stance === "偏多" ? (s1 ? "收盤跌破 " + f(s1[1]) : "跌破月線") + "或法人轉為連續賣超" : stance === "偏空" ? (r1 ? "帶量站回 " + f(r1[1]) : "站回月線") + "且法人轉買" : "價格帶量脫離 " + (s1 ? f(s1[1]) : "—") + " ~ " + (r1 ? f(r1[1]) : "—") + " 區間"}，代表這個看法已經失效。`,
      "【風險控管】單一標的的最大可承受虧損應在進場前決定，並換算成對應價位。",
    ]);
  } else { sec("支撐壓力", ["無歷史資料，無法計算。"]); sec("操作策略", ["資料不足，暫不提供情境推演。"]); }

  sec("綜合分析", [
    `綜合評分 ${sc.score}/100（${sc.grade}）：基本面 ${sc.detail._fund}/20、技術面 ${sc.detail._tech}/25、量價 ${sc.detail._vol}/15、籌碼 ${sc.detail._chip}/20、融資 ${sc.detail._margin}/10、題材 ${sc.detail._theme}/10。`,
    bull.length ? "【正向條件】" + bull.join("、") + "。" : "", bear.length ? "【負向條件】" + bear.join("、") + "。" : "",
    "本段為規則式摘要：只陳述數據符合哪些條件，不包含對新聞、法說會或產業事件的判讀。",
  ]);
  sec("最終裁定", [
    stance === "中性" ? `中性震盪：正向條件 ${bull.length} 項、負向條件 ${bear.length} 項，多空訊號沒有明顯一面倒。` : `${stance}：正向條件 ${bull.length} 項、負向條件 ${bear.length} 項。`,
    "這是依固定規則計算的結果，屬於機率性判斷而非預測；評分模型未經過歷史回測驗證其預測力，請搭配回測系統與自己的研究使用。",
  ]);
  return S.join("\n\n");
}
module.exports = { buildReport };
