// ═══════════════════════════════════════════════════════════════
// bt/core.js  —  台股回測核心引擎 v4.0
// ═══════════════════════════════════════════════════════════════
// 設計原則：
//   1. 純函數，無副作用，可在 Worker 中執行
//   2. Short accounting 遵循真實台股融券邏輯
//   3. 嚴格 signal/execution 分離，無 lookahead bias
//   4. Position object 完整，可擴充槓桿/分批
// ═══════════════════════════════════════════════════════════════

"use strict";

// ════════════════════════════════════════════════════════════
// ENGINE META
// ════════════════════════════════════════════════════════════
var BT_ENGINE = {
  version:    '4.2.0',
  buildDate:  '2026-05-15',
  features:   ['long','short','worker','exposure','metrics-v2'],
  // 預留接口
  _monteCarlo: null,  // Monte Carlo mode (future)
  _leverage:   null,  // Leverage mode (future)
  _multiPos:   null,  // Multi-position mode (future)
  _replay:     null,  // Bar-by-bar replay mode (future)
  _benchmark:  null,  // Benchmark vs index (future)
};

// Debug mode（localStorage 設 bt_debug=1 開啟）
var BT_DEBUG = (function() {
  try { return localStorage.getItem('bt_debug') === '1'; } catch(e) { return false; }
})();
function dbg() {
  if (!BT_DEBUG) return;
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[BT]');
  console.log.apply(console, args);
}

// ──────────────────────────────────────────────────────────────
// 1. INDICATORS ENGINE
// ──────────────────────────────────────────────────────────────

var Indicators = (function() {

  function sma(arr, p) {
    var n = arr.length;
    var r = new Array(n).fill(NaN);
    r.fill(NaN);
    if (p > n) return r;
    var s = 0;
    for (var i = 0; i < p; i++) s += arr[i];
    r[p - 1] = s / p;
    for (var i = p; i < n; i++) {
      s += arr[i] - arr[i - p];
      r[i] = s / p;
    }
    return r;
  }

  function ema(arr, p) {
    var n = arr.length;
    var r = new Array(n).fill(NaN);
    r.fill(NaN);
    var k = 2 / (p + 1);
    var cnt = 0, sum = 0;
    for (var i = 0; i < n; i++) {
      if (isNaN(arr[i])) continue;
      cnt++;
      sum += arr[i];
      if (cnt < p) continue;
      if (cnt === p) { r[i] = sum / p; continue; }
      // 找到上一個非 NaN 的 r 值
      var prev = NaN;
      for (var j = i - 1; j >= 0; j--) { if (!isNaN(r[j])) { prev = r[j]; break; } }
      r[i] = isNaN(prev) ? arr[i] : arr[i] * k + prev * (1 - k);
    }
    return r;
  }

  // Wilder RSI (correct implementation)
  function rsi(closes, p) {
    p = p || 14;
    var n = closes.length;
    var r = new Array(n).fill(NaN);
    r.fill(NaN);
    if (n < p + 2) return r;
    var ag = 0, al = 0;
    for (var i = 1; i <= p; i++) {
      var d = closes[i] - closes[i - 1];
      if (d > 0) ag += d / p;
      else       al -= d / p;
    }
    r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (var i = p + 1; i < n; i++) {
      var d = closes[i] - closes[i - 1];
      var g = d > 0 ? d : 0;
      var l = d < 0 ? -d : 0;
      ag = (ag * (p - 1) + g) / p;
      al = (al * (p - 1) + l) / p;
      r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return r;
  }

  // KD (Stochastic) — Wilder smoothing 1/3
  function kd(highs, lows, closes, p) {
    p = p || 9;
    var n = closes.length;
    var K = new Array(n).fill(NaN); K.fill(NaN);
    var D = new Array(n).fill(NaN); D.fill(NaN);
    var pk = 50, pd = 50;
    for (var i = p - 1; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - p + 1; j <= i; j++) {
        if (highs[j] > hi) hi = highs[j];
        if (lows[j]  < lo) lo = lows[j];
      }
      var rsv = hi === lo ? 50 : (closes[i] - lo) / (hi - lo) * 100;
      pk = rsv / 3 + pk * 2 / 3;
      pd = pk  / 3 + pd * 2 / 3;
      K[i] = pk; D[i] = pd;
    }
    return { k: K, d: D };
  }

  // MACD — EMA-based signal line (no zero-fill hack)
  function macd(closes, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var ef = ema(closes, fast);
    var es = ema(closes, slow);
    var n  = closes.length;
    var M  = new Array(n).fill(NaN); M.fill(NaN);
    for (var i = 0; i < n; i++) {
      if (!isNaN(ef[i]) && !isNaN(es[i])) M[i] = ef[i] - es[i];
    }
    // EMA of MACD (using only non-NaN values)
    var S = new Array(n).fill(NaN); S.fill(NaN);
    var k2 = 2 / (signal + 1), cnt = 0, sum = 0;
    for (var i = 0; i < n; i++) {
      if (isNaN(M[i])) continue;
      cnt++; sum += M[i];
      if (cnt < signal) continue;
      if (cnt === signal) { S[i] = sum / signal; continue; }
      var prev = NaN;
      for (var j = i - 1; j >= 0; j--) { if (!isNaN(S[j])) { prev = S[j]; break; } }
      S[i] = isNaN(prev) ? M[i] : M[i] * k2 + prev * (1 - k2);
    }
    var H = new Array(n).fill(NaN); H.fill(NaN);
    for (var i = 0; i < n; i++) {
      if (!isNaN(M[i]) && !isNaN(S[i])) H[i] = M[i] - S[i];
    }
    return { macd: M, signal: S, hist: H };
  }

  // Bollinger Bands
  function boll(closes, p, mult) {
    p = p || 20; mult = mult || 2;
    var n   = closes.length;
    var mid = sma(closes, p);
    var upper = new Array(n).fill(NaN); upper.fill(NaN);
    var lower = new Array(n).fill(NaN); lower.fill(NaN);
    for (var i = p - 1; i < n; i++) {
      var m = mid[i], s = 0;
      for (var j = i - p + 1; j <= i; j++) s += (closes[j] - m) * (closes[j] - m);
      var sd = Math.sqrt(s / p);
      upper[i] = m + mult * sd;
      lower[i] = m - mult * sd;
    }
    return { upper: upper, mid: mid, lower: lower };
  }

  // Williams %R
  function wr(highs, lows, closes, p) {
    p = p || 14;
    var n = closes.length;
    var r = new Array(n).fill(NaN); r.fill(NaN);
    for (var i = p - 1; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - p + 1; j <= i; j++) {
        if (highs[j] > hi) hi = highs[j];
        if (lows[j]  < lo) lo = lows[j];
      }
      r[i] = hi === lo ? -50 : ((hi - closes[i]) / (hi - lo)) * -100;
    }
    return r;
  }

  // Donchian Channel
  function donchian(highs, lows, p) {
    p = p || 20;
    var n = highs.length;
    var upper = new Array(n).fill(NaN); upper.fill(NaN);
    var lower = new Array(n).fill(NaN); lower.fill(NaN);
    for (var i = p - 1; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - p + 1; j <= i; j++) {
        if (highs[j] > hi) hi = highs[j];
        if (lows[j]  < lo) lo = lows[j];
      }
      upper[i] = hi; lower[i] = lo;
    }
    return { upper: upper, lower: lower };
  }

  // ── 動態指標計算（含參數，帶 cache 避免重複）────────────────
  function precompute(data, stratConfig) {
    var c = data.closes, h = data.highs, l = data.lows, v = data.volumes;
    var cache = {};

    function getSMA(p)  { var k='sma'+p;  return cache[k]||(cache[k]=sma(c,p));   }
    function getEMA(p)  { var k='ema'+p;  return cache[k]||(cache[k]=ema(c,p));   }
    function getRSI(p)  { var k='rsi'+p;  return cache[k]||(cache[k]=rsi(c,p));   }
    function getKD(p)   { var k='kd'+p;   return cache[k]||(cache[k]=kd(h,l,c,p)); }
    function getBoll(p,m){ var k='boll'+p+'_'+m; return cache[k]||(cache[k]=boll(c,p,m)); }
    function getWR(p)   { var k='wr'+p;   return cache[k]||(cache[k]=wr(h,l,c,p)); }
    function getDC(p)   { var k='dc'+p;   return cache[k]||(cache[k]=donchian(h,l,p)); }
    function getVolSMA(p){ var k='vsma'+p; return cache[k]||(cache[k]=sma(v,p));  }
    function getMACD(f,s,sig) {
      var k='macd'+f+'_'+s+'_'+sig;
      return cache[k]||(cache[k]=macd(c,f,s,sig));
    }

    // 從 stratConfig 萃取所有用到的參數，動態計算所需指標
    var sc = stratConfig || {};
    var allStrats = []
      .concat(sc.longEntry||[]).concat(sc.longExit||[])
      .concat(sc.shortEntry||[]).concat(sc.shortExit||[]);

    // 預先計算每個策略需要的指標
    allStrats.forEach(function(s) {
      var p = s.params || {};
      var id = s.id || s;
      // MA類
      if (/ma_golden|ma_death|s_ma_golden|s_ma_death/.test(id)) {
        getSMA(p.fast||5); getSMA(p.slow||20);
      }
      if (/price_above_ma|price_below_ma|s_price/.test(id)) { getSMA(p.period||20); }
      // RSI
      if (/rsi/.test(id)) { getRSI(p.period||14); }
      // MACD
      if (/macd/.test(id)) { getMACD(p.fast||12, p.slow||26, p.signal||9); }
      // Boll
      if (/boll/.test(id)) { getBoll(p.period||20, p.mult||2); }
      // KD
      if (/kd/.test(id)) { getKD(p.period||9); }
      // Volume
      if (/vol_surge/.test(id)) { getVolSMA(p.volPeriod||20); }
      // WR
      if (/wr/.test(id)) { getWR(p.period||14); }
      // Donchian / Turtle
      if (/price_high|turtle_break|s_price_high|s_turtle_high/.test(id)) { getDC(p.period||20); }
      if (/price_low|turtle_stop|s_price_low|s_turtle_low/.test(id)) { getDC(p.period||20); }
    });

    // 永遠預計算幾個基本的（給今日訊號UI用）
    getSMA(5); getSMA(20); getRSI(14); getMACD(12,26,9); getBoll(20,2); getKD(9);
    getWR(14); getDC(20); getDC(10); getVolSMA(20);

    // 回傳 accessor 物件（惰性計算）
    return {
      // 基本快捷 key（兼容舊 code）
      ma5:   getSMA(5),  ma10: getSMA(10), ma20: getSMA(20),
      ma60:  getSMA(60), ma120:getSMA(120),ma200:getSMA(200),
      ema20: getEMA(20), ema200:getEMA(200),
      rsi14: getRSI(14),
      kd9:   getKD(9),
      macd:  getMACD(12,26,9),
      boll20:getBoll(20,2),
      wr14:  getWR(14),
      dc20:  getDC(20),
      dc10:  getDC(10),
      vol20: getVolSMA(20),
      // 動態取得函式
      getSMA, getEMA, getRSI, getKD, getBoll, getWR, getDC, getVolSMA, getMACD,
    };
  }

  return { sma, ema, rsi, kd, macd, boll, wr, donchian, precompute };
})();


// ──────────────────────────────────────────────────────────────
// 2. SIGNAL ENGINE
// ──────────────────────────────────────────────────────────────
// 規則：
//   - 所有訊號使用 sigDay（訊號產生日）的資料
//   - sigDay 和 execDay 由 ExecutionEngine 分離
//   - 此函數不接觸任何 execDay 的資料
// ──────────────────────────────────────────────────────────────

var SignalEngine = (function() {

  // 安全比較（NaN-safe）
  function v(x) { return !isNaN(x) && x != null; }

  // ── 從策略陣列取得某策略的參數（物件或預設值）───────────
  function getP(strategies, stratId, key, def) {
    var list = strategies.entry || strategies.exit || [];
    var found = null;
    list.forEach(function(s) {
      if ((s.id||s) === stratId) found = s.params || {};
    });
    if (!found) return def;
    return (found[key] != null) ? found[key] : def;
  }

  function scoreLongEntry(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes, vols = data.volumes;
    var p = i, q = i - 1;
    // 支援 string[] 或 {id, params}[] 兩種格式
    var entryIds = (strategies.entry||[]).map(function(s){ return s.id||s; });
    var score = 0;
    var pr = function(id, key, def){ return getP({entry:strategies.entry}, id, key, def); };

    // 均線黃金交叉
    if (entryIds.indexOf('ma_golden') >= 0) {
      var fast=pr('ma_golden','fast',5), slow=pr('ma_golden','slow',20);
      var mf=ind.getSMA(fast), ms=ind.getSMA(slow);
      if (v(mf[q])&&v(ms[q])&&v(mf[p])&&v(ms[p]))
        if (mf[q]<=ms[q] && mf[p]>ms[p]) score+=2;
    }
    // 價格突破均線
    if (entryIds.indexOf('price_above_ma') >= 0) {
      var period=pr('price_above_ma','period',20), ma=ind.getSMA(period);
      if (v(ma[p])) if (c[q]<=ma[q] && c[p]>ma[p]) score+=1;
    }
    // RSI超賣
    if (entryIds.indexOf('rsi_oversold') >= 0) {
      var period=pr('rsi_oversold','period',14), thr=pr('rsi_oversold','threshold',30);
      var r=ind.getRSI(period);
      if (v(r[q])&&v(r[p])) {
        if (r[q]<thr && r[p]>=thr) score+=3;
        else if (r[p]<thr-5)       score+=1;
      }
    }
    // MACD黃金交叉
    if (entryIds.indexOf('macd_golden') >= 0) {
      var fast=pr('macd_golden','fast',12), slow=pr('macd_golden','slow',26), sig=pr('macd_golden','signal',9);
      var m=ind.getMACD(fast,slow,sig);
      if (v(m.hist[q])&&v(m.hist[p])) if (m.hist[q]<0&&m.hist[p]>=0) score+=2;
    }
    // 布林突破下軌
    if (entryIds.indexOf('boll_break') >= 0) {
      var period=pr('boll_break','period',20), mult=pr('boll_break','mult',2);
      var b=ind.getBoll(period,mult);
      if (v(b.lower[p])) if (c[q]<=b.lower[q]&&c[p]>b.lower[p]) score+=2;
    }
    // KD黃金交叉
    if (entryIds.indexOf('kd_golden') >= 0) {
      var period=pr('kd_golden','period',9), thr=pr('kd_golden','threshold',50);
      var kobj=ind.getKD(period);
      if (v(kobj.k[q])&&v(kobj.d[q]))
        if (kobj.k[q]<=kobj.d[q]&&kobj.k[p]>kobj.d[p]&&kobj.k[p]<thr) score+=2;
    }
    // 成交量爆增
    if (entryIds.indexOf('vol_surge') >= 0) {
      var vp=pr('vol_surge','volPeriod',20), vm=pr('vol_surge','volMult',2.0);
      var vs=ind.getVolSMA(vp);
      if (v(vs[p])) if (vols[p]>vs[p]*vm&&c[p]>c[q]) score+=1;
    }
    // 突破N日前高
    if (entryIds.indexOf('price_high') >= 0) {
      var period=pr('price_high','period',20), dc=ind.getDC(period);
      if (v(dc.upper[q])) if (c[p]>dc.upper[q]) score+=2;
    }
    // 威廉%R超賣
    if (entryIds.indexOf('wr_oversold') >= 0) {
      var period=pr('wr_oversold','period',14), thr=pr('wr_oversold','threshold',-80);
      var wrv=ind.getWR(period);
      if (v(wrv[q])&&v(wrv[p])) if (wrv[q]<thr&&wrv[p]>=thr) score+=2;
    }
    // 海龜突破
    if (entryIds.indexOf('turtle_break') >= 0) {
      var period=pr('turtle_break','period',20), dc=ind.getDC(period);
      if (v(dc.upper[q])) if (c[p]>dc.upper[q]) score+=2;
    }
    return score;
  }

  function scoreLongExit(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes;
    var p = i, q = i - 1;
    var exitIds = (strategies.exit||[]).map(function(s){ return s.id||s; });
    var score = 0;
    var pr = function(id, key, def){ return getP({exit:strategies.exit}, id, key, def); };

    // 均線死亡交叉
    if (exitIds.indexOf('ma_death') >= 0) {
      var fast=pr('ma_death','fast',5), slow=pr('ma_death','slow',20);
      var mf=ind.getSMA(fast), ms=ind.getSMA(slow);
      if (v(mf[q])&&v(ms[q])) if (mf[q]>=ms[q]&&mf[p]<ms[p]) score+=2;
    }
    // 跌破均線
    if (exitIds.indexOf('price_below_ma') >= 0) {
      var period=pr('price_below_ma','period',20), ma=ind.getSMA(period);
      if (v(ma[p])) if (c[q]>=ma[q]&&c[p]<ma[p]) score+=1;
    }
    // RSI超買回落
    if (exitIds.indexOf('rsi_overbought') >= 0) {
      var period=pr('rsi_overbought','period',14), thr=pr('rsi_overbought','threshold',70);
      var r=ind.getRSI(period);
      if (v(r[q])&&v(r[p])) {
        if (r[q]>thr&&r[p]<=thr) score+=3;
        else if (r[p]>thr+10)    score+=1;
      }
    }
    // MACD死亡交叉
    if (exitIds.indexOf('macd_death') >= 0) {
      var fast=pr('macd_death','fast',12), slow=pr('macd_death','slow',26), sig=pr('macd_death','signal',9);
      var m=ind.getMACD(fast,slow,sig);
      if (v(m.hist[q])&&v(m.hist[p])) if (m.hist[q]>0&&m.hist[p]<=0) score+=2;
    }
    // 觸碰布林上軌
    if (exitIds.indexOf('boll_upper') >= 0) {
      var period=pr('boll_upper','period',20), mult=pr('boll_upper','mult',2);
      var b=ind.getBoll(period,mult);
      if (v(b.upper[p])) if (c[p]>=b.upper[p]) score+=1;
    }
    // KD死亡交叉
    if (exitIds.indexOf('kd_death') >= 0) {
      var period=pr('kd_death','period',9), thr=pr('kd_death','threshold',50);
      var kobj=ind.getKD(period);
      if (v(kobj.k[q])&&v(kobj.d[q]))
        if (kobj.k[q]>=kobj.d[q]&&kobj.k[p]<kobj.d[p]&&kobj.k[p]>thr) score+=2;
    }
    // 跌破N日前低
    if (exitIds.indexOf('price_low') >= 0) {
      var period=pr('price_low','period',20), dc=ind.getDC(period);
      if (v(dc.lower[q])) if (c[p]<dc.lower[q]) score+=2;
    }
    // 威廉%R超買
    if (exitIds.indexOf('wr_overbought') >= 0) {
      var period=pr('wr_overbought','period',14), thr=pr('wr_overbought','threshold',-20);
      var wrv=ind.getWR(period);
      if (v(wrv[q])&&v(wrv[p])) if (wrv[q]>thr&&wrv[p]<=thr) score+=2;
    }
    // 海龜停損N日低
    if (exitIds.indexOf('turtle_stop') >= 0) {
      var period=pr('turtle_stop','period',10), dc=ind.getDC(period);
      if (v(dc.lower[q])) if (c[p]<dc.lower[q]) score+=2;
    }
    // 移動停損（在 ExecutionEngine 處理，這裡不計分）
    return score;
  }

  function scoreShortEntry(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes;
    var p = i, q = i - 1;
    var entryIds = (strategies.entry||[]).map(function(s){ return s.id||s; });
    var score = 0;
    var pr = function(id, key, def){ return getP({entry:strategies.entry}, id, key, def); };

    if (entryIds.indexOf('s_ma_death') >= 0) {
      var fast=pr('s_ma_death','fast',5), slow=pr('s_ma_death','slow',20);
      var mf=ind.getSMA(fast), ms=ind.getSMA(slow);
      if (v(mf[q])&&v(ms[q])) if (mf[q]>=ms[q]&&mf[p]<ms[p]) score+=2;
    }
    if (entryIds.indexOf('s_price_below_ma') >= 0) {
      var period=pr('s_price_below_ma','period',20), ma=ind.getSMA(period);
      if (v(ma[p])) if (c[q]>=ma[q]&&c[p]<ma[p]) score+=1;
    }
    if (entryIds.indexOf('s_rsi_overbought') >= 0) {
      var period=pr('s_rsi_overbought','period',14), thr=pr('s_rsi_overbought','threshold',70);
      var r=ind.getRSI(period);
      if (v(r[q])&&v(r[p])) if (r[q]>thr&&r[p]<=thr) score+=3;
    }
    if (entryIds.indexOf('s_macd_death') >= 0) {
      var fast=pr('s_macd_death','fast',12), slow=pr('s_macd_death','slow',26), sig=pr('s_macd_death','signal',9);
      var m=ind.getMACD(fast,slow,sig);
      if (v(m.hist[q])&&v(m.hist[p])) if (m.hist[q]>0&&m.hist[p]<=0) score+=2;
    }
    if (entryIds.indexOf('s_boll_upper') >= 0) {
      var period=pr('s_boll_upper','period',20), mult=pr('s_boll_upper','mult',2);
      var b=ind.getBoll(period,mult);
      if (v(b.upper[p])) if (c[p]>=b.upper[p]) score+=1;
    }
    if (entryIds.indexOf('s_kd_death') >= 0) {
      var period=pr('s_kd_death','period',9), thr=pr('s_kd_death','threshold',50);
      var kobj=ind.getKD(period);
      if (v(kobj.k[q])&&v(kobj.d[q]))
        if (kobj.k[q]>=kobj.d[q]&&kobj.k[p]<kobj.d[p]&&kobj.k[p]>thr) score+=2;
    }
    if (entryIds.indexOf('s_price_low') >= 0) {
      var period=pr('s_price_low','period',20), dc=ind.getDC(period);
      if (v(dc.lower[q])) if (c[p]<dc.lower[q]) score+=2;
    }
    if (entryIds.indexOf('s_wr_overbought') >= 0) {
      var period=pr('s_wr_overbought','period',14), thr=pr('s_wr_overbought','threshold',-20);
      var wrv=ind.getWR(period);
      if (v(wrv[q])&&v(wrv[p])) if (wrv[q]>thr&&wrv[p]<=thr) score+=2;
    }
    if (entryIds.indexOf('s_turtle_low') >= 0) {
      var period=pr('s_turtle_low','period',20), dc=ind.getDC(period);
      if (v(dc.lower[q])) if (c[p]<dc.lower[q]) score+=2;
    }
    return score;
  }

  function scoreShortExit(i, ind, data, strategies) {
    if (i < 1) return 0;
    var c = data.closes;
    var p = i, q = i - 1;
    var exitIds = (strategies.exit||[]).map(function(s){ return s.id||s; });
    var score = 0;
    var pr = function(id, key, def){ return getP({exit:strategies.exit}, id, key, def); };

    if (exitIds.indexOf('s_ma_golden') >= 0) {
      var fast=pr('s_ma_golden','fast',5), slow=pr('s_ma_golden','slow',20);
      var mf=ind.getSMA(fast), ms=ind.getSMA(slow);
      if (v(mf[q])&&v(ms[q])) if (mf[q]<=ms[q]&&mf[p]>ms[p]) score+=2;
    }
    if (exitIds.indexOf('s_price_above_ma') >= 0) {
      var period=pr('s_price_above_ma','period',20), ma=ind.getSMA(period);
      if (v(ma[p])) if (c[q]<=ma[q]&&c[p]>ma[p]) score+=1;
    }
    if (exitIds.indexOf('s_rsi_oversold') >= 0) {
      var period=pr('s_rsi_oversold','period',14), thr=pr('s_rsi_oversold','threshold',30);
      var r=ind.getRSI(period);
      if (v(r[q])&&v(r[p])) if (r[q]<thr&&r[p]>=thr) score+=3;
    }
    if (exitIds.indexOf('s_macd_golden') >= 0) {
      var fast=pr('s_macd_golden','fast',12), slow=pr('s_macd_golden','slow',26), sig=pr('s_macd_golden','signal',9);
      var m=ind.getMACD(fast,slow,sig);
      if (v(m.hist[q])&&v(m.hist[p])) if (m.hist[q]<0&&m.hist[p]>=0) score+=2;
    }
    if (exitIds.indexOf('s_boll_lower') >= 0) {
      var period=pr('s_boll_lower','period',20), mult=pr('s_boll_lower','mult',2);
      var b=ind.getBoll(period,mult);
      if (v(b.lower[p])) if (c[p]<=b.lower[p]) score+=1;
    }
    if (exitIds.indexOf('s_kd_golden') >= 0) {
      var period=pr('s_kd_golden','period',9), thr=pr('s_kd_golden','threshold',50);
      var kobj=ind.getKD(period);
      if (v(kobj.k[q])&&v(kobj.d[q]))
        if (kobj.k[q]<=kobj.d[q]&&kobj.k[p]>kobj.d[p]&&kobj.k[p]<thr) score+=2;
    }
    if (exitIds.indexOf('s_price_high') >= 0) {
      var period=pr('s_price_high','period',20), dc=ind.getDC(period);
      if (v(dc.upper[q])) if (c[p]>dc.upper[q]) score+=2;
    }
    if (exitIds.indexOf('s_wr_oversold') >= 0) {
      var period=pr('s_wr_oversold','period',14), thr=pr('s_wr_oversold','threshold',-80);
      var wrv=ind.getWR(period);
      if (v(wrv[q])&&v(wrv[p])) if (wrv[q]<thr&&wrv[p]>=thr) score+=2;
    }
    if (exitIds.indexOf('s_turtle_high') >= 0) {
      var period=pr('s_turtle_high','period',20), dc=ind.getDC(period);
      if (v(dc.upper[q])) if (c[p]>dc.upper[q]) score+=2;
    }
    return score;
  }

  // Generate full signal arrays (one per bar)
  // Returns { longEntry[], longExit[], shortEntry[], shortExit[] }
  function generate(data, ind, longStrat, shortStrat, shortEnabled) {
    var n = data.closes.length;
    var le = new Array(n).fill(0), lx = new Array(n).fill(0);
    var se = new Array(n).fill(0), sx = new Array(n).fill(0);
    for (var i = 1; i < n; i++) {
      le[i] = scoreLongEntry(i, ind, data, longStrat);
      lx[i] = scoreLongExit(i, ind, data, longStrat);
      if (shortEnabled) {
        se[i] = scoreShortEntry(i, ind, data, shortStrat);
        sx[i] = scoreShortExit(i, ind, data, shortStrat);
      }
    }
    return { longEntry: le, longExit: lx, shortEntry: se, shortExit: sx };
  }

  return { generate, scoreLongEntry, scoreLongExit, scoreShortEntry, scoreShortExit };
})();


// ──────────────────────────────────────────────────────────────
// 3. POSITION OBJECT
// ──────────────────────────────────────────────────────────────

function createPosition(side, qty, entryPrice, entryDate, feeRate) {
  var cost = qty * 1000 * entryPrice;
  var fees = cost * feeRate;
  return {
    side:             side,           // 'long' | 'short'
    qty:              qty,            // 張數
    entryPrice:       entryPrice,
    entryDate:        entryDate,
    markPrice:        entryPrice,
    margin:           cost,           // 凍結資金（多=成本, 空=保證金）
    entryFees:        fees,           // 進場手續費
    unrealizedPnl:    0,
    realizedPnl:      0,
    trailHigh:        entryPrice,     // 多單移動停損追蹤
    trailLow:         entryPrice,     // 空單移動停損追蹤
  };
}

function updatePositionMark(pos, currentPrice) {
  pos.markPrice = currentPrice;
  if (pos.side === 'long') {
    pos.unrealizedPnl = pos.qty * 1000 * (currentPrice - pos.entryPrice) - pos.entryFees;
    if (currentPrice > pos.trailHigh) pos.trailHigh = currentPrice;
  } else {
    pos.unrealizedPnl = pos.qty * 1000 * (pos.entryPrice - currentPrice) - pos.entryFees;
    if (currentPrice < pos.trailLow) pos.trailLow = currentPrice;
  }
}

function closePosition(pos, exitPrice, exitDate, sellFeeRate) {
  var exitFees = pos.qty * 1000 * exitPrice * sellFeeRate;
  var grossPnl = pos.side === 'long'
    ? pos.qty * 1000 * (exitPrice - pos.entryPrice) - pos.entryFees
    : pos.qty * 1000 * (pos.entryPrice - exitPrice) - pos.entryFees;
  var netPnl = grossPnl - exitFees;
  return {
    exitPrice:  exitPrice,
    exitDate:   exitDate,
    exitFees:   exitFees,
    grossPnl:   grossPnl,
    netPnl:     netPnl,
    pnlPct:     (netPnl / pos.margin) * 100,
    // 退還給 portfolio 的金額。進場手續費在進場時已從現金扣除；netPnl 也扣了它，所以這裡要加回，
    // 否則每筆交易的帳戶權益會少算一次進場手續費（舊版錯誤：權益變動 ≠ 已實現淨損益合計）
    returnMargin: pos.margin + netPnl + pos.entryFees,
  };
}


// ──────────────────────────────────────────────────────────────
// 4. PORTFOLIO ENGINE
// ──────────────────────────────────────────────────────────────
// 帳戶模型：
//   balance         = 未凍結現金
//   usedMargin      = 凍結中的保證金（進場成本 or 放空保證金）
//   unrealizedPnl   = 未平倉浮動損益
//   equity          = balance + usedMargin + unrealizedPnl
//   availableMargin = balance（可用）
// ──────────────────────────────────────────────────────────────

function createPortfolio(initCapital) {
  return {
    initCapital:   initCapital,
    balance:       initCapital,  // 可用現金
    usedMargin:    0,            // 凍結保證金
    unrealizedPnl: 0,
    realizedPnl:   0,
    position:      null,         // 當前持倉（單一部位）
  };
}

function portfolioEquity(pf) {
  return pf.balance + pf.usedMargin + pf.unrealizedPnl;
}

function portfolioEnterLong(pf, qty, price, date, buyFeeRate) {
  var cost = qty * 1000 * price;
  var fees = cost * buyFeeRate;
  var totalCost = cost + fees;
  if (totalCost > pf.balance || qty <= 0) return false;

  pf.balance    -= totalCost;
  pf.usedMargin += cost;                // 凍結持股市值（不含手續費）
  pf.position    = createPosition('long', qty, price, date, buyFeeRate);
  pf.position.entryFees = fees;
  return true;
}

// ── 正確的做空會計 ──────────────────────────────────────────────
// 台股融券：
//   進場：凍結保證金 = 放空市值（此處簡化為 100% 保證金率）
//         balance -= margin
//         usedMargin += margin
//   出場：
//         grossPnl = qty * 1000 * (entryPrice - exitPrice)
//         fees = exitValue * sellFeeRate
//         netPnl = grossPnl - entryFees - exitFees
//         退還 = margin + netPnl
//         balance += margin + netPnl  （只退保證金+損益，不憑空加本金）
//         usedMargin -= margin
// ──────────────────────────────────────────────────────────────
function portfolioEnterShort(pf, qty, price, date, buyFeeRate) {
  var margin = qty * 1000 * price;     // 凍結保證金
  var fees   = margin * buyFeeRate;    // 融券手續費
  if (margin + fees > pf.balance || qty <= 0) return false;

  pf.balance    -= (margin + fees);   // 扣除保證金 + 手續費
  pf.usedMargin += margin;            // 凍結保證金
  pf.position    = createPosition('short', qty, price, date, buyFeeRate);
  pf.position.entryFees = fees;
  return true;
}

function portfolioExitPosition(pf, exitPrice, date, sellFeeRate, reason) {
  if (!pf.position) return null;
  var pos    = pf.position;
  var result = closePosition(pos, exitPrice, date, sellFeeRate);

  // 退還保證金 + 損益（正確做法）
  pf.balance    += result.returnMargin;
  pf.usedMargin -= pos.margin;
  pf.realizedPnl += result.netPnl;
  pf.unrealizedPnl = 0;

  var trade = {
    entryDate:  pos.entryDate,
    exitDate:   date,
    side:       pos.side,
    qty:        pos.qty,
    entryPrice: pos.entryPrice,
    exitPrice:  exitPrice,
    entryFees:  pos.entryFees,
    exitFees:   result.exitFees,
    grossPnl:   result.grossPnl,
    netPnl:     result.netPnl,
    pnlPct:     result.pnlPct,
    reason:     reason || 'strategy',
  };

  pf.position = null;
  return trade;
}

function portfolioUpdateMark(pf, currentPrice) {
  if (!pf.position) { pf.unrealizedPnl = 0; return; }
  updatePositionMark(pf.position, currentPrice);
  // 持倉的 unrealizedPnl 已扣進場手續費，而該費用進場時已從現金扣除；計算權益時只加價格損益，避免重複扣除
  pf.unrealizedPnl = pf.position.unrealizedPnl + pf.position.entryFees;
}


// ──────────────────────────────────────────────────────────────
// 5. EXECUTION ENGINE
// ──────────────────────────────────────────────────────────────
// 核心設計：
//   close mode: sigDay=i, execDay=i,   execPrice=closes[i]
//   open  mode: sigDay=i, execDay=i+1, execPrice=opens[i+1]
//   → 所有訊號預先計算好（SignalEngine.generate），
//     再按 execDay 執行，保證零 lookahead bias
// ──────────────────────────────────────────────────────────────

var ExecutionEngine = (function() {

  // 暖機期：由「所選策略」實際需要的回看長度決定（例如均線 5/20 → 21 根）。
  // 舊版固定 250 根：只選一年（約 242 根）時永遠不會交易，選五年時第一年也被靜默略過。
  // 指標未就緒前訊號引擎本來就回傳 0，所以依參數推算是安全的。沒有參數的舊策略格式沿用 250。
  var LEGACY_WARMUP = 250;
  function lookbackOf(list) {
    var m = 0;
    (list || []).forEach(function(s) {
      var p = s && s.params; if (!p) { m = Math.max(m, LEGACY_WARMUP); return; }
      var v = 0; ['period', 'fast', 'slow', 'volPeriod'].forEach(function(k) { if (+p[k] > v) v = +p[k]; });
      if (+p.signal > 0) v = Math.max(v, (+p.slow || 26) + (+p.signal)); // MACD：慢線 EMA 加上訊號線 EMA
      m = Math.max(m, v || 20);
    });
    return m;
  }

  function run(data, config) {
    var n       = data.closes.length;
    var closes  = data.closes;
    var opens   = data.opens;
    var dates   = data.dates;

    var capital       = +config.capital      || 1000000;
    var execType      = config.execType      || 'close';
    var posBase       = config.positionBase  || 'initial';
    var posSizePct    = Math.min(Math.max(+config.posSize || 100, 1), 100) / 100;
    var stopLossPct   = +config.stopLoss   > 0 ? +config.stopLoss   / 100 : null;
    var stopProfitPct = +config.stopProfit > 0 ? +config.stopProfit / 100 : null;
    var threshold     = Math.max(parseInt(config.scoreThreshold, 10) || 1, 1);
    var isETF         = /^00/.test((config.code || ''));
    var buyFeeRate    = +config.buyFee  > 0 ? +config.buyFee  / 100 : (isETF ? 0.001 : 0.001425);
    var sellFeeRate   = +config.sellFee > 0 ? +config.sellFee / 100 : (isETF ? 0.002 : 0.004425);
    var shortEnabled  = !!config.shortEnabled;

    var longStrat  = { entry: config.longEntry  || [], exit: config.longExit  || [] };
    var lookback = Math.max(lookbackOf(config.longEntry), lookbackOf(config.longExit),
      shortEnabled ? lookbackOf(config.shortEntry) : 0, shortEnabled ? lookbackOf(config.shortExit) : 0, 1) + 1;
    // config.tradeStart：使用者選的起始日。資料可以包含起始日前的 K 線（只用來暖機），交易只從起始日開始。
    var tradeStartIdx = 0;
    if (config.tradeStart) { tradeStartIdx = dates.findIndex(function(d) { return d >= config.tradeStart; }); if (tradeStartIdx < 0) tradeStartIdx = n; }
    var warmup = Math.max(lookback, tradeStartIdx);
    // 期間內（含暖機所需的回看範圍）有超過漲跌幅限制、查無公告的價格跳動：無法可靠回測，直接停止
    if (config.unexplained && config.unexplained.length) {
      var from = dates[Math.max(0, tradeStartIdx - lookback)], hit = config.unexplained.filter(function(d) { return d >= from && d <= dates[n - 1]; });
      if (hit.length) throw new Error('回測期間（含指標暖機的回看範圍）內，' + hit.join('、') + ' 有超過漲跌幅限制且查無分割、面額變更或減資公告的價格跳動，無法可靠回測。請把起始日設在 ' + hit[hit.length - 1] + ' 之後至少 ' + lookback + ' 個交易日。');
    }
    // 診斷：訊號出現幾次、幾次因資金不足一張（或其他原因）沒有成交
    var diag = { warmup: warmup, lookback: lookback, tradeStartIdx: tradeStartIdx, preBars: tradeStartIdx, startDelayed: lookback > tradeStartIdx && !!config.tradeStart, tradeFrom: dates[Math.min(warmup, n - 1)] || null, periodStart: dates[Math.min(tradeStartIdx, n - 1)] || null, bars: n - tradeStartIdx, corpChecked: config.corpChecked !== false, entrySignals: 0, exitSignals: 0, rejected: 0, rejectedCash: 0, minCashNeeded: null, maxCashNeeded: null, pendingAtEnd: false, entryLog: [] };
    // 買進張數要把手續費算進去，否則 100% 部位時常因「股款＋手續費 > 現金」被靜默拒絕
    function lotsFor(base, price, feeRate) { return Math.floor(base * posSizePct / (price * 1000 * (1 + feeRate))); }
    function noteReject(price, feeRate) { diag.rejected++; var need = price * 1000 * (1 + feeRate); if (pf.balance < need) { diag.rejectedCash++; diag.minCashNeeded = diag.minCashNeeded === null ? Math.round(need) : Math.min(diag.minCashNeeded, Math.round(need)); diag.maxCashNeeded = Math.max(diag.maxCashNeeded || 0, Math.round(need)); } }
    function logEntry(sigDate, execDate, side, price, lots, cashBefore, feeRate) {
      diag.entryLog.push({ signalDate: sigDate, execDate: execDate, side: side, price: price, cashBefore: Math.round(cashBefore), perLot: Math.round(price * 1000 * (1 + feeRate)), lots: lots, filled: !!pf.position });
    }
    var shortStrat = { entry: config.shortEntry || [], exit: config.shortExit || [] };

    // Step 1: 預計算所有指標（傳入策略設定讓 precompute 動態計算）
    var stratConfig = {
      longEntry:  config.longEntry  || [],
      longExit:   config.longExit   || [],
      shortEntry: config.shortEntry || [],
      shortExit:  config.shortExit  || [],
    };
    var ind = Indicators.precompute(data, stratConfig);

    // Step 2: 預計算所有訊號（sigDay 為基準）
    var sigs = SignalEngine.generate(data, ind, longStrat, shortStrat, shortEnabled);

    // Step 3: 初始化 portfolio
    var pf      = createPortfolio(capital);
    var equity  = new Array(n).fill(NaN);
    var trades  = [];

    // execType=open：第 i 天的訊號在第 i+1 天開盤執行
    // execType=close：第 i 天的訊號在第 i 天收盤執行
    // 為了統一迴圈，建立 pending 訊號
    var pendingLongEntry  = false;
    var pendingLongExit   = false;
    var pendingShortEntry = false;
    var pendingShortExit  = false;
    var pendingReason     = '';

    for (var i = 0; i < n; i++) {
      var closePrice = closes[i];
      var openPrice  = opens[i] || closes[i];
      var date       = dates[i];

      // ── 確定今日執行價 ────────────────────────────────────
      var execPrice;
      if (execType === 'open') {
        execPrice = openPrice;   // 今日開盤（前日訊號）
      } else {
        execPrice = closePrice;  // 今日收盤（今日訊號）
      }

      if (!execPrice || execPrice <= 0) {
        portfolioUpdateMark(pf, closePrice || 0);
        equity[i] = portfolioEquity(pf);
        continue;
      }

      // ── 執行前日 pending 訊號（open 模式）──────────────────
      if (execType === 'open' && i > 0) {
        if (pendingLongEntry && !pf.position) {
          var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
          var lots = lotsFor(base, execPrice, buyFeeRate), cash0 = pf.balance;
          portfolioEnterLong(pf, lots, execPrice, date, buyFeeRate);
          logEntry(dates[i - 1], date, 'long', execPrice, lots, cash0, buyFeeRate);
          if (!pf.position) noteReject(execPrice, buyFeeRate);
          if (pf.position) {
            trades.push({ type: 'entry', side: 'long', date: date, price: execPrice, qty: lots, reason: 'strategy' });
          }
        }
        if (pendingLongExit && pf.position && pf.position.side === 'long') {
          var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, pendingReason || 'strategy');
          if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'long', date: date, price: execPrice, qty: t.qty }));
        }
        if (pendingShortEntry && !pf.position) {
          var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
          var lots = lotsFor(base, execPrice, buyFeeRate), cash0 = pf.balance;
          portfolioEnterShort(pf, lots, execPrice, date, buyFeeRate);
          logEntry(dates[i - 1], date, 'short', execPrice, lots, cash0, buyFeeRate);
          if (!pf.position) noteReject(execPrice, buyFeeRate);
          if (pf.position) {
            trades.push({ type: 'entry', side: 'short', date: date, price: execPrice, qty: lots, reason: 'strategy' });
          }
        }
        if (pendingShortExit && pf.position && pf.position.side === 'short') {
          var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, pendingReason || 'strategy');
          if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'short', date: date, price: execPrice, qty: t.qty }));
        }
        pendingLongEntry = pendingLongExit = pendingShortEntry = pendingShortExit = false;
        pendingReason = '';
      }

      // ── 停損停利（當日收盤檢查，open 模式也一樣）──────────
      if (pf.position) {
        portfolioUpdateMark(pf, closePrice);
        var pos = pf.position;

        // 跳空開盤停損（更真實：先用開盤價確認）
        var checkPrice = (execType === 'open') ? openPrice : closePrice;

        if (pos.side === 'long') {
          var unrealPct = (checkPrice - pos.entryPrice) / pos.entryPrice;
          if (stopLossPct   && unrealPct <= -stopLossPct) {
            var t = portfolioExitPosition(pf, checkPrice, date, sellFeeRate, 'stopLoss');
            if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'long', date: date, price: checkPrice, qty: t.qty }));
          } else if (stopProfitPct && unrealPct >= stopProfitPct) {
            var t = portfolioExitPosition(pf, checkPrice, date, sellFeeRate, 'stopProfit'); // 舊版以開盤價觸發、卻以收盤價成交
            if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'long', date: date, price: checkPrice, qty: t.qty }));
          } else if (longStrat.exit.indexOf('trailing_stop') >= 0 && pf.position) {
            if (closePrice < pf.position.trailHigh * 0.95) {
              var t = portfolioExitPosition(pf, closePrice, date, sellFeeRate, 'trailingStop');
              if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'long', date: date, price: closePrice, qty: t.qty }));
            }
          }
        } else if (pos.side === 'short') {
          var unrealPct = (pos.entryPrice - checkPrice) / pos.entryPrice;
          if (stopLossPct   && unrealPct <= -stopLossPct) {
            var t = portfolioExitPosition(pf, checkPrice, date, sellFeeRate, 'stopLoss');
            if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'short', date: date, price: checkPrice, qty: t.qty }));
          } else if (stopProfitPct && unrealPct >= stopProfitPct) {
            var t = portfolioExitPosition(pf, checkPrice, date, sellFeeRate, 'stopProfit');
            if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'short', date: date, price: checkPrice, qty: t.qty }));
          } else if (shortStrat.exit.indexOf('s_trailing') >= 0 && pf.position) {
            if (closePrice > pf.position.trailLow * 1.05) {
              var t = portfolioExitPosition(pf, closePrice, date, sellFeeRate, 'trailingStop');
              if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'short', date: date, price: closePrice, qty: t.qty }));
            }
          }
        }
      }

      // ── 策略訊號執行（warm-up 後）──────────────────────────
      var sigIdx = i; // 訊號永遠用 today（不管 execType，訊號都是今天）

      if (sigIdx >= warmup) {
        var leScore = sigs.longEntry[sigIdx];
        var lxScore = sigs.longExit[sigIdx];
        var seScore = sigs.shortEntry[sigIdx];
        var sxScore = sigs.shortExit[sigIdx];
        if (!pf.position && (leScore >= threshold || (shortEnabled && seScore >= threshold))) diag.entrySignals++;
        if (pf.position && ((pf.position.side === 'long' && lxScore >= threshold) || (pf.position.side === 'short' && sxScore >= threshold))) diag.exitSignals++;

        if (execType === 'close') {
          // 今日收盤執行
          if (!pf.position) {
            if (leScore >= threshold) {
              var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
              var lots = lotsFor(base, execPrice, buyFeeRate), cash0 = pf.balance;
              portfolioEnterLong(pf, lots, execPrice, date, buyFeeRate);
              logEntry(date, date, 'long', execPrice, lots, cash0, buyFeeRate);
              if (!pf.position) noteReject(execPrice, buyFeeRate);
              if (pf.position) trades.push({ type: 'entry', side: 'long', date: date, price: execPrice, qty: lots, reason: 'strategy', score: leScore });
            } else if (shortEnabled && seScore >= threshold) {
              var base = posBase === 'equity' ? portfolioEquity(pf) : capital;
              var lots = lotsFor(base, execPrice, buyFeeRate), cash0 = pf.balance;
              portfolioEnterShort(pf, lots, execPrice, date, buyFeeRate);
              logEntry(date, date, 'short', execPrice, lots, cash0, buyFeeRate);
              if (!pf.position) noteReject(execPrice, buyFeeRate);
              if (pf.position) trades.push({ type: 'entry', side: 'short', date: date, price: execPrice, qty: lots, reason: 'strategy', score: seScore });
            }
          } else if (pf.position.side === 'long' && lxScore >= threshold) {
            var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, 'strategy');
            if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'long', date: date, price: execPrice, qty: t.qty }));
          } else if (pf.position.side === 'short' && sxScore >= threshold) {
            var t = portfolioExitPosition(pf, execPrice, date, sellFeeRate, 'strategy');
            if (t) trades.push(Object.assign({}, t, { type: 'exit', side: 'short', date: date, price: execPrice, qty: t.qty }));
          }
        } else {
          // open 模式：設定 pending，明日開盤執行
          if (!pf.position) {
            if (leScore >= threshold) { pendingLongEntry = true; }
            else if (shortEnabled && seScore >= threshold) { pendingShortEntry = true; }
          } else if (pf.position.side === 'long' && lxScore >= threshold) {
            pendingLongExit = true; pendingReason = 'strategy';
          } else if (pf.position.side === 'short' && sxScore >= threshold) {
            pendingShortExit = true; pendingReason = 'strategy';
          }
        }
      }

      // ── Mark-to-market ─────────────────────────────────────
      portfolioUpdateMark(pf, closePrice);
      equity[i] = portfolioEquity(pf);

      // 防止 NaN 擴散
      if (isNaN(equity[i])) equity[i] = i > 0 ? equity[i-1] : capital;
    }

    diag.pendingAtEnd = !!(pendingLongEntry || pendingShortEntry || pendingLongExit || pendingShortExit);
    diag.openAtEnd = !!pf.position;
    return { equity, trades, finalPortfolio: pf, diag: diag };
  }

  return { run };
})();


// ──────────────────────────────────────────────────────────────
// 6. METRICS ENGINE
// ──────────────────────────────────────────────────────────────

var MetricsEngine = (function() {

// no-trade edge case：回傳空白 metrics（避免 NaN 擴散）
function _emptyMetrics(initCapital) {
  return {
    totalReturn:0, cagr:0, annReturn:0,
    sharpe:0, sortino:0, calmar:0,
    maxDD:0, maxDDLen:0, recoveryFactor:0,
    exposure:0, annVolatility:0, downsideDev:0,
    tradeCount:0, winRate:0, avgWin:0, avgLoss:0,
    grossProfit:0, grossLoss:0, profitFactor:0, expectancy:0,
    maxWinStreak:0, maxLoseStreak:0,
    avgHoldingDays:0, avgBarsPerTrade:0,
    finalEquity:initCapital, initCapital:initCapital,
    years:0, annual:{},
  };
}


  function compute(equity, trades, initCapital, dates) {
    var n = equity.length;
    // no data edge case（只在完全沒資料時歸零）
    if (!n || !trades) {
      return _emptyMetrics(initCapital || 1000000);
    }
    // 若有進場但尚未出場（持倉中），仍繼續計算績效（equity 曲線有浮動損益）
    var finalEquity = equity[n - 1];
    // negative equity / NaN protection（做空極端虧損時）
    if (!isFinite(finalEquity) || finalEquity <= 0) finalEquity = initCapital * 0.001;

    // ── 基本報酬 ──────────────────────────────────────────────
    var totalReturn = (finalEquity - initCapital) / initCapital;
    var years = Math.max(n / 252, 1 / 252);

    // CAGR（正確公式）
    var cagr = Math.pow(Math.max(finalEquity / initCapital, 1e-6), 1 / years) - 1;

    // ── 回撤計算 ──────────────────────────────────────────────
    var maxDD = 0, peak = equity[0];
    var ddStart = 0, ddEnd = 0, ddLen = 0, maxDDLen = 0;
    var curDDStart = 0;
    for (var i = 1; i < n; i++) {
      if (equity[i] > peak) { peak = equity[i]; curDDStart = i; }
      var dd = peak > 0 ? (peak - equity[i]) / peak : 0;
      if (dd > maxDD) { maxDD = dd; ddStart = curDDStart; ddEnd = i; maxDDLen = i - curDDStart; }
    }

    // ── 日報酬率（log return 更準確）──────────────────────────
    var logRets = [];
    for (var i = 1; i < n; i++) {
      if (equity[i - 1] > 0 && equity[i] > 0) logRets.push(Math.log(equity[i] / equity[i-1]));
    }
    var nd = logRets.length || 1;
    var meanRet = logRets.reduce(function(a,b){return a+b;},0) / nd;
    var variance = logRets.reduce(function(a,b){return a+Math.pow(b-meanRet,2);},0) / Math.max(nd-1,1);
    var stdRet = Math.sqrt(variance);

    // overflow/Infinity protection
    if (!isFinite(stdRet) || isNaN(stdRet)) stdRet = 0;
    var sharpe = stdRet > 1e-8 ? Math.max(Math.min((meanRet * Math.sqrt(252)) / stdRet, 999), -999) : 0;

    // Sortino（只用負報酬的下行標準差）
    var downRets = logRets.filter(function(r){return r < 0 && isFinite(r);});
    var downVar  = downRets.length > 1
      ? downRets.reduce(function(a,b){return a+b*b;},0) / (downRets.length - 1)
      : 1e-8;
    var downStd  = Math.sqrt(downVar) * Math.sqrt(252);
    if (!isFinite(downStd) || downStd <= 0) downStd = 1e-8;
    var sortino  = Math.max(Math.min(cagr / downStd, 999), -999);

    // Calmar Ratio — huge drawdown edge case
    var calmar = maxDD > 1e-8 ? Math.max(Math.min(cagr / maxDD, 999), -999) : 0;

    // ── 交易統計 ──────────────────────────────────────────────
    var closed = trades.filter(function(t){return t.type === 'exit';});
    var wins   = closed.filter(function(t){return t.netPnl > 0;});
    var losses = closed.filter(function(t){return t.netPnl <= 0;});

    var winRate      = closed.length > 0 ? wins.length / closed.length : 0;
    var avgWin       = wins.length   > 0 ? wins.reduce(function(a,t){return a+t.netPnl;},0)  / wins.length   : 0;
    var avgLoss      = losses.length > 0 ? losses.reduce(function(a,t){return a+t.netPnl;},0) / losses.length : 0;
    var grossProfit  = wins.reduce(function(a,t){return a+t.netPnl;},0);
    var grossLoss    = Math.abs(losses.reduce(function(a,t){return a+t.netPnl;},0));
    var profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    var expectancy   = (winRate * avgWin) + ((1 - winRate) * avgLoss); // 期望值

    // 連勝/連敗
    var maxWS=0, maxLS=0, cW=0, cL=0;
    closed.forEach(function(t){
      if (t.netPnl > 0) { cW++; cL=0; if(cW>maxWS) maxWS=cW; }
      else               { cL++; cW=0; if(cL>maxLS) maxLS=cL; }
    });

    // Recovery Factor
    var recoveryFactor = maxDD > 1e-8 ? totalReturn / maxDD : 0;

    // Exposure：逐 bar 計算持倉狀態（正確版）
    // 建立日期→索引映射
    var dateToIdx = {};
    if (dates) { dates.forEach(function(d,i){ dateToIdx[d]=i; }); }
    // 標記每個 bar 是否持倉
    var inPositionBar = new Array(n).fill(0); // 0=空倉, 1=持倉
    var posOpen = false;
    trades.forEach(function(t) {
      if (t.type === 'entry') { posOpen = true; }
      if (t.type === 'exit')  { posOpen = false; }
    });
    // 用 entry/exit 日期重建持倉區間
    var intervals = [];
    var lastEntry = -1;
    trades.forEach(function(t) {
      var ti = (t.date && dateToIdx[t.date] != null) ? dateToIdx[t.date]
             : (t.entryDate && dateToIdx[t.entryDate] != null) ? dateToIdx[t.entryDate] : -1;
      if (t.type === 'entry') { lastEntry = ti; }
      if (t.type === 'exit' && lastEntry >= 0) {
        var xi = (t.exitDate && dateToIdx[t.exitDate] != null) ? dateToIdx[t.exitDate]
               : (t.date && dateToIdx[t.date] != null) ? dateToIdx[t.date] : ti;
        intervals.push([lastEntry, xi]);
        lastEntry = -1;
      }
    });
    // 若有未平倉（lastEntry > 0），計入到最後一根 bar
    if (lastEntry >= 0) intervals.push([lastEntry, n-1]);
    // 標記持倉 bar
    intervals.forEach(function(iv) {
      for (var b = iv[0]; b <= iv[1] && b < n; b++) inPositionBar[b] = 1;
    });
    var inPosBars = 0;
    for (var b = 0; b < n; b++) { if (inPositionBar[b]) inPosBars++; }
    var exposure = n > 0 ? inPosBars / n : 0;

    // ── 年度績效 ──────────────────────────────────────────────
    var annual = {};
    if (dates) {
      dates.forEach(function(d, i) {
        if (!d) return;
        var y = d.slice(0,4);
        if (!annual[y]) annual[y] = { start:i, startV:equity[i] };
        annual[y].end = i; annual[y].endV = equity[i];
      });
      Object.keys(annual).forEach(function(y) {
        var a = annual[y];
        a.ret = (a.endV - a.startV) / a.startV;
        a.tradeCnt = closed.filter(function(t){return (t.exitDate||t.date||'').slice(0,4)===y;}).length;
      });
    }

    // ── 平均持倉天數 / annualized volatility / downside deviation ──
    var avgHoldingDays = 0, avgBarsPerTrade = 0;
    if (closed.length > 0) {
      var totalHoldBars = intervals.reduce(function(a,iv){ return a + (iv[1]-iv[0]+1); }, 0);
      avgBarsPerTrade   = totalHoldBars / Math.max(closed.length, 1);
      avgHoldingDays    = avgBarsPerTrade; // 台股每 bar = 1 交易日
    }

    // 年化波動率（用日 log return 的標準差）
    var annVolatility = stdRet * Math.sqrt(252);

    // Downside deviation（下行標準差，年化）
    var downsideDev = downStd;

    return {
      // 報酬
      totalReturn, cagr, annReturn: cagr,
      // 風險
      sharpe, sortino, calmar, maxDD, maxDDLen,
      recoveryFactor, exposure, annVolatility, downsideDev,
      // 交易
      tradeCount: closed.length,
      winRate, avgWin, avgLoss, grossProfit, grossLoss,
      profitFactor, expectancy,
      maxWinStreak: maxWS, maxLoseStreak: maxLS,
      avgHoldingDays, avgBarsPerTrade,
      // 帳戶
      finalEquity, initCapital,
      // 年度
      annual,
    };
  }

  return { compute };
})();


// ──────────────────────────────────────────────────────────────
// 7. TOP-LEVEL BACKTEST FUNCTION（供 Worker 呼叫）
// ──────────────────────────────────────────────────────────────

function runBacktestEngine(data, config) {
  // ── 輸入驗證（production hardening）────────────────────────
  if (!data || !data.closes) throw new Error('缺少資料');
  var n = data.closes.length;
  if (n < 60) throw new Error('資料不足（'+n+'筆），需至少 60 筆');

  // 修正缺失的 OHLC（holiday gaps / missing open）
  var closes  = data.closes  instanceof Array ? data.closes  : Array.from(data.closes);
  var opens   = data.opens   instanceof Array ? data.opens   : Array.from(data.opens   || data.closes);
  var highs   = data.highs   instanceof Array ? data.highs   : Array.from(data.highs   || data.closes);
  var lows    = data.lows    instanceof Array ? data.lows    : Array.from(data.lows    || data.closes);
  var volumes = data.volumes instanceof Array ? data.volumes : Array.from(data.volumes || new Array(n).fill(0));

  // 修正 NaN/0/Infinity（向前填充）
  for (var i = 0; i < n; i++) {
    var prevC = i > 0 ? closes[i-1] : 0;
    if (!isFinite(closes[i])  || closes[i]  <= 0) closes[i]  = prevC;
    if (!isFinite(opens[i])   || opens[i]   <= 0) opens[i]   = closes[i];
    if (!isFinite(highs[i])   || highs[i]   <= 0) highs[i]   = closes[i];
    if (!isFinite(lows[i])    || lows[i]    <= 0) lows[i]    = closes[i];
    if (!isFinite(volumes[i]) || volumes[i] <  0) volumes[i] = 0;
    // high >= close >= low 修正
    if (highs[i] < closes[i]) highs[i] = closes[i];
    if (lows[i]  > closes[i]) lows[i]  = closes[i];
  }

  // 修正後的 data 物件
  data = {
    code: data.code || '', dates: data.dates || [],
    closes: closes, opens: opens, highs: highs, lows: lows, volumes: volumes,
  };

  dbg('runBacktestEngine', n, 'bars, config:', config);
  var result = ExecutionEngine.run(data, config);
  // 績效只計算使用者選的期間：去掉起始日前、只用來暖機的 K 線
  var off = (result.diag && result.diag.tradeStartIdx) || 0;
  var eq = Array.from(result.equity).slice(off), dts = (data.dates || []).slice(off);
  var metrics = MetricsEngine.compute(eq, result.trades, config.capital || 1000000, dts);
  return {
    equity:   eq,
    dates:    dts,
    offset:   off,
    trades:   result.trades,
    metrics:  metrics,
    diag:     result.diag,
    annual:   metrics.annual,
  };
}

