// ═══════════════════════════════════════════════════════════════
// backtest UI layer — v4.0
// ═══════════════════════════════════════════════════════════════

var RENDER_URL = window.API_BASE || ""; // 與首頁共用 js/config.js（原站兩頁各指向不同的後端）

// ── Worker 管理 ───────────────────────────────────────────────
var _worker = null;
var _workerCallbacks = {};
var _msgId = 0;

var _workerBlobUrl = null;

function getWorker() {
  if (_worker) return _worker;
  try {
    _worker = new Worker('/js/bt-worker.js');
  } catch(e) {
    console.error('[Worker] Failed to create worker:', e.message);
    throw new Error('Web Worker 建立失敗：' + e.message);
  }
  _worker.onmessage = function(e) {
    var msg = e.data;
    var cb  = _workerCallbacks[msg.id];
    if (cb) {
      cb(msg);
      // Clean up callback after done/error (memory leak fix)
      if (msg.type.endsWith('_done') || msg.type === 'error') {
        delete _workerCallbacks[msg.id];
      }
    }
  };
  _worker.onerror = function(e) {
    console.error('[Worker]', e.message);
    // Race condition fix: copy callbacks before iterating
    var cbs = Object.values(_workerCallbacks);
    _workerCallbacks = {};
    cbs.forEach(function(cb) { cb({ type: 'error', message: e.message || 'Worker error' }); });
  };
  return _worker;
}

// Worker terminate（頁面卸載時釋放）
window.addEventListener('beforeunload', function() {
  if (_worker) { _worker.terminate(); _worker = null; }
  _workerCallbacks = {};
});

// Optimize cancel（BUG FIX: Worker 無法中途取消，只能 terminate 重建）
function cancelWorker() {
  if (_worker) {
    _worker.terminate();
    _worker = null;
    _workerCallbacks = {};
    dbg('Worker terminated and reset');
  }
}

function workerPost(type, payload, onProgress, onDone) {
  var id = ++_msgId;
  _workerCallbacks[id] = function(msg) {
    if (msg.type === 'error') { onDone(null, msg.message); return; }
    if (msg.type.endsWith('_progress')) { onProgress && onProgress(msg.pct); return; }
    if (msg.type.endsWith('_done'))     { onDone(msg.result || msg.results); return; }
  };
  getWorker().postMessage(Object.assign({ type: type, id: id }, payload));
  return id;
}

// ── 主題 ─────────────────────────────────────────────────────
function toggleTheme() {
  var html = document.documentElement;
  var isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  localStorage.setItem('bt_theme', isDark ? 'light' : 'dark');
  updateThemeIcon(!isDark);
}
function updateThemeIcon(isDark) {
  var icon = document.getElementById('themeIcon');
  if (!icon) return;
  icon.innerHTML = isDark
    ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
    : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
}
(function(){
  var s = localStorage.getItem('bt_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', s);
  updateThemeIcon(s === 'dark');
})();

// ── 策略定義 ─────────────────────────────────────────────────
// ── 策略定義（含參數規格）──────────────────────────────────
// params: 每個參數的 key, label, default, min, max, step
var LONG_ENTRY = [
  {id:'ma_golden',      label:'均線黃金交叉',    params:[
    {key:'fast', label:'短期SMA', def:5,  min:2,  max:60,  step:1},
    {key:'slow', label:'長期SMA', def:20, min:5,  max:250, step:1},
  ]},
  {id:'price_above_ma', label:'價格突破均線',    params:[
    {key:'period', label:'均線週期', def:20, min:5, max:250, step:1},
  ]},
  {id:'rsi_oversold',   label:'RSI超賣反彈',     params:[
    {key:'period',    label:'RSI週期',  def:14, min:2,  max:50,  step:1},
    {key:'threshold', label:'超賣閾值', def:30, min:5,  max:50,  step:1},
  ]},
  {id:'macd_golden',    label:'MACD黃金交叉',    params:[
    {key:'fast',   label:'快線EMA', def:12, min:2,  max:50,  step:1},
    {key:'slow',   label:'慢線EMA', def:26, min:5,  max:100, step:1},
    {key:'signal', label:'訊號線',  def:9,  min:2,  max:30,  step:1},
  ]},
  {id:'boll_break',     label:'布林突破下軌',    params:[
    {key:'period', label:'均線週期', def:20, min:5,  max:100, step:1},
    {key:'mult',   label:'標準差倍數', def:2.0, min:0.5, max:4.0, step:0.1},
  ]},
  {id:'kd_golden',      label:'KD黃金交叉',      params:[
    {key:'period',    label:'KD週期',   def:9,  min:3,  max:30,  step:1},
    {key:'threshold', label:'K值上限',  def:50, min:20, max:80,  step:5},
  ]},
  {id:'vol_surge',      label:'成交量爆增',       params:[
    {key:'volPeriod', label:'量均週期', def:20,  min:5,  max:60,  step:1},
    {key:'volMult',   label:'倍數',     def:2.0, min:1.2, max:5.0, step:0.1},
  ]},
  {id:'price_high',     label:'突破N日前高',     params:[
    {key:'period', label:'回看天數', def:20, min:5, max:120, step:1},
  ]},
  {id:'wr_oversold',    label:'威廉%R超賣',      params:[
    {key:'period',    label:'WR週期',   def:14,  min:3,  max:50,  step:1},
    {key:'threshold', label:'超賣閾值', def:-80, min:-95, max:-50, step:1},
  ]},
  {id:'turtle_break',   label:'海龜突破N日高',   params:[
    {key:'period', label:'突破天數', def:20, min:5, max:120, step:1},
  ]},
];

var LONG_EXIT = [
  {id:'ma_death',        label:'均線死亡交叉',   params:[
    {key:'fast', label:'短期SMA', def:5,  min:2,  max:60,  step:1},
    {key:'slow', label:'長期SMA', def:20, min:5,  max:250, step:1},
  ]},
  {id:'price_below_ma',  label:'價格跌破均線',   params:[
    {key:'period', label:'均線週期', def:20, min:5, max:250, step:1},
  ]},
  {id:'rsi_overbought',  label:'RSI超買回落',    params:[
    {key:'period',    label:'RSI週期',  def:14, min:2,  max:50, step:1},
    {key:'threshold', label:'超買閾值', def:70, min:50, max:95, step:1},
  ]},
  {id:'macd_death',      label:'MACD死亡交叉',   params:[
    {key:'fast',   label:'快線EMA', def:12, min:2,  max:50,  step:1},
    {key:'slow',   label:'慢線EMA', def:26, min:5,  max:100, step:1},
    {key:'signal', label:'訊號線',  def:9,  min:2,  max:30,  step:1},
  ]},
  {id:'boll_upper',      label:'觸碰布林上軌',   params:[
    {key:'period', label:'均線週期',   def:20,  min:5,  max:100, step:1},
    {key:'mult',   label:'標準差倍數', def:2.0, min:0.5, max:4.0, step:0.1},
  ]},
  {id:'kd_death',        label:'KD死亡交叉',     params:[
    {key:'period',    label:'KD週期',   def:9,  min:3,  max:30, step:1},
    {key:'threshold', label:'K值下限',  def:50, min:20, max:80, step:5},
  ]},
  {id:'price_low',       label:'跌破N日前低',    params:[
    {key:'period', label:'回看天數', def:20, min:5, max:120, step:1},
  ]},
  {id:'wr_overbought',   label:'威廉%R超買',     params:[
    {key:'period',    label:'WR週期',   def:14,  min:3,  max:50, step:1},
    {key:'threshold', label:'超買閾值', def:-20, min:-50, max:-5, step:1},
  ]},
  {id:'turtle_stop',     label:'海龜停損N日低',  params:[
    {key:'period', label:'停損天數', def:10, min:3, max:60, step:1},
  ]},
  {id:'trailing_stop',   label:'移動停損%',      params:[
    {key:'pct', label:'回撤%', def:5, min:1, max:30, step:0.5},
  ]},
];

var SHORT_ENTRY = [
  {id:'s_ma_death',        label:'均線死亡交叉', params:[
    {key:'fast', label:'短期SMA', def:5,  min:2,  max:60,  step:1},
    {key:'slow', label:'長期SMA', def:20, min:5,  max:250, step:1},
  ]},
  {id:'s_price_below_ma',  label:'價格跌破均線', params:[
    {key:'period', label:'均線週期', def:20, min:5, max:250, step:1},
  ]},
  {id:'s_rsi_overbought',  label:'RSI超買回落',  params:[
    {key:'period',    label:'RSI週期',  def:14, min:2, max:50, step:1},
    {key:'threshold', label:'超買閾值', def:70, min:50, max:95, step:1},
  ]},
  {id:'s_macd_death',      label:'MACD死亡交叉', params:[
    {key:'fast',   label:'快線EMA', def:12, min:2,  max:50,  step:1},
    {key:'slow',   label:'慢線EMA', def:26, min:5,  max:100, step:1},
    {key:'signal', label:'訊號線',  def:9,  min:2,  max:30,  step:1},
  ]},
  {id:'s_boll_upper',      label:'觸碰布林上軌', params:[
    {key:'period', label:'均線週期',   def:20,  min:5,  max:100, step:1},
    {key:'mult',   label:'標準差倍數', def:2.0, min:0.5, max:4.0, step:0.1},
  ]},
  {id:'s_kd_death',        label:'KD死亡交叉',   params:[
    {key:'period',    label:'KD週期', def:9,  min:3, max:30, step:1},
    {key:'threshold', label:'K值下限', def:50, min:20, max:80, step:5},
  ]},
  {id:'s_price_low',       label:'跌破N日前低',  params:[
    {key:'period', label:'回看天數', def:20, min:5, max:120, step:1},
  ]},
  {id:'s_wr_overbought',   label:'威廉%R超買',   params:[
    {key:'period',    label:'WR週期',   def:14,  min:3,  max:50, step:1},
    {key:'threshold', label:'超買閾值', def:-20, min:-50, max:-5, step:1},
  ]},
  {id:'s_turtle_low',      label:'海龜突破N日低', params:[
    {key:'period', label:'突破天數', def:20, min:5, max:120, step:1},
  ]},
];

var SHORT_EXIT = [
  {id:'s_ma_golden',      label:'均線黃金交叉',  params:[
    {key:'fast', label:'短期SMA', def:5,  min:2,  max:60,  step:1},
    {key:'slow', label:'長期SMA', def:20, min:5,  max:250, step:1},
  ]},
  {id:'s_price_above_ma', label:'價格突破均線',  params:[
    {key:'period', label:'均線週期', def:20, min:5, max:250, step:1},
  ]},
  {id:'s_rsi_oversold',   label:'RSI超賣反彈',   params:[
    {key:'period',    label:'RSI週期',  def:14, min:2, max:50, step:1},
    {key:'threshold', label:'超賣閾值', def:30, min:5, max:50, step:1},
  ]},
  {id:'s_macd_golden',    label:'MACD黃金交叉',  params:[
    {key:'fast',   label:'快線EMA', def:12, min:2,  max:50,  step:1},
    {key:'slow',   label:'慢線EMA', def:26, min:5,  max:100, step:1},
    {key:'signal', label:'訊號線',  def:9,  min:2,  max:30,  step:1},
  ]},
  {id:'s_boll_lower',     label:'觸碰布林下軌',  params:[
    {key:'period', label:'均線週期',   def:20,  min:5,  max:100, step:1},
    {key:'mult',   label:'標準差倍數', def:2.0, min:0.5, max:4.0, step:0.1},
  ]},
  {id:'s_kd_golden',      label:'KD黃金交叉',    params:[
    {key:'period',    label:'KD週期',  def:9,  min:3, max:30, step:1},
    {key:'threshold', label:'K值上限', def:50, min:20, max:80, step:5},
  ]},
  {id:'s_price_high',     label:'突破N日前高',   params:[
    {key:'period', label:'回看天數', def:20, min:5, max:120, step:1},
  ]},
  {id:'s_wr_oversold',    label:'威廉%R超賣',    params:[
    {key:'period',    label:'WR週期',   def:14,  min:3,  max:50,  step:1},
    {key:'threshold', label:'超賣閾值', def:-80, min:-95, max:-50, step:1},
  ]},
  {id:'s_turtle_high',    label:'海龜突破N日高', params:[
    {key:'period', label:'突破天數', def:20, min:5, max:120, step:1},
  ]},
  {id:'s_trailing',       label:'移動停損%',     params:[
    {key:'pct', label:'回撤%', def:5, min:1, max:30, step:0.5},
  ]},
];
var ALL_STRATS_MAP = {};
LONG_ENTRY.concat(LONG_EXIT).concat(SHORT_ENTRY).concat(SHORT_EXIT).forEach(function(s){ ALL_STRATS_MAP[s.id]=s.label; });

// 全域策略參數值 storage
// stratParams[groupId][stratId][paramKey] = value
var stratParams = {};

function buildCheckGroup(id, items) {
  var c = document.getElementById(id);
  if (!c) return;
  c.innerHTML = '';
  if (!stratParams[id]) stratParams[id] = {};
  // DEBUG: confirm params loaded
  var totalParams = items.reduce(function(n,i){return n+(i.params?i.params.length:0);},0);
  console.log('[BT] buildCheckGroup', id, 'items:', items.length, 'total params:', totalParams);
  items.forEach(function(item) {
    // 初始化預設值
    if (!stratParams[id][item.id]) {
      stratParams[id][item.id] = {};
      (item.params||[]).forEach(function(p){ stratParams[id][item.id][p.key] = p.def; });
    }

    var wrapper = document.createElement('div');
    wrapper.className = 'strat-param-wrap';
    wrapper.dataset.id = item.id;

    // 勾選列
    var lbl = document.createElement('label');
    lbl.className = 'check-item';
    lbl.innerHTML = '<input type="checkbox" value="' + item.id + '"><span>' + item.label + '</span>';
    var cb = lbl.querySelector('input');
    cb.addEventListener('change', function() {
      lbl.classList.toggle('on', this.checked);
      var pRow = wrapper.querySelector('.param-row');
      if (pRow) {
        pRow.classList.toggle('open', this.checked);
        wrapper.classList.toggle('has-params-open', this.checked);
      }
    });
    wrapper.appendChild(lbl);

    // 參數列（預設隱藏，勾選後顯示）
    if (item.params && item.params.length) {
      var pRow = document.createElement('div');
      pRow.className = 'param-row'; // open class 由 JS 控制

      // 橫排 inner wrapper
      var inner = document.createElement('div');
      inner.className = 'param-row-inner';

      item.params.forEach(function(p) {
        var cell = document.createElement('div');
        cell.className = 'param-cell';
        var curVal = stratParams[id][item.id][p.key];
        cell.innerHTML = '<span class="param-label">' + p.label + '</span>'
          + '<input class="param-input" type="number"'
          + ' value="' + curVal + '"'
          + ' min="' + p.min + '" max="' + p.max + '" step="' + p.step + '"'
          + ' data-group="' + id + '" data-strat="' + item.id + '" data-key="' + p.key + '">';
        cell.querySelector('input').addEventListener('change', function() {
          var v = parseFloat(this.value);
          if (isNaN(v)) v = p.def;
          v = Math.min(Math.max(v, p.min), p.max);
          this.value = v;
          stratParams[this.dataset.group][this.dataset.strat][this.dataset.key] = v;
        });
        inner.appendChild(cell);
      });
      pRow.appendChild(inner);
      wrapper.appendChild(pRow);
    }

    c.appendChild(wrapper);
  });
}

// 取得已勾選的策略 id 陣列（不含參數）
function getSelected(gid) {
  var r = [];
  document.querySelectorAll('#'+gid+' input[type=checkbox]:checked').forEach(function(cb){ r.push(cb.value); });
  return r;
}

// 取得已勾選策略的完整設定（含參數）
function getSelectedWithParams(gid) {
  var r = [];
  document.querySelectorAll('#'+gid+' input[type=checkbox]:checked').forEach(function(cb) {
    var id = cb.value;
    var p  = (stratParams[gid] && stratParams[gid][id]) ? Object.assign({}, stratParams[gid][id]) : {};
    r.push({ id: id, params: p });
  });
  return r;
}

// setChecked 需更新參數列顯示
function setChecked(gid, ids, paramMap) {
  document.querySelectorAll('#'+gid+' input[type=checkbox]').forEach(function(cb) {
    var on = (ids||[]).indexOf(cb.value) >= 0;
    cb.checked = on;
    cb.closest('.check-item').classList.toggle('on', on);
    var wrap = cb.closest('.strat-param-wrap');
    var pRow = wrap && wrap.querySelector('.param-row');
    if (pRow) { pRow.classList.toggle('open', on); }
    if (wrap) { wrap.classList.toggle('has-params-open', on && !!pRow); }
  });
  // 若有傳入 paramMap，更新參數值
  if (paramMap && stratParams[gid]) {
    Object.keys(paramMap).forEach(function(sid) {
      if (!stratParams[gid][sid]) stratParams[gid][sid] = {};
      Object.assign(stratParams[gid][sid], paramMap[sid]);
      // 更新 input 顯示值
      document.querySelectorAll('[data-group="'+gid+'"][data-strat="'+sid+'"]').forEach(function(inp) {
        var v = stratParams[gid][sid][inp.dataset.key];
        if (v != null) inp.value = v;
      });
    });
  }
}

['longEntryGroup','longExitGroup','shortEntryGroup','shortExitGroup','batchEntryGroup','batchExitGroup']
  .forEach(function(id) {
    var map = { longEntryGroup:LONG_ENTRY, longExitGroup:LONG_EXIT, shortEntryGroup:SHORT_ENTRY, shortExitGroup:SHORT_EXIT, batchEntryGroup:LONG_ENTRY, batchExitGroup:LONG_EXIT };
    buildCheckGroup(id, map[id]);
  });

// setChecked: 完整版已在上方定義（支援 paramMap）

// getSelected: 使用上方完整版（支援 checkbox type 篩選）

function selectAll(g) {
  document.querySelectorAll('#'+g+' input[type=checkbox]').forEach(function(cb) {
    cb.checked = true;
    cb.closest('.check-item').classList.add('on');
    var wrap = cb.closest('.strat-param-wrap');
    var pRow = wrap && wrap.querySelector('.param-row');
    if (pRow) { pRow.classList.add('open'); wrap.classList.add('has-params-open'); }
  });
}
function clearAll(g) {
  document.querySelectorAll('#'+g+' input[type=checkbox]').forEach(function(cb) {
    cb.checked = false;
    cb.closest('.check-item').classList.remove('on');
    var wrap = cb.closest('.strat-param-wrap');
    var pRow = wrap && wrap.querySelector('.param-row');
    if (pRow) { pRow.classList.remove('open'); wrap.classList.remove('has-params-open'); }
  });
}

setChecked('longEntryGroup', ['ma_golden','rsi_oversold']);
setChecked('longExitGroup',  ['ma_death','rsi_overbought']);

// ── 日期 ─────────────────────────────────────────────────────
var today = new Date().toISOString().split('T')[0];
document.getElementById('endDate').value = today;
function setYears(n) {
  var d=new Date(); d.setFullYear(d.getFullYear()-n);
  document.getElementById('startDate').value=d.toISOString().split('T')[0];
  document.getElementById('endDate').value=today;
}

// ── 開關 ─────────────────────────────────────────────────────
var autoFee=true, shortEnabled=false;
function toggleAutoFee() {
  autoFee=!autoFee;
  document.getElementById('autoFeeToggle').classList.toggle('on',autoFee);
  document.getElementById('feeCustom').style.display=autoFee?'none':'block';
  document.getElementById('feeAuto').style.display=autoFee?'block':'none';
}
function toggleShort() {
  shortEnabled=!shortEnabled;
  document.getElementById('shortToggle').classList.toggle('on',shortEnabled);
  document.getElementById('shortBody').style.display=shortEnabled?'block':'none';
}
function switchTab(idx) {
  document.querySelectorAll('.tab').forEach(function(t,i){t.classList.toggle('on',i===idx);});
  document.querySelectorAll('.tab-pane').forEach(function(p,i){p.classList.toggle('on',i===idx);});
}
function loadDemo() {
  document.getElementById('stockCode').value='2330'; setYears(3);
  document.getElementById('capital').value='1000000';
  document.getElementById('execType').value='close';
  document.getElementById('positionBase').value='equity';
  document.getElementById('posSize').value='100';
  document.getElementById('stopLoss').value='8';
  document.getElementById('stopProfit').value='25';
  document.getElementById('scoreThreshold').value='1';
  setChecked('longEntryGroup',['ma_golden','rsi_oversold']);
  setChecked('longExitGroup',['ma_death','rsi_overbought']);
}

// ── 資料抓取 ─────────────────────────────────────────────────
var dataCache = {};
async function fetchData(code, start, end) {
  var key = code+'_'+start+'_'+end;
  if (dataCache[key]) return dataCache[key];

  // 先試 Render 後端 /history
  try {
    var resp = await fetch(RENDER_URL+'/history?code='+code+'&start='+start+'&end='+end, {signal:AbortSignal.timeout(8000)});
    if (resp.ok) {
      var d = await resp.json();
      if (d && d.closes && d.closes.length > 50) { dataCache[key]=d; return d; }
    }
  } catch(e) {}

  // FinMind
  var url = 'https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id='+encodeURIComponent(code)+'&start_date='+start+'&end_date='+end;
  var resp = await fetch(url, {signal:AbortSignal.timeout(20000)});
  if (!resp.ok) throw new Error('HTTP '+resp.status);
  var json = await resp.json();
  var rows = (json.data||[]).filter(function(r){return +r.close>0;});
  if (rows.length<60) throw new Error('資料不足（'+rows.length+'筆），請擴大日期範圍（建議500天以上）');
  rows.sort(function(a,b){return a.date.localeCompare(b.date);});
  var result = {
    code:    code,
    dates:   rows.map(function(r){return r.date;}),
    opens:   rows.map(function(r){return +r.open||+r.close||0;}),
    highs:   rows.map(function(r){return +r.max ||+r.close||0;}),
    lows:    rows.map(function(r){return +r.min ||+r.close||0;}),
    closes:  rows.map(function(r){return +r.close||0;}),
    volumes: rows.map(function(r){return +r.Trading_Volume||0;}),
  };
  dataCache[key] = result;
  return result;
}

// ── 圖表繪製 ─────────────────────────────────────────────────
function drawChart(dates, equity, initCapital, trades) {
  var canvas = document.getElementById('equityChart');
  if (!canvas) return;
  var isDark = document.documentElement.getAttribute('data-theme')==='dark';
  var dpr = Math.min(window.devicePixelRatio||1, 2);
  var w = canvas.parentElement.clientWidth-24, h = 240;
  canvas.style.width=w+'px'; canvas.style.height=h+'px';
  canvas.width=w*dpr; canvas.height=h*dpr;
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr,dpr);

  var C = {
    bg:   isDark?'#141820':'#f0f2f5', line: isDark?'#3b82f6':'#2563eb',
    fill: isDark?'rgba(59,130,246,.1)':'rgba(37,99,235,.07)',
    grid: isDark?'rgba(255,255,255,.04)':'rgba(0,0,0,.05)',
    txt:  isDark?'#4a5568':'#9ca3af', base:'rgba(150,150,150,.2)',
    buy:  isDark?'#22c55e':'#16a34a', sell:isDark?'#ef4444':'#dc2626',
  };
  ctx.fillStyle=C.bg; ctx.fillRect(0,0,w,h);
  var P={t:10,r:16,b:28,l:70}, cw=w-P.l-P.r, ch=h-P.t-P.b, ne=equity.length;
  var minE=equity.reduce(function(a,b){return a<b?a:b;},equity[0]);
  var maxE=equity.reduce(function(a,b){return a>b?a:b;},equity[0]);
  var rng=maxE-minE||1; minE-=rng*.06; maxE+=rng*.06;
  function xp(i){return P.l+(i/(ne-1))*cw;}
  function yp(v){return P.t+(1-(v-minE)/(maxE-minE))*ch;}

  for (var g=0;g<=4;g++) {
    var gy=P.t+g*ch/4;
    ctx.strokeStyle=C.grid; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(P.l,gy); ctx.lineTo(P.l+cw,gy); ctx.stroke();
    ctx.fillStyle=C.txt; ctx.font='9px IBM Plex Mono,monospace'; ctx.textAlign='right';
    ctx.fillText(fmtK(maxE-g*(maxE-minE)/4), P.l-5, gy+4);
  }
  ctx.strokeStyle=C.base; ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.moveTo(P.l,yp(initCapital)); ctx.lineTo(P.l+cw,yp(initCapital)); ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  for (var i=0;i<ne;i++){i===0?ctx.moveTo(xp(0),yp(equity[0])):ctx.lineTo(xp(i),yp(equity[i]));}
  ctx.lineTo(xp(ne-1),P.t+ch); ctx.lineTo(xp(0),P.t+ch); ctx.closePath();
  ctx.fillStyle=C.fill; ctx.fill();

  ctx.beginPath(); ctx.strokeStyle=C.line; ctx.lineWidth=1.5;
  for (var i=0;i<ne;i++){i===0?ctx.moveTo(xp(0),yp(equity[0])):ctx.lineTo(xp(i),yp(equity[i]));}
  ctx.stroke();

  // Trade markers
  if (trades && dates) {
    var dm={};
    dates.forEach(function(d,i){dm[d]=i;});
    trades.filter(function(t){return t.type==='exit';}).forEach(function(t) {
      var ti = dm[t.exitDate||t.date];
      if (ti==null||ti>=ne) return;
      var tx=xp(ti), ty=yp(equity[ti]||equity[ne-1]);
      ctx.fillStyle=t.side==='long'?C.sell:C.buy;
      ctx.beginPath();
      ctx.moveTo(tx,ty+8); ctx.lineTo(tx-5,ty); ctx.lineTo(tx+5,ty);
      ctx.closePath(); ctx.fill();
    });
    trades.filter(function(t){return t.type==='entry';}).forEach(function(t) {
      var ti=dm[t.date]; if(ti==null||ti>=ne) return;
      var tx=xp(ti), ty=yp(equity[ti]||equity[ne-1]);
      ctx.fillStyle=t.side==='long'?C.buy:C.sell;
      ctx.beginPath();
      ctx.moveTo(tx,ty-8); ctx.lineTo(tx-5,ty); ctx.lineTo(tx+5,ty);
      ctx.closePath(); ctx.fill();
    });
  }

  ctx.fillStyle=C.txt; ctx.font='9px IBM Plex Mono,monospace'; ctx.textAlign='center';
  var step=Math.max(Math.floor(dates.length/5),1);
  for (var xi=0;xi<dates.length;xi+=step) ctx.fillText(dates[xi].slice(0,7), xp(xi), h-8);
}

// ── Formatters ────────────────────────────────────────────────
function fmtK(n) {
  if (n==null||isNaN(n)) return '—';
  if (Math.abs(n)>=1e6) return (n/1e6).toFixed(2)+'M';
  if (Math.abs(n)>=1e3) return (n/1e3).toFixed(0)+'K';
  return n.toFixed(0);
}
function fmtP(v,d){ if(v==null||isNaN(v))return'—'; d=d||2; return (v>=0?'+':'')+(v*100).toFixed(d)+'%'; }
function fmtM(v) { if(v==null||isNaN(v))return'—'; return (v>=0?'+':'')+Math.round(v).toLocaleString(); }
function fmtN(v,d){ if(v==null||isNaN(v))return'—'; return v.toFixed(d||2); }
function sc(label,val,cls) {
  return '<div class="stat-card"><div class="stat-label">'+label+'</div><div class="stat-val '+cls+'">'+val+'</div></div>';
}

// 無虧損交易時獲利因子沒有定義（引擎以 999 代表），不顯示成數字
function pfTxt(m) { return m.profitFactor >= 999 ? '無虧損交易' : fmtN(m.profitFactor); }
// 回測診斷：訊號數、未成交原因、暖機期與成交時點的限制
function diagHTML(dg, m, cfg) {
  if (!dg) return '';
  var lines = [];
  if (dg.preBars) lines.push('回測期間自 ' + dg.periodStart + ' 起（' + dg.bars + ' 個交易日）；另使用起始日前 ' + dg.preBars + ' 根 K 線計算指標，這段不交易、不計入績效。');
  if (dg.startDelayed) lines.push('起始日前的資料不足 ' + dg.lookback + ' 根（指標所需回看長度），' + dg.tradeFrom + ' 之前不交易，但這段仍計入績效期間。');
  else if (!dg.preBars) lines.push('前 ' + dg.warmup + ' 根 K 線用於指標暖機、不交易；可交易期間自 ' + (dg.tradeFrom || '—') + ' 起。');
  if (dg.corpChecked === false) lines.push('⚠ 資料來自備援來源，未檢查分割、面額變更或減資等公司行動；若期間內發生，結果會失真。');
  lines.push('進場訊號 ' + dg.entrySignals + ' 次、出場訊號 ' + dg.exitSignals + ' 次；實際完成 ' + m.tradeCount + ' 筆交易。');
  if (dg.rejected) lines.push('有 ' + dg.rejected + ' 次進場訊號未成交' + (dg.rejectedCash ? '，其中 ' + dg.rejectedCash + ' 次是現金不足以買進一張（各次所需含手續費金額介於 ' + Number(dg.minCashNeeded).toLocaleString() + '～' + Number(dg.maxCashNeeded).toLocaleString() + ' 元，依當次成交參考價而定）。本系統以整張交易，未模擬零股。' : '。'));
  if (!dg.entrySignals && dg.bars + dg.preBars <= dg.warmup) lines.push('資料長度（' + dg.bars + ' 根）不足暖機期，請擴大回測區間。');
  else if (!dg.entrySignals) lines.push('可交易期間內沒有出現符合條件的進場訊號（共振門檻 ' + (cfg.scoreThreshold || 1) + ' 分）。');
  if (dg.openAtEnd) lines.push('回測結束時仍有未平倉部位，未計入已完成交易的統計。');
  if (dg.pendingAtEnd) lines.push('最後一天的訊號需在下一個交易日開盤執行，資料已結束，未成交。');
  lines.push('停損與停利只在單一價格點檢查（開盤模式看開盤價、收盤模式看收盤價），觸發時以同一價格成交；未使用盤中最高、最低價，盤中觸及但未在該價格點觸及的情況不會出場。');
  if (cfg.execType === 'close') lines.push('「當日收盤成交」假設訊號出現當天就能用收盤價成交；但收盤確認的訊號要收盤後才知道，實務上做不到，結果會偏樂觀。較保守的設定是「隔日開盤」。');
  return '<div class="signal-box" style="margin-top:8px"><div class="signal-title">回測診斷</div><div style="font-size:11px;line-height:1.8;color:var(--text2)">' + lines.join('<br>') + '</div></div>';
}

// ── 顯示結果 ─────────────────────────────────────────────────
function showResults(result, data) {
  var NT = !(result.metrics && result.metrics.tradeCount > 0), NA = '不適用（無交易）';
  var m = result.metrics;
  window._lastResult = result;
  window._lastData   = data;
  var view = data;
  if (result.offset && data.dates && result.equity && data.dates.length !== result.equity.length) {
    view = { code: data.code }; ['dates', 'opens', 'highs', 'lows', 'closes', 'volumes'].forEach(function(k) { view[k] = (data[k] || []).slice(result.offset); });
  }
  window._lastView = view;

  // 今日訊號（直接用 core 的 SignalEngine）
  var lastI = data.closes.length - 1;
  var ind   = Indicators.precompute(data);
  var cfg   = window._lastConfig;
  var thr   = cfg.scoreThreshold || 1;
  var le    = SignalEngine.scoreLongEntry(lastI, ind, data, {entry:cfg.longEntry||[], exit:cfg.longExit||[]});
  var lx    = SignalEngine.scoreLongExit( lastI, ind, data, {entry:cfg.longEntry||[], exit:cfg.longExit||[]});
  var sigCls='hold-sig', sigTxt='觀望', sigInfo='策略分數不足（'+Math.max(le,lx)+'/'+thr+'）';
  if (le>=thr){ sigCls='buy-sig';  sigTxt='買入訊號'; sigInfo='進場共振分數 '+le+' 分（閾值 '+thr+'）'; }
  else if(lx>=thr){ sigCls='sell-sig'; sigTxt='賣出訊號'; sigInfo='出場共振分數 '+lx+' 分（閾值 '+thr+'）'; }

  // Tab 0: Summary
  document.getElementById('summaryContent').innerHTML =
    '<div class="fade-up">'
    +'<div class="export-bar">'
    +'<button class="btn-sm" onclick="doExportJSON()">JSON</button>'
    +'<button class="btn-sm" onclick="doExportTrades()">CSV 交易</button>'
    +'<button class="btn-sm" onclick="doExportEquity()">CSV 淨值</button>'
    +'<button class="btn-sm" onclick="alert(\'Benchmark/Replay/Monte Carlo 開發中\')" style="color:var(--text3)">更多...</button>'
    +'<span class="worker-badge" onclick="toggleDebug()" title="點擊切換 debug 模式">'+(BT_DEBUG?'DEBUG ON':'Web Worker ✓')+'&nbsp;v'+(BT_ENGINE?BT_ENGINE.version:'4.1')+'</span>'
    +'</div>'
    +'<div class="signal-box"><div class="signal-title">今日操作建議 — '+(cfg.code||'')+'（'+data.dates[lastI]+'）</div>'
    +'<div style="display:flex;align-items:center;gap:10px"><span class="signal-badge '+sigCls+'">'+sigTxt+'</span>'
    +'<span style="font-size:12px;color:var(--text2)">'+sigInfo+'</span></div></div>'
    +'<div class="stat-grid">'
    +sc('總報酬率', fmtP(m.totalReturn), m.totalReturn>=0?'pos':'neg')
    +sc('年化報酬率',fmtP(m.cagr),       m.cagr>=0?'pos':'neg')
    +sc('夏普比率',  NT ? NA : fmtN(m.sharpe), NT ? 'neu' : m.sharpe>=1?'pos':m.sharpe>=0?'neu':'neg')
    +sc('最大回撤',  fmtP(-m.maxDD),     'neg')
    +sc('交易次數',  m.tradeCount+'次',  'neu')
    +sc('勝率',      NT ? NA : (m.winRate*100).toFixed(1)+'%', NT ? 'neu' : m.winRate>=0.5?'pos':'neg')
    +sc('獲利因子',  NT ? NA : pfTxt(m), NT ? 'neu' : m.profitFactor>=1.5?'pos':m.profitFactor>=1?'neu':'neg')
    +sc('最終權益',  'NT$'+Math.round(m.finalEquity).toLocaleString(), m.finalEquity>=m.initCapital?'pos':'neg')
    +'</div>'
    +diagHTML(result.diag, m, cfg)
    +'<div class="chart-wrap"><div class="chart-title">淨值曲線（▲進場 ▽出場）</div>'
    +'<canvas id="equityChart" style="display:block"></canvas></div>'
    +'</div>';
  requestAnimationFrame(function(){ drawChart(view.dates, result.equity, m.initCapital, result.trades); });

  // Tab 1: Metrics
  document.getElementById('perfContent').innerHTML =
    '<div class="fade-up"><div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">'
    +sc('總獲利', fmtM(m.finalEquity-m.initCapital)+'元', m.finalEquity>=m.initCapital?'pos':'neg')
    +sc('年化報酬率', fmtP(m.cagr),       m.cagr>=0?'pos':'neg')
    +sc('夏普比率',   NT ? NA : fmtN(m.sharpe),  NT ? 'neu' : m.sharpe>=1?'pos':'neu')
    +sc('索提諾比率', NT ? NA : fmtN(m.sortino), NT ? 'neu' : m.sortino>=1?'pos':'neu')
    +sc('卡瑪比率',   NT ? NA : fmtN(m.calmar),  NT ? 'neu' : m.calmar>=0.5?'pos':'neu')
    +sc('最大回撤',   fmtP(-m.maxDD),     'neg')
    +sc('獲利因子',   NT ? NA : pfTxt(m), NT ? 'neu' : m.profitFactor>=1.5?'pos':'neu')
    +sc('期望值(元)', NT ? NA : fmtM(m.expectancy), NT ? 'neu' : m.expectancy>0?'pos':'neg')
    +sc('勝率',       NT ? NA : (m.winRate*100).toFixed(1)+'%', NT ? 'neu' : m.winRate>=0.5?'pos':'neg')
    +sc('平均獲利',   NT ? NA : fmtM(m.avgWin)+'元', 'pos')
    +sc('平均虧損',   NT ? NA : fmtM(m.avgLoss)+'元','neg')
    +sc('最大連勝',   NT ? NA : m.maxWinStreak+'次','pos')
    +sc('最大連敗',   NT ? NA : m.maxLoseStreak+'次','neg')
    +sc('復原因子',   fmtN(m.recoveryFactor), m.recoveryFactor>=1?'pos':'neu')
    +sc('持倉曝光率', (m.exposure*100).toFixed(1)+'%','neu')
    +sc('年化波動率', m.annVolatility!=null?fmtP(m.annVolatility):'—','neu')
    +sc('平均持倉天數',m.avgHoldingDays!=null?fmtN(m.avgHoldingDays,1)+'日':'—','neu')
    +sc('回測年數',   fmtN(m.years,1)+'年','neu')
    +'</div>'
    +'<div class="chart-wrap"><div class="chart-title">年度績效</div>'
    +'<table class="data-table"><thead><tr><th>年份</th><th>年初</th><th>年末</th><th>年度報酬</th><th>出場次數</th></tr></thead><tbody>'
    +Object.keys(m.annual||{}).sort().map(function(y){
        var a=m.annual[y], ret=(a.endV-a.startV)/a.startV;
        return '<tr><td>'+y+'</td><td>'+Math.round(a.startV).toLocaleString()+'</td><td>'+Math.round(a.endV).toLocaleString()+'</td>'
          +'<td style="color:var(--'+(ret>=0?'green':'red')+')">'+(ret>=0?'+':'')+(ret*100).toFixed(2)+'%</td>'
          +'<td>'+(a.tradeCnt||0)+'</td></tr>';
      }).join('')
    +'</tbody></table></div></div>';

  // Tab 2: Trades
  var exitTrades = result.trades.filter(function(t){return t.type==='exit';}).slice().reverse();
  document.getElementById('tradesContent').innerHTML =
    '<div class="fade-up" style="overflow-x:auto"><table class="data-table"><thead><tr>'
    +'<th>出場日</th><th>方向</th><th>原因</th><th>進場價</th><th>出場價</th>'
    +'<th>張數</th><th>淨損益(元)</th><th>損益%</th><th>進場日</th>'
    +'</tr></thead><tbody>'
    +exitTrades.map(function(t){
        var side=t.side==='long'?'多':'空';
        var pCls=t.netPnl>0?'pos':'neg';
        return '<tr>'
          +'<td style="font-family:IBM Plex Mono,monospace">'+(t.exitDate||t.date||'')+'</td>'
          +'<td><span class="badge '+(t.side==='long'?'buy':'short')+'">'+side+'</span></td>'
          +'<td style="font-size:10px;color:var(--text3)">'+(t.reason||'')+'</td>'
          +'<td style="font-family:IBM Plex Mono,monospace">'+t.entryPrice.toFixed(2)+'</td>'
          +'<td style="font-family:IBM Plex Mono,monospace">'+t.exitPrice.toFixed(2)+'</td>'
          +'<td>'+t.qty+'</td>'
          +'<td class="'+pCls+'" style="font-family:IBM Plex Mono,monospace">'+fmtM(t.netPnl)+'</td>'
          +'<td class="'+pCls+'">'+(t.pnlPct!=null?t.pnlPct.toFixed(2)+'%':'—')+'</td>'
          +'<td style="font-family:IBM Plex Mono,monospace;font-size:10px;color:var(--text3)">'+(t.entryDate||'')+'</td>'
          +'</tr>';
      }).join('')
    +'</tbody></table></div>';

  // 備份
  BacktestStorage.saveLastResult(result, view, window._lastConfig);
}

// ── 回測執行 ─────────────────────────────────────────────────
var isRunning = false;
window._lastConfig = null;
window._lastData   = null;
window._lastResult = null;

async function runBacktest() {
  if (isRunning) return;
  isRunning = true;
  var btn=document.getElementById('runBtn');
  btn.disabled=true; btn.textContent='回測中...'; btn.classList.add('running');
  setProgress(0,'準備中...');

  var code      = (document.getElementById('stockCode').value||'').trim().toUpperCase();
  var start     = document.getElementById('startDate').value;
  var end       = document.getElementById('endDate').value;
  var capital   = +document.getElementById('capital').value     || 1000000;
  var execType  = document.getElementById('execType').value;
  var posBase   = document.getElementById('positionBase').value;
  var posSize   = +document.getElementById('posSize').value     || 100;
  var stopLoss  = +document.getElementById('stopLoss').value    || 0;
  var stopProfit= +document.getElementById('stopProfit').value  || 0;
  var threshold = parseInt(document.getElementById('scoreThreshold').value,10)||1;
  var isETF     = /^00/.test(code);
  var buyFee    = autoFee ? (isETF?0.1:0.1425) : +document.getElementById('buyFee').value;
  var sellFee   = autoFee ? (isETF?0.2:0.4425) : +document.getElementById('sellFee').value;

  if (!code)  { alert('請輸入股票代號'); return done(); }
  var longEntryIds = getSelected('longEntryGroup');
  if (!longEntryIds.length) { alert('請至少選一個進場策略'); return done(); }

  var config = {
    code, capital, execType, positionBase:posBase, posSize, stopLoss, stopProfit,
    buyFee, sellFee, scoreThreshold:threshold,
    longEntry:  getSelectedWithParams('longEntryGroup'),
    longExit:   getSelectedWithParams('longExitGroup'),
    shortEnabled,
    shortEntry: shortEnabled ? getSelectedWithParams('shortEntryGroup') : [],
    shortExit:  shortEnabled ? getSelectedWithParams('shortExitGroup')  : [],
  };
  window._lastConfig = config;

  try {
    setProgress(15,'抓取 '+code+' 歷史資料...');
    // 多抓起始日前約 400 個日曆日（約 270 個交易日）供指標暖機；交易與績效只從起始日開始
    var pre = new Date(start + 'T00:00:00'); pre.setDate(pre.getDate() - 400);
    var preStart = pre.getFullYear() + '-' + String(pre.getMonth() + 1).padStart(2, '0') + '-' + String(pre.getDate()).padStart(2, '0');
    var data = await fetchData(code, preStart, end);
    config.tradeStart = start;
    config.unexplained = Array.isArray(data.unexplained) ? data.unexplained.map(function(x) { return x.date; }) : null;
    config.corpChecked = Array.isArray(data.unexplained); // 備援來源（直接打 FinMind）沒有公司行動檢查
    setProgress(40,'共 '+data.closes.length+' 筆，啟動 Web Worker...');

    // 傳送 typed array 需先轉為普通陣列（postMessage structured clone）
    var transferData = {
      code:    data.code,
      dates:   data.dates,
      opens:   Array.from(data.opens),
      highs:   Array.from(data.highs),
      lows:    Array.from(data.lows),
      closes:  Array.from(data.closes),
      volumes: Array.from(data.volumes),
    };

    workerPost('backtest',
      { data: transferData, config: config },
      function(pct){ setProgress(40 + pct*0.5, '計算中 '+pct+'%...'); },
      function(result, err) {
        if (err) { setProgress(0,'錯誤：'+err); return done(); }
        setProgress(100,'回測完成 — '+(result.equity?result.equity.length:data.closes.length)+' 個交易日，'+result.metrics.tradeCount+' 筆交易');
        // 還原 typed array
        result.equity = Array.isArray(result.equity) ? result.equity : Array.from(result.equity);
        showResults(result, data);
        switchTab(0);
        done();
      }
    );
  } catch(e) {
    setProgress(0,'錯誤：'+e.message);
    done();
  }

  function done() { isRunning=false; btn.disabled=false; btn.textContent='開始回測'; btn.classList.remove('running'); }
}

function setProgress(pct,text) {
  document.getElementById('progressFill').style.width=pct+'%';
  document.getElementById('statusText').textContent=text;
}

// ── 參數優化（Worker）────────────────────────────────────────
var optRunning=false, optMsgId=0;
function runOptimize() {
  if (optRunning||!window._lastData) { if(!window._lastData) alert('請先執行回測'); return; }
  optRunning=true;
  var btn=document.getElementById('optBtn'); btn.disabled=true; btn.textContent='優化中...';
  document.getElementById('optProgress').style.width='0%';
  document.getElementById('optStatus').textContent='啟動 Worker...';

  var data=window._lastData;
  var td={ code:data.code, dates:data.dates, opens:Array.from(data.opens), highs:Array.from(data.highs), lows:Array.from(data.lows), closes:Array.from(data.closes), volumes:Array.from(data.volumes) };

  optMsgId = workerPost('optimize',
    { data:td, config:window._lastConfig, target:document.getElementById('optTarget').value, maxIter:Math.min(parseInt(document.getElementById('optIter').value)||60, 200) },
    function(pct){ document.getElementById('optProgress').style.width=pct+'%'; document.getElementById('optStatus').textContent='測試中 '+pct+'%...'; },
    function(results, err) {
      optRunning=false; btn.disabled=false; btn.textContent='開始參數優化';
      if (err) { document.getElementById('optStatus').textContent='錯誤：'+err; return; }
      renderOptResults(results);
      BacktestStorage.saveOptResult(results, window._lastConfig);
    }
  );
}

function renderOptResults(results) {
  if (!results||!results.length) { document.getElementById('optStatus').textContent='無結果'; return; }
  var best=results[0];
  document.getElementById('optResult').innerHTML=
    '<div style="background:var(--bg3);border:1px solid var(--green);border-radius:6px;padding:10px 12px;margin-bottom:10px">'
    +'<div style="font-family:IBM Plex Mono,monospace;font-size:9px;color:var(--green);letter-spacing:.1em;margin-bottom:6px">最佳參數</div>'
    +'<div style="font-size:12px">停損：'+(best.params.stopLoss||'無')+'% | 停利：'+(best.params.stopProfit||'無')+'%</div>'
    +'<div style="font-size:11px;color:var(--text2);margin-top:4px">年化：'+fmtP(best.metrics.cagr)+' 夏普：'+fmtN(best.metrics.sharpe)+' 最大回撤：'+fmtP(-best.metrics.maxDD)+' 勝率：'+(best.metrics.winRate*100).toFixed(1)+'%</div>'
    +'</div>'
    +'<div style="overflow-x:auto"><table class="data-table"><thead><tr>'
    +'<th>排名</th><th>停損%</th><th>停利%</th><th>年化報酬</th><th>夏普</th><th>索提諾</th><th>卡瑪</th><th>最大回撤</th><th>勝率</th><th>交易數</th>'
    +'</tr></thead><tbody>'
    +results.slice(0,15).map(function(r,i){
        return '<tr><td>'+(i+1)+'</td><td>'+(r.params.stopLoss||'—')+'</td><td>'+(r.params.stopProfit||'—')+'</td>'
          +'<td style="color:var(--'+(r.metrics.cagr>=0?'green':'red')+')">'  +fmtP(r.metrics.cagr)+'</td>'
          +'<td>'+fmtN(r.metrics.sharpe)+'</td><td>'+fmtN(r.metrics.sortino)+'</td><td>'+fmtN(r.metrics.calmar)+'</td>'
          +'<td style="color:var(--red)">'+fmtP(-r.metrics.maxDD)+'</td>'
          +'<td>'+(r.metrics.tradeCount>0?(r.metrics.winRate*100).toFixed(1)+'%':'—')+'</td><td>'+r.metrics.tradeCount+'</td></tr>';
      }).join('')
    +'</tbody></table></div>';
  document.getElementById('optStatus').textContent='優化完成，共 '+results.length+' 組';
}

// ── 批量優化（Worker）────────────────────────────────────────
var batchRunning=false;
function runBatchOpt() {
  if (batchRunning||!window._lastData) { if(!window._lastData) alert('請先執行回測'); return; }
  // 取得含參數的策略設定
  var entries=getSelectedWithParams('batchEntryGroup'), exits=getSelectedWithParams('batchExitGroup');
  var entryIds=getSelected('batchEntryGroup'), exitIds=getSelected('batchExitGroup');
  if (!entryIds.length||!exitIds.length) { alert('請選擇策略'); return; }
  batchRunning=true;
  var btn=document.getElementById('batchBtn'); btn.disabled=true; btn.textContent='優化中...';
  document.getElementById('batchProgress').style.width='0%';

  // combos：entry/exit 各帶完整 params（{id, params}[]）
  var combos=[];
  entries.forEach(function(e){
    exits.forEach(function(x){
      combos.push({entry:[e], exit:[x]});
    });
  });
  var maxCombos=Math.min(combos.length, +document.getElementById('batchIter').value||50);
  combos=combos.slice(0,maxCombos);

  var data=window._lastData;
  var td={ code:data.code, dates:data.dates, opens:Array.from(data.opens), highs:Array.from(data.highs), lows:Array.from(data.lows), closes:Array.from(data.closes), volumes:Array.from(data.volumes) };

  workerPost('batch',
    { data:td, config:window._lastConfig, combos:combos, target:document.getElementById('batchTarget').value },
    function(pct){ document.getElementById('batchProgress').style.width=pct+'%'; document.getElementById('batchStatus').textContent='優化中 '+pct+'%...'; },
    function(results, err) {
      batchRunning=false; btn.disabled=false; btn.textContent='開始批量優化';
      if (err) { document.getElementById('batchStatus').textContent='錯誤：'+err; return; }
      renderBatchResults(results);
      BacktestStorage.saveBatchResult(results);
    }
  );
}
function stopBatch() {
  batchRunning = false;
  cancelWorker(); // terminate worker，避免 batch 繼續跑
  document.getElementById('batchStatus').textContent = '已停止（Worker 已終止）';
}

function renderBatchResults(results) {
  if (!results||!results.length) return;
  document.getElementById('batchResult').innerHTML=
    '<div style="overflow-x:auto"><table class="data-table"><thead><tr>'
    +'<th>排名</th><th>買入策略</th><th>賣出策略</th><th>年化報酬</th><th>夏普</th><th>索提諾</th><th>最大回撤</th><th>勝率</th><th>交易數</th>'
    +'</tr></thead><tbody>'
    +results.slice(0,30).map(function(r,i){
        var eLabel = ALL_STRATS_MAP[r.entry] || r.entry || '—';
        var xLabel = ALL_STRATS_MAP[r.exit]  || r.exit  || '—';
        // 附上關鍵參數摘要（若有）
        function paramSummary(params) {
          if (!params) return '';
          return ' <span style="color:var(--text3);font-size:9px">['+Object.values(params).join('/')+'</span>]';
        }
        return '<tr><td>'+(i+1)+'</td>'
          +'<td style="font-size:10px">'+eLabel+paramSummary(r.entryParams)+'</td>'
          +'<td style="font-size:10px">'+xLabel+paramSummary(r.exitParams)+'</td>'
          +'<td style="color:var(--'+(r.metrics.cagr>=0?'green':'red')+')">'  +fmtP(r.metrics.cagr)+'</td>'
          +'<td>'+fmtN(r.metrics.sharpe)+'</td><td>'+fmtN(r.metrics.sortino)+'</td>'
          +'<td style="color:var(--red)">'+fmtP(-r.metrics.maxDD)+'</td>'
          +'<td>'+(r.metrics.tradeCount>0?(r.metrics.winRate*100).toFixed(1)+'%':'—')+'</td><td>'+r.metrics.tradeCount+'</td></tr>';
      }).join('')
    +'</tbody></table></div>';
  document.getElementById('batchStatus').textContent='批量優化完成，共 '+results.length+' 組';
}

// ── 匯出 ─────────────────────────────────────────────────────
function dlFile(content,filename,mime) {
  var blob=new Blob([content],{type:mime}); var url=URL.createObjectURL(blob);
  var a=document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
// Console debug mode toggle
function toggleDebug() {
  try {
    var cur = localStorage.getItem('bt_debug') === '1';
    localStorage.setItem('bt_debug', cur ? '0' : '1');
    // 更新全域 flag
    window.BT_DEBUG = !cur;
    console.log('[BT] Debug mode:', !cur ? 'ON' : 'OFF');
    // 重新渲染 badge（如果有結果）
    if (window._lastResult && window._lastData) {
      showResults(window._lastResult, window._lastData);
    }
  } catch(e) {}
}

function doExportJSON() {
  if (!window._lastResult) return alert('請先執行回測');
  dlFile(BacktestStorage.exportFullJSON(window._lastResult,window._lastData,window._lastConfig),
    (window._lastConfig.code||'bt')+'_backtest_'+today+'.json','application/json');
}
function doExportTrades() {
  if (!window._lastResult) return alert('請先執行回測');
  dlFile(BacktestStorage.exportTradesCSV(window._lastResult),
    (window._lastConfig.code||'bt')+'_trades_'+today+'.csv','text/csv;charset=utf-8');
}
function doExportEquity() {
  if (!window._lastResult) return alert('請先執行回測');
  dlFile(BacktestStorage.exportEquityCSV(window._lastResult,(window._lastResult&&window._lastResult.dates)||(window._lastData?window._lastData.dates:null)),
    (window._lastConfig.code||'bt')+'_equity_'+today+'.csv','text/csv;charset=utf-8');
}

// ── 策略管理 ─────────────────────────────────────────────────
function saveStrategy() {
  var name=(document.getElementById('stratName').value||'').trim();
  if (!name) { alert('請輸入策略名稱'); return; }
  var m=window._lastResult?window._lastResult.metrics:null;
  BacktestStorage.saveStrategy({
    name, code:document.getElementById('stockCode').value,
    startDate:document.getElementById('startDate').value,
    endDate:document.getElementById('endDate').value,
    capital:document.getElementById('capital').value,
    execType:document.getElementById('execType').value,
    positionBase:document.getElementById('positionBase').value,
    posSize:document.getElementById('posSize').value,
    stopLoss:document.getElementById('stopLoss').value,
    stopProfit:document.getElementById('stopProfit').value,
    scoreThreshold:document.getElementById('scoreThreshold').value,
    longEntry:    getSelectedWithParams('longEntryGroup'),
    longExit:     getSelectedWithParams('longExitGroup'),
    longEntryIds: getSelected('longEntryGroup'),
    longExitIds:  getSelected('longExitGroup'),
    shortEnabled: shortEnabled,
    shortEntry:    getSelectedWithParams('shortEntryGroup'),
    shortExit:     getSelectedWithParams('shortExitGroup'),
    shortEntryIds: getSelected('shortEntryGroup'),
    shortExitIds:  getSelected('shortExitGroup'),
    cagr:   m?fmtP(m.cagr):'—', sharpe:m?fmtN(m.sharpe):'—',
    savedAt:new Date().toLocaleDateString('zh-TW'),
  });
  document.getElementById('stratName').value='';
  renderStratList();
}

function renderStratList() {
  var list=BacktestStorage.loadStrategies();
  var el=document.getElementById('stratList');
  if (!list.length) { el.innerHTML='<div style="font-size:11px;color:var(--text3);text-align:center;padding:10px">尚無儲存策略</div>'; return; }
  el.innerHTML='';
  list.forEach(function(s) {
    var item=document.createElement('div'); item.className='strat-item';
    item.innerHTML='<div style="flex:1"><div class="strat-name">'+s.name+'</div>'
      +'<div class="strat-stats">'+s.code+' | '+s.cagr+' | 夏普 '+s.sharpe+'</div></div>'
      +'<button class="strat-del" data-name="'+s.name+'">✕</button>';
    item.querySelector('.strat-del').onclick=function(e){e.stopPropagation();BacktestStorage.deleteStrategy(this.dataset.name);renderStratList();};
    item.onclick=function(e){ if(!e.target.classList.contains('strat-del')) loadStrategy(s); };
    el.appendChild(item);
  });
}

function loadStrategy(s) {
  [['stockCode',s.code],['startDate',s.startDate],['endDate',s.endDate],
   ['capital',s.capital],['execType',s.execType],['positionBase',s.positionBase],
   ['posSize',s.posSize],['stopLoss',s.stopLoss],['stopProfit',s.stopProfit],
   ['scoreThreshold',s.scoreThreshold||1]
  ].forEach(function(pair){ var el=document.getElementById(pair[0]); if(el&&pair[1]!=null)el.value=pair[1]; });
  // 支援舊版（string[]）和新版（{id,params}[]）
  function toIds(arr) { return (arr||[]).map(function(x){return x.id||x;}); }
  function toParamMap(arr) {
    var m={};
    (arr||[]).forEach(function(x){ if(x.id&&x.params) m[x.id]=Object.assign({},x.params); });
    return m;
  }

  var leIds    = toIds(s.longEntryIds||s.longEntry);
  var lxIds    = toIds(s.longExitIds||s.longExit);
  var leParams = toParamMap(s.longEntry||[]);
  var lxParams = toParamMap(s.longExit||[]);
  setChecked('longEntryGroup', leIds, leParams);
  setChecked('longExitGroup',  lxIds, lxParams);

  // 還原做空策略
  if (s.shortEnabled) {
    shortEnabled = true;
    document.getElementById('shortToggle').classList.add('on');
    document.getElementById('shortBody').style.display = 'block';
  } else {
    shortEnabled = false;
    document.getElementById('shortToggle').classList.remove('on');
    document.getElementById('shortBody').style.display = 'none';
  }
  var seIds    = toIds(s.shortEntryIds||s.shortEntry);
  var sxIds    = toIds(s.shortExitIds||s.shortExit);
  var seParams = toParamMap(s.shortEntry||[]);
  var sxParams = toParamMap(s.shortExit||[]);
  setChecked('shortEntryGroup', seIds, seParams);
  setChecked('shortExitGroup',  sxIds, sxParams);
}

renderStratList();

