// 後端位址統一由 js/config.js 的 window.API_BASE 決定（空字串＝同源）
window.RENDER_URL = window.API_BASE || "";
// HTML 跳脫：所有來自 API 的字串進 innerHTML 前都要過這一關
function esc(v) { return String(v === null || v === undefined ? "" : v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function showDemoBanner(on) { var b = document.getElementById("demoBanner"); if (b && on) b.style.display = "block"; }
// 預設熱門股（未載入前顯示）
var HOTS_DEFAULT = [
  {c:"2330",n:"台積電"},{c:"2317",n:"鴻海"},{c:"2454",n:"聯發科"},
  {c:"2308",n:"台達電"},{c:"2603",n:"長榮"},{c:"2412",n:"中華電"},
  {c:"2882",n:"國泰金"},{c:"00878",n:"國泰永續"},{c:"3711",n:"日月光"},
  {c:"2891",n:"中信金"}
];
var HOTS = HOTS_DEFAULT.slice();

// 初始化先渲染預設，再延遲更新
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
  // 族群掃描結果的股票連結（事件委派）
  document.addEventListener('click', function(e) {
    var el = e.target.closest('.scan-deep-link');
    if (!el) return;
    e.preventDefault();
    var code = el.dataset.code;
    if (code) { document.getElementById('inp').value = code; doSearch(code); }
  });
    renderHots();
    // 先打 /health：喚醒休眠中的後端，並確認是否為示範資料模式
    fetch(window.RENDER_URL + "/health").then(function(r){ return r.json(); }).then(function(h){ showDemoBanner(h && h.demo); }).catch(function(){});
    setTimeout(loadHotStocks, 1500); // 頁面載入 1.5s 後才打 API，讓 Render 先醒
  });
} else {
  renderHots();
  setTimeout(loadHotStocks, 1500);
}

// 動態抓取熱門股（漲停+成交量各5支，共10支）
var _loadHotsRunning = false;
function loadHotStocks() {
  if (_loadHotsRunning) return; // 防止重複呼叫
  _loadHotsRunning = true;
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = setTimeout(function() { if (controller) { controller.abort(); controller = null; } }, 12000); // 12s timeout
  var opts = controller ? { signal: controller.signal } : {};

  fetch(window.RENDER_URL + "/scan?mode=volume&limit=10&lite=1", opts) // lite：只要排行，不觸發個股評分
    .then(function(r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function(data) {
      clearTimeout(timer);
      _loadHotsRunning = false;
      var stocks = (data.stocks || []).slice(0, 10);
      if (stocks.length < 3) return; // 資料不足不更新
      HOTS = stocks.map(function(s) { return { c: s.code, n: s.name || s.code }; });
      renderHots();
    })
    .catch(function() {
      clearTimeout(timer);
      _loadHotsRunning = false;
      // 失敗時保持 HOTS_DEFAULT，不顯示錯誤
    });
}

function renderHots() {
  var hotsEl = document.getElementById("hots");
  var wbtnsEl = document.getElementById("wbtns");
  hotsEl.innerHTML = "";
  wbtnsEl.innerHTML = "";
  HOTS.forEach(function(h) {
    var b = document.createElement("button");
    b.className = "hot-chip"; b.textContent = h.c;
    b.onclick = function() { document.getElementById("inp").value = h.c; doSearch(h.c); };
    hotsEl.appendChild(b);
    var w = document.createElement("div"); w.className = "welcome-chip";
    w.innerHTML = '<div class="wc">'+esc(h.c)+'</div><div class="wn">'+esc(h.n)+'</div>';
    w.onclick = function() { document.getElementById("inp").value = h.c; doSearch(h.c); };
    wbtnsEl.appendChild(w);
  });
}
var TABS = ["行情","技術","短中長線","籌碼","基本面","風險","策略"];

// 主題切換
function toggleTheme() {
  var html = document.documentElement;
  var isDark = html.getAttribute("data-theme") === "dark";
  html.setAttribute("data-theme", isDark ? "light" : "dark");
  localStorage.setItem("theme", isDark ? "light" : "dark");
  var icon = document.getElementById("themeIcon");
  icon.innerHTML = isDark
    ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
}
(function(){
  var s = localStorage.getItem("theme");
  if (s) {
    document.documentElement.setAttribute("data-theme", s);
    if (s === "light") {
      var el = document.getElementById("themeIcon");
      if (el) el.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    }
  }
})();

// 熱門股
// renderHots() handles hot stock rendering

// 自動補全
var acTimer = null, acActive = -1, acController = null;
document.getElementById("inp").addEventListener("input", function() {
  var q = this.value.trim();
  clearTimeout(acTimer); acActive = -1;
  // 取消上一次未完成的 fetch（避免 race condition + memory leak）
  if (acController) { try { acController.abort(); } catch(e) {} acController = null; }
  if (!q) { hideAC(); return; }
  acTimer = setTimeout(function() { fetchAC(q); }, 250); // 250ms debounce
});
document.getElementById("inp").addEventListener("keydown", function(e) {
  var items = document.querySelectorAll(".ac-item");
  if (e.key === "ArrowDown") {
    e.preventDefault(); acActive = Math.min(acActive + 1, items.length - 1);
    items.forEach(function(el, i) { el.classList.toggle("active", i === acActive); });
  } else if (e.key === "ArrowUp") {
    e.preventDefault(); acActive = Math.max(acActive - 1, -1);
    items.forEach(function(el, i) { el.classList.toggle("active", i === acActive); });
  } else if (e.key === "Enter") {
    if (acActive >= 0 && items[acActive]) items[acActive].click(); else doSearch();
  } else if (e.key === "Escape") { hideAC(); }
});
document.addEventListener("click", function(e) {
  if (!e.target.closest(".search-wrap")) hideAC();
});
function fetchAC(q) {
  if (typeof AbortController !== 'undefined') {
    acController = new AbortController();
  }
  var opts = acController ? { signal: acController.signal } : {};
  fetch(window.RENDER_URL + "/search?q=" + encodeURIComponent(q), opts)
    .then(function(r) { return r.ok ? r.json() : []; })
    .then(function(list) {
      acController = null;
      if (!list || !list.length) { hideAC(); return; }
      // 確認搜尋框目前值仍匹配（避免 stale result）
      if (document.getElementById("inp").value.trim().toLowerCase() !== q.toLowerCase()) return;
      var acList = document.getElementById("acList");
      acList.innerHTML = "";
      list.forEach(function(s) {
        var el = document.createElement("div"); el.className = "ac-item";
        var _esc = function(v) { return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); };
        el.innerHTML = '<span class="ac-code">' + _esc(s.code) + '</span><span class="ac-name">' + _esc(s.name) + '</span><span class="ac-type">' + _esc(s.type) + '</span>';
        el.onclick = function() { selectAC(s.code, s.name); };
        acList.appendChild(el);
      });
      acList.classList.add("show"); acActive = -1;
    }).catch(function(e) {
      acController = null;
      if (e && e.name === 'AbortError') return; // 正常取消，不是錯誤
      hideAC();
    });
}
function selectAC(code, name) { document.getElementById("inp").value = code; hideAC(); doSearch(code); }
function hideAC() { document.getElementById("acList").classList.remove("show"); acActive = -1; }

// 掃描
var scanMode = "volume", scanOpen = false;
function toggleScan() {
  scanOpen = !scanOpen;
  document.getElementById("scanPanel").classList.toggle("open", scanOpen);
  document.getElementById("scanOpenBtn").classList.toggle("active", scanOpen);
  document.getElementById("scanOpenBtn").textContent = scanOpen ? "關閉掃描" : "熱門掃描";
}
function setMode(m) {
  if (scanMode !== m) { var sr = document.getElementById("scanResult"); if (sr && sr.innerHTML) sr.innerHTML = '<div class="scan-msg">已切換掃描模式，請按「開始掃描」取得此模式的結果。</div>'; }
  scanMode = m;
  document.getElementById("modeVol").classList.toggle("on", m === "volume");
  document.getElementById("modeChg").classList.toggle("on", m === "change");
  var dropBtn = document.getElementById("modeDrop");
  if (dropBtn) dropBtn.classList.toggle("on", m === "drop");
  document.getElementById("modeMom").classList.toggle("on", m === "momentum");
  var sectorBtn = document.getElementById("modeSector");
  if (sectorBtn) sectorBtn.classList.toggle("on", m === "sector");
  var limitupBtn = document.getElementById("modeLimitup");
  if (limitupBtn) limitupBtn.classList.toggle("on", m === "limitup");
  var dispositionBtn = document.getElementById("modeDisposition");
  if (dispositionBtn) dispositionBtn.classList.toggle("on", m === "disposition");
  var uniSel = document.getElementById("scanUniverse");
  if (uniSel) uniSel.style.display = (m === "momentum" || m === "sector") ? "inline-block" : "none";
}
var _scanController = null;
function runScan() {
  var n = Math.max(5, Math.min(parseInt(document.getElementById("scanN").value) || 20, 30));
  var btn = document.getElementById("scanRunBtn");
  if (btn.disabled) return; // 防重複點擊
  // 取消上一次掃描
  if (_scanController) { try { _scanController.abort(); } catch(e) {} }
  _scanController = typeof AbortController !== 'undefined' ? new AbortController() : null;

  btn.disabled = true; btn.textContent = "掃描中...";
  // loading msg set above


  var opts = _scanController ? { signal: _scanController.signal } : {};
  // 60s timeout 保護（Render 免費版冷啟動可能需要 30s）
  var timeoutId = setTimeout(function() {
    if (_scanController) { _scanController.abort(); _scanController = null; }
  }, 60000);

  var uniEl = document.getElementById("scanUniverse");
  var universe = (scanMode === "sector" || scanMode === "limitup") ? "large"
    : (scanMode === "disposition") ? "custom"
    : (scanMode === "momentum" && uniEl) ? uniEl.value : "custom";
  var scanMsg = scanMode === "sector"
    ? "族群熱度掃描中（大型股票池~800檔），約需 30~60 秒..."
    : scanMode === "disposition"
    ? "處置股 / 注意股掃描中（富果即時資料），約需 15~30 秒..."
    : scanMode === "limitup"
    ? "鎖漲停掃描中（篩選漲幅 > 3% 股票），約需 30~60 秒..."
    : scanMode === "momentum" && universe !== "custom"
    ? ("動能掃描中（" + (universe==="large"?"大型股票池~800檔":"全市場~1700檔") + "），約需 30~60 秒...")
    : "正在分析前" + n + "大熱門股，約需 20~40 秒...";
  document.getElementById("scanResult").innerHTML = '<div class="scan-msg">' + scanMsg + '</div>';
  fetch(window.RENDER_URL + "/scan?mode=" + scanMode + "&limit=" + n + "&universe=" + universe, opts)
    .then(function(r) { return r.ok ? r.json() : r.json().then(function(d) { throw new Error(d.error || "HTTP " + r.status); }); })
    .then(function(data) {
      clearTimeout(timeoutId);
      btn.disabled = false; btn.textContent = "開始掃描";
      if (data.error) {
        document.getElementById("scanResult").innerHTML = '<div class="scan-msg" style="color:var(--red)">錯誤：' + esc(data.error) + '</div>';
        return;
      }
      showDemoBanner(data.demo);
      var verTag = data._v ? ' <span style="opacity:.4">(' + esc(data._v) + ')</span>' : '';
      var MODE = {volume:"成交量排行", change:"漲幅排行", drop:"跌幅排行", momentum:"動能排行", sector:"族群熱度", limitup:"鎖漲停", disposition:"處置股"};
      var prefix = '<div class="scan-meta"><b>' + esc(MODE[scanMode] || scanMode) + '</b>'
        + '｜資料日期 ' + esc(data.asOf || "—") + (data.asOfOther && data.asOfOther.length ? '（部分標的為 ' + esc(data.asOfOther.join("、")) + '）' : '')
        + (data.basis ? '｜' + esc(data.basis) : '')
        + (data.cached ? '｜⚡ 快取結果（3 分鐘內有效）' : '') + verTag
        + (data.scoreNote && scanMode !== "sector" ? '<br>' + esc(data.scoreNote) : '') + '</div>';
      if (scanMode === "sector") {
        renderSectorScan(data, prefix);
      } else {
        renderScan(data.stocks, prefix);
      }
    }).catch(function(e) {
      clearTimeout(timeoutId);
      btn.disabled = false; btn.textContent = "開始掃描";
      if (e && e.name === 'AbortError') {
        document.getElementById("scanResult").innerHTML = '<div class="scan-msg" style="color:var(--yellow)">掃描逾時，請稍後重試</div>';
      } else {
        var _em = e.message||"";
        var _msg = (_em.includes("fetch")||_em.includes("Failed")||_em.includes("network"))
          ? "連線異常，請稍後再試" : ("掃描失敗：" + (_em||"請稍後重試"));
        document.getElementById("scanResult").innerHTML = '<div class="scan-msg" style="color:var(--yellow)">' + _msg + '</div>';
      }
    });
}
function toggleSectorRow(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}
function renderSectorScan(data, prefix) {
  var sectors = data.sectors || [];
  var top50   = data.stocks  || [];
  var c = document.getElementById("scanResult");
  if (!sectors.length && !top50.length) { c.innerHTML = '<div class="scan-msg">無資料</div>'; return; }

  var TAG_COLORS = {hot:"#f97316",bull:"#34d399",warn:"#fbbf24",bear:"#f87171"};
  function tagSpan(t) {
    var col = TAG_COLORS[t.cls] || "#6b7280";
    return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:'+col+'22;color:'+col+';border:1px solid '+col+'44;white-space:nowrap">'+esc(t.text)+'</span>';
  }
  function codeLink(code) {
    return '<a href="#" class="scan-deep-link" data-code="'+esc(code)+'" style="color:var(--accent);text-decoration:none;font-weight:600">'+esc(code)+'</a>';
  }

  var aiHtml = data.aiComment
    ? '<div style="background:var(--bg3);border-left:3px solid var(--accent);padding:10px 14px;margin-bottom:12px;font-size:12px;color:var(--text2);border-radius:0 6px 6px 0">📊 '+esc(data.aiComment)+'</div>' : "";

  var sRows = "";
  sectors.forEach(function(s, i) {
    var hColor  = s.sectorHeat>=80?"#ef4444":s.sectorHeat>=60?"#f59e0b":"#6b7280";
    var tagsH   = (s.tags||[]).map(tagSpan).join(" ");
    var avgC    = (s.avgChangePct||0)>=0?"var(--red)":"var(--green)";
    var expandId = "sec-ex-"+i;
    var leadMini = (s.leaders||[]).slice(0,3).map(function(l){
      var mc = l.momentumScore>=80?"#ef4444":l.momentumScore>=60?"#f59e0b":"#6b7280";
      return codeLink(l.code)+' <span style="color:var(--text2);font-size:10px">'+esc(l.name)+'</span> <span style="color:'+mc+';font-family:IBM Plex Mono,monospace;font-size:10px">'+esc(l.momentumScore)+'分</span>';
    }).join(' &nbsp;');
    var leadCards = (s.leaders||[]).map(function(l){
      var mc = l.momentumScore>=80?"#ef4444":l.momentumScore>=60?"#f59e0b":"#6b7280";
      var cc = parseFloat(l.changePct)>=0?"var(--red)":"var(--green)";
      return '<div style="background:var(--bg4);border-radius:6px;padding:8px 12px;min-width:140px">'+
        '<div>'+codeLink(l.code)+' <span style="color:var(--text1)">'+esc(l.name)+'</span></div>'+
        '<div style="margin-top:4px;font-family:IBM Plex Mono,monospace;font-size:11px">'+
          '<span style="color:var(--text2)">'+esc(l.price)+'</span> '+
          '<span style="color:'+cc+'">'+esc(l.changePct)+'</span></div>'+
        '<div style="margin-top:4px"><span style="color:'+mc+';font-size:12px;font-weight:700">動能 '+esc(l.momentumScore)+'</span></div>'+
        '<div style="margin-top:4px">'+(l.momentumTags||[]).map(tagSpan).join(" ")+'</div>'+
        '</div>';
    }).join("");
    sRows +=
      '<tr style="border-bottom:1px solid var(--border);cursor:pointer" onclick="toggleSectorRow(\''+expandId+'\')">'
      +'<td style="padding:7px 8px;color:var(--text1);font-weight:600">'+esc(s.sector)+'</td>'
      +'<td style="padding:7px 8px;text-align:center"><span style="color:'+hColor+';font-family:IBM Plex Mono,monospace;font-weight:700">'+esc(s.sectorHeat)+'</span><span style="color:var(--text3);font-size:9px">/100</span></td>'
      +'<td style="padding:7px 8px;text-align:center;color:'+avgC+';font-family:IBM Plex Mono,monospace">'+((s.avgChangePct>=0)?"+":"")+esc(s.avgChangePct)+'%</td>'
      +'<td style="padding:7px 8px;text-align:center;color:var(--text2)">'+Math.round((s.upRatio||0)*100)+'%</td>'
      +'<td style="padding:7px 8px">'+tagsH+'</td>'
      +'<td style="padding:7px 8px">'+leadMini+'</td>'
      +'</tr>'
      +'<tr id="'+expandId+'" style="display:none;background:var(--bg3)">'
      +'<td colspan="6" style="padding:8px 16px"><div style="display:flex;flex-wrap:wrap;gap:8px">'+leadCards+'</div></td>'
      +'</tr>';
  });

  var sHtml = '<div style="margin-bottom:16px">'
    +'<div style="font-size:11px;color:var(--text3);font-family:IBM Plex Mono,monospace;margin-bottom:8px">📊 族群熱度排行（TOP 10）</div>'
    +'<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">'
    +'<thead><tr style="color:var(--text3);font-size:10px;font-family:IBM Plex Mono,monospace">'
    +'<th style="text-align:left;padding:4px 8px">族群</th>'
    +'<th style="text-align:center;padding:4px 8px">熱度</th>'
    +'<th style="text-align:center;padding:4px 8px">均漲幅</th>'
    +'<th style="text-align:center;padding:4px 8px">上漲比</th>'
    +'<th style="text-align:left;padding:4px 8px">標籤</th>'
    +'<th style="text-align:left;padding:4px 8px">強勢股</th>'
    +'</tr></thead><tbody>'+sRows+'</tbody></table></div></div>';

  var tRows = "";
  top50.forEach(function(s) {
    var mc  = s.momentumScore>=80?"#ef4444":s.momentumScore>=60?"#f59e0b":"#6b7280";
    var cc  = parseFloat(s.changePct)>=0?"var(--red)":"var(--green)";
    var th  = (s.momentumTags||[]).map(tagSpan).join(" ");
    tRows += '<tr style="border-bottom:1px solid var(--border)">'
      +'<td style="padding:6px 8px">'+codeLink(s.code)+'</td>'
      +'<td style="padding:6px 8px;color:var(--text1)">'+esc(s.name)+'</td>'
      +'<td style="padding:6px 8px;text-align:right;font-family:IBM Plex Mono,monospace;color:var(--text1)">'+esc(s.price)+'</td>'
      +'<td style="padding:6px 8px;text-align:right;font-family:IBM Plex Mono,monospace;color:'+cc+'">'+esc(s.changePct)+'</td>'
      +'<td style="padding:6px 8px;text-align:center;color:'+mc+';font-family:IBM Plex Mono,monospace;font-weight:700">'+esc(s.momentumScore)+'</td>'
      +'<td style="padding:6px 8px;color:var(--text3);font-size:11px">'+esc(s.sector)+'</td>'
      +'<td style="padding:6px 8px">'+th+'</td>'
      +'</tr>';
  });

  var tHtml = '<div>'
    +'<div style="font-size:11px;color:var(--text3);font-family:IBM Plex Mono,monospace;margin-bottom:8px">🏆 動能前 '+top50.length+' 強股</div>'
    +'<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">'
    +'<thead><tr style="color:var(--text3);font-size:10px;font-family:IBM Plex Mono,monospace">'
    +'<th style="text-align:left;padding:4px 8px">代號</th>'
    +'<th style="text-align:left;padding:4px 8px">名稱</th>'
    +'<th style="text-align:right;padding:4px 8px">股價</th>'
    +'<th style="text-align:right;padding:4px 8px">漲跌</th>'
    +'<th style="text-align:center;padding:4px 8px">動能</th>'
    +'<th style="text-align:left;padding:4px 8px">族群</th>'
    +'<th style="text-align:left;padding:4px 8px">標籤</th>'
    +'</tr></thead><tbody>'+tRows+'</tbody></table></div></div>';

  c.innerHTML = (prefix || "") + aiHtml + sHtml + tHtml;
}

function renderScan(stocks, prefix) {
  var isLimitup      = (typeof scanMode !== 'undefined' && scanMode === 'limitup');
  var isDisposition  = (typeof scanMode !== 'undefined' && scanMode === 'disposition');
  if (!stocks || !stocks.length) { document.getElementById("scanResult").innerHTML = (prefix || "") + '<div class="scan-msg">' + (isLimitup ? '目前沒有漲幅超過 3% 的股票' : isDisposition ? '目前沒有處置股／注意股資料' : '無資料') + '</div>'; return; }

  // 處置股警語
  var warning = isDisposition
    ? '<div style="background:rgba(249,115,22,.12);border:1px solid rgba(249,115,22,.5);border-radius:6px;padding:8px 14px;margin-bottom:10px;font-size:11px;color:#f97316;font-family:IBM Plex Mono,monospace">⚠️ 處置股波動大、流動性差，僅供觀察，不代表買進建議。此模式的分數只反映處置期間的相對強弱。</div>'
    : "";

  // 分級圖例
  var legend = '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;font-family:IBM Plex Mono,monospace">'
    + '<span>分級：</span>'
    + '<span style="color:#ef4444">80-100 強勢觀察🔥</span>'
    + '<span style="color:#f59e0b">65-79 可試單👀</span>'
    + '<span style="color:#6b7280">50-64 等待整理⏳</span>'
    + '<span style="color:#374151">0-49 不建議❌</span>'
    + '</div>';

  var wrap = document.createElement("div"); wrap.style.overflowX = "auto";
  wrap.innerHTML = (prefix || "") + warning + legend;
  var table = document.createElement("table"); table.className = "scan-table";
  table.innerHTML = '<thead><tr>'
    + '<th>代號</th><th>名稱</th><th>股價</th><th>漲跌</th>'
    + '<th title="成交量（張）">成交量</th>'
    + '<th title="綜合評分（100分滿分）">評分</th>'
    + '<th title="分級">' + (isLimitup ? '族群' : isDisposition ? '狀態' : '等級') + '</th>'
    + '<th>建議</th>'
    + '<th title="基本面(20)+技術面(25)+量價(15)+籌碼(20)+融資(10)+題材(10)" style="font-size:9px">基/技/量<br>碼/資/材</th>'
    + '<th></th>'
    + '</tr></thead>';
  var tbody = document.createElement("tbody");

  stocks.forEach(function(s) {
    var tr = document.createElement("tr"); tr.style.cursor = "pointer";
    var chgPct = parseFloat(s.changePct) || 0;
    var chgCls = chgPct > 0 ? "up" : chgPct < 0 ? "dn" : "neu";
    var isMomentum = (typeof scanMode !== 'undefined' && scanMode === 'momentum');

    var sc = isDisposition ? (s.dispositionScore || 0) : isLimitup ? (s.limitUpScore || 0) : isMomentum ? (s.momentumScore || 0) : (s.score || 0);
    var scoreColor = (isLimitup || isMomentum)
      ? (sc >= 80 ? "#ef4444" : sc >= 60 ? "#f59e0b" : sc >= 40 ? "#6b7280" : "#374151")
      : (sc >= 80 ? "#ef4444" : sc >= 65 ? "#f59e0b" : sc >= 50 ? "#6b7280" : "#374151");

    // 分數環形進度（簡易版）
    var scoreBar = '<div style="display:flex;align-items:center;gap:4px">'
      + '<div style="width:32px;height:32px;border-radius:50%;border:3px solid ' + scoreColor + ';display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:' + scoreColor + ';font-family:IBM Plex Mono,monospace">'
      + esc(sc) + '</div>'
      + (isLimitup && s.distanceToLimitUp !== undefined ? '<div style="font-size:9px;color:var(--text3);font-family:IBM Plex Mono,monospace;text-align:center">距' + esc(s.distanceToLimitUp) + '%</div>' : '')
      + '</div>';

    // 各面向分條
    // Limitup / Momentum tags
    var momentumTagsHtml = "";
    if (isLimitup && s.tags && s.tags.length) {
      momentumTagsHtml = s.tags.map(function(t) {
        var colors = {bull:"#34d399",hot:"#f97316",warn:"#fbbf24",bear:"#f87171",neutral:"#6b7280"};
        return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:' +
          (colors[t.cls]||"#6b7280") + '22;color:' + (colors[t.cls]||"#6b7280") +
          ';border:1px solid ' + (colors[t.cls]||"#6b7280") + '44">' + esc(t.text) + '</span>';
      }).join(" ");
    } else if (isDisposition && s.tags && s.tags.length) {
      momentumTagsHtml = s.tags.map(function(t) {
        var colors = {bull:"#34d399",hot:"#f97316",warn:"#fbbf24",bear:"#f87171",neutral:"#6b7280"};
        return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:' +
          (colors[t.cls]||"#6b7280") + '22;color:' + (colors[t.cls]||"#6b7280") +
          ';border:1px solid ' + (colors[t.cls]||"#6b7280") + '44">' + esc(t.text) + '</span>';
      }).join(" ");
    } else if (isMomentum && s.momentumTags && s.momentumTags.length) {
      momentumTagsHtml = s.momentumTags.map(function(t) {
        var colors = {bull:"#34d399",hot:"#f97316",warn:"#fbbf24",bear:"#f87171",neutral:"#6b7280"};
        return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:' +
          (colors[t.cls]||"#6b7280") + '22;color:' + (colors[t.cls]||"#6b7280") +
          ';border:1px solid ' + (colors[t.cls]||"#6b7280") + '44">' + esc(t.text) + '</span>';
      }).join(" ");
    }
    if (isMomentum && sc >= 80) {
      momentumTagsHtml = '<span style="font-size:10px;font-weight:700;color:#ef4444">🔥 強勢動能</span> ' + momentumTagsHtml;
    }

    var detailBar = '<div style="font-family:IBM Plex Mono,monospace;font-size:9px;line-height:1.8;white-space:nowrap">'
      + '<span style="color:#60a5fa">' + esc(s.fundScore||0) + '</span>/'
      + '<span style="color:#34d399">' + esc(s.techScore||0) + '</span>/'
      + '<span style="color:#a78bfa">' + esc(s.volScore||0) + '</span>/<br>'
      + '<span style="color:#fb923c">' + esc(s.chipScore||0) + '</span>/'
      + '<span style="color:#f87171">' + esc(s.marginScore||0) + '</span>/'
      + '<span style="color:#fbbf24">' + esc(s.themeScore||0) + '</span>'
      + '</div>';

    tr.innerHTML = '<td class="scan-code">' + esc(s.code) + '</td>'
      + '<td>' + esc(s.name) + '</td>'
      + '<td class="' + chgCls + '" style="font-family:IBM Plex Mono,monospace">' + esc(s.price) + '</td>'
      + '<td class="' + chgCls + '" style="font-family:IBM Plex Mono,monospace">' + esc(s.changePct||"—") + '</td>'
      + '<td style="font-family:IBM Plex Mono,monospace;color:var(--text2);font-size:11px">' + (s.volume ? s.volume.toLocaleString() : "—") + '</td>'
      + '<td>' + scoreBar + '</td>'
      + '<td style="font-size:10px;font-weight:600">' + (isDisposition ? '<span style="font-size:10px;font-weight:700;color:' + (s.dispositionType==='處置股'?'#f97316':s.dispositionType==='注意股'?'#fbbf24':'#6b7280') + '">' + esc(s.dispositionType||"—") + '</span>' : isLimitup ? '<span style="color:var(--text3);font-size:10px">' + esc(s.sector||"—") + '</span>' : '<span style="color:' + scoreColor + '">' + esc(s.grade||"—") + '</span>') + '</td>'
      + '<td class="scan-suggest">' + ((isMomentum || isLimitup || isDisposition) && momentumTagsHtml ? momentumTagsHtml + (s.suggestion ? '<div style="font-size:10px;color:var(--text2);margin-top:2px">' + esc(s.suggestion) + '</div>' : '') : esc(s.suggestion||"觀察中")) + '</td>'
      + '<td>' + detailBar + '</td>'
      + '<td><button class="btn-deep">深入分析</button></td>';

    // 點擊展開詳細評分
    tr.onclick = function() { deepAnalyze(s.code); };
    tr.querySelector(".btn-deep").onclick = function(e) { e.stopPropagation(); deepAnalyze(s.code); };



    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  document.getElementById("scanResult").innerHTML = "";
  document.getElementById("scanResult").appendChild(wrap);
}
function deepAnalyze(code) { document.getElementById("inp").value = code; if (scanOpen) toggleScan(); doSearch(code); window.scrollTo({top:0,behavior:"smooth"}); }

// 分析
document.getElementById("sbtn").onclick = function() { doSearch(); };
// onkeydown handled by addEventListener above
var _analyzeController = null;
function doSearch(code) {
  var c = (code || document.getElementById("inp").value).trim().replace(/\s/g, "");
  if (!c) return;
  // 取消上一次分析請求
  if (_analyzeController) { try { _analyzeController.abort(); } catch(e) {} }
  _analyzeController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var analyzeOpts = {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({code: c}),
  };
  if (_analyzeController) analyzeOpts.signal = _analyzeController.signal;

  // 按下分析後，取消還在排隊的自動補全（否則報告出來後下拉選單才跳出來，還多打一次 API）
  clearTimeout(acTimer); if (acController) { try { acController.abort(); } catch(e) {} acController = null; } hideAC();
  document.getElementById("welcome").style.display = "none";
  document.getElementById("errbox").style.display = "none";
  document.getElementById("result").innerHTML = "";
  document.getElementById("loader").classList.add("show");
  document.getElementById("sbtn").disabled = true; document.getElementById("sbtn").textContent = "分析中...";
  document.getElementById("pdfBar").style.display = "none";
  setStep(1);
  document.querySelectorAll(".hot-chip").forEach(function(b) { b.classList.toggle("on", b.textContent === c); });

  if (window._stepT2) clearTimeout(window._stepT2);
  if (window._stepT3) clearTimeout(window._stepT3);
  window._stepT2 = setTimeout(function() { setStep(2); }, 8000);
  window._stepT3 = setTimeout(function() { setStep(3); }, 20000);

  function resetBtn() {
    clearTimeout(window._stepT2); clearTimeout(window._stepT3);
    document.getElementById("sbtn").disabled = false;
    document.getElementById("sbtn").textContent = "分析";
    document.getElementById("loader").classList.remove("show");
    _analyzeController = null;
  }

  // Step 1: 快速拿資料（quote + hist + 評分，< 5s）
  fetch(window.RENDER_URL + "/analyze", analyzeOpts)
    .then(function(r) {
      if (!r.ok) return r.text().then(function(t) { throw new Error(t || "API 錯誤 " + r.status); });
      return r.json();
    })
    .then(function(data) {
      if (data.error) throw new Error(data.error);

      showDemoBanner(data.demo);
      // 立刻顯示完整報告（評分卡＋報價＋規則式分析）
      renderReport(c, data.text || null, data.scored, data);
      document.getElementById("pdfBar").style.display = "block";
      if (!data.aiReady) { resetBtn(); return; }

      // 再非同步取得 AI 深度報告，成功才取代；失敗就保留規則式版本
      document.getElementById("sbtn").textContent = "AI 分析中...";
      setAiStatus("AI 深度分析產生中，完成後會自動更新下方內容…");
      var aiOpts = { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code: data.code || c}) };
      if (_analyzeController) aiOpts.signal = _analyzeController.signal;
      fetch(window.RENDER_URL + "/analyze-ai", aiOpts)
        .then(function(r) { return r.json(); })
        .then(function(aiData) {
          resetBtn();
          if (aiData && aiData.text) {
            var keep = currentTab;
            renderReport(c, aiData.text, data.scored, data, true);
            switchTab(keep);
          } else {
            setAiStatus((aiData && (aiData.reason || aiData.error)) || "AI 報告未產生，目前顯示規則式分析");
          }
        })
        .catch(function(e) {
          resetBtn();
          if (e && e.name === "AbortError") return;
          setAiStatus("AI 報告連線失敗，目前顯示規則式分析");
        });
    })
    .catch(function(e) {
      if (e && e.name === "AbortError") return;
      resetBtn();
      var eb = document.getElementById("errbox");
      var msg = e.message || "";
      eb.textContent = (msg.includes("fetch") || msg.includes("network") || msg.includes("Failed"))
        ? "連線異常，請稍後再試" : (parseErr(msg) || "發生錯誤，請重試");
      eb.style.color = "";
      eb.style.display = "block";
    });
}
function parseErr(msg) { try { var j = JSON.parse(msg); return j.error || msg; } catch(e) { return msg; } }
function setAiStatus(t) { var el = document.getElementById("aiStatus"); if (el) { el.textContent = t || ""; el.style.display = t ? "block" : "none"; } }
function setStep(n) {
  ["st1","st2","st3"].forEach(function(id, i) {
    var el = document.getElementById(id);
    el.className = "loader-step " + (i+1 < n ? "done" : i+1 === n ? "active" : "");
  });
}

// 段落解析（純字串搜尋，無 regex 問題）
function parseSection(text, tag) {
  if (!text) return "";
  // 支援多種格式：=== tag、=== tag ===、## tag
  var patterns = [
    "=== " + tag + "\n",
    "===" + tag + "\n",
    "=== " + tag + " ===",
    "## " + tag,
    "##" + tag,
  ];
  var idx = -1, markerLen = 0;
  for (var pi = 0; pi < patterns.length; pi++) {
    var fi = text.indexOf(patterns[pi]);
    if (fi >= 0) { idx = fi; markerLen = patterns[pi].length; break; }
  }
  if (idx < 0) return "";
  var nlIdx = text.indexOf("\n", idx + markerLen - 1);
  if (nlIdx < 0) return "";
  var rest = text.slice(nlIdx + 1);
  var candidates = [rest.indexOf("\n=== "), rest.indexOf("\n==="), rest.indexOf("\n## ")].filter(function(n){ return n >= 0; });
  var next = candidates.length ? Math.min.apply(null, candidates) : -1;
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

// 富文字渲染
function sectionCard(title, text) {
  if (!text) return '';
  return '<div class="card"><div class="card-title">' + title + '</div><div class="ai-text">' + richHTML(text) + '</div></div>';
}
function richHTML(text) {
  if (!text) return '';
  var lines = text.split("\n");
  var out = [], inTable = false, isFirst = false;
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var line = raw.trim();
    if (/^={3,}\s*$/.test(line) || /^-{3,}\s*$/.test(line)) continue;
    if (line.startsWith("|") && line.endsWith("|")) {
      if (/^[|\-\s:]+$/.test(line)) { isFirst = false; continue; }
      if (!inTable) {
        while (out.length && out[out.length-1] === "") out.pop();
        out.push('<table class="data-table">');
        inTable = true; isFirst = true;
      }
      var cells = line.split("|").slice(1, -1);
      var t2 = isFirst ? "th" : "td";
      out[out.length-1] += ("<tr>" + cells.map(function(c) { return "<" + t2 + ">" + c.trim().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</" + t2 + ">"; }).join("") + "</tr>");
      isFirst = false;
    } else {
      if (inTable) { out[out.length-1] += "</table>"; inTable = false; }
      var escaped = raw.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      escaped = escaped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      escaped = escaped.replace(/【(.*?)】/g, "<strong>【$1】</strong>");
      out.push(escaped);
    }
  }
  if (inTable) out[out.length-1] += "</table>";
  var html = out.join("<br>");
  html = html.replace(/(<br>){3,}/g, "<br><br>");
  html = html.replace(/<br>(<table)/g, "$1");
  html = html.replace(/(<\/table>)<br>/g, "$1");
  return html;
}

// Tab 切換
var currentTab = 0;
function switchTab(idx) {
  currentTab = idx;
  document.querySelectorAll(".tab-btn").forEach(function(b, i) { b.classList.toggle("on", i === idx); });
  ["tp0","tp1","tp2","tp3","tp4","tp5","tp6"].forEach(function(id, i) {
    var el = document.getElementById(id); if (el) el.classList.toggle("on", i === idx);
  });
}

// PDF
function downloadPDF() {
  var code = document.getElementById("inp").value || "";
  var d = new Date();
  var dateStr = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
  document.querySelectorAll(".tab-pane").forEach(function(p) { p.style.display = "flex"; });
  var tabNames = ["行情總覽","技術分析","短中長線","籌碼分析","基本面","風險分析","操作策略"];
  document.querySelectorAll(".tab-pane").forEach(function(p, i) {
    if (!p.querySelector(".pdf-tab-title") && tabNames[i]) {
      var title = document.createElement("div"); title.className = "pdf-tab-title";
      title.style.cssText = "font-size:13px;font-weight:bold;color:#2563eb;border-bottom:2px solid #2563eb;padding-bottom:5px;margin-bottom:12px;font-family:IBM Plex Mono,monospace";
      title.textContent = tabNames[i]; p.insertBefore(title, p.firstChild);
    }
  });
  var origTitle = document.title; document.title = code + "_台股分析報告_" + dateStr;
  window.print();
  setTimeout(function() {
    document.title = origTitle;
    document.querySelectorAll(".pdf-tab-title").forEach(function(el) { el.remove(); });
    switchTab(0);
  }, 1000);
}

// 短／中／長線各自的判斷（點開可看支持與相反的證據）
function horizonHTML(hs) {
  if (!hs || !hs.length) return "";
  var CLS = {"偏多":"hz-bull", "偏空":"hz-bear", "中性":"hz-neut", "資料不足":"hz-na"};
  return '<div class="hz-row">' + hs.map(function(h) {
    return '<details class="hz ' + (CLS[h.view] || "hz-na") + '"><summary><span class="hz-name">' + esc(h.name) + '<small>' + esc(h.span) + '</small></span><span class="hz-view">' + esc(h.view) + '</span></summary>'
      + '<div class="hz-body"><div><b>支持</b>' + (h.pros.length ? h.pros.map(function(x) { return '<span>' + esc(x) + '</span>'; }).join("") : '<span class="hz-none">無</span>') + '</div>'
      + '<div><b>相反</b>' + (h.cons.length ? h.cons.map(function(x) { return '<span>' + esc(x) + '</span>'; }).join("") : '<span class="hz-none">無</span>') + '</div></div></details>';
  }).join("") + '</div>';
}
// 關鍵數字列：最常被查的數字固定放在最上面，每格都帶單位或基準日
function kpiHTML(d) {
  var fu = d.fundamentals || {}, ind = d.indicators || {}, r = (d.quant && d.quant.risk) || {}, hold = d.holding || {}, chip = d.chip || [];
  function num(v, dg) { return (v === null || v === undefined || !isFinite(v)) ? "—" : Number(v).toLocaleString("en-US", {maximumFractionDigits: dg === undefined ? 2 : dg}); }
  function sg(v, dg, unit) { return (v === null || v === undefined || !isFinite(v)) ? "—" : (v > 0 ? "+" : "") + num(v, dg) + (unit || ""); }
  var c5 = chip.length ? chip.slice(-5).reduce(function(s, x) { return s + x.total; }, 0) : null;
  var items = [
    ["本益比", num(fu.pe, 1) + (fu.pe ? " 倍" : ""), fu.own && fu.own.pePct !== null ? "自身五年第 " + fu.own.pePct + " 百分位" : ""],
    ["近四季 EPS", num(fu.epsTTM) + (fu.epsTTM ? " 元" : ""), fu.epsTTMYoY !== null && fu.epsTTMYoY !== undefined ? "年增 " + sg(fu.epsTTMYoY, 1, "%") : ""],
    ["月營收年增", sg(fu.revYoY, 1, "%"), d.asOf && d.asOf.revenue ? d.asOf.revenue : ""],
    ["ROE", fu.roe !== null && fu.roe !== undefined ? num(fu.roe, 1) + "%" : "—", d.asOf && d.asOf.financials ? "截至 " + d.asOf.financials : ""],
    ["法人近 5 日", c5 === null ? "—" : sg(c5, 0, " 張"), d.asOf && d.asOf.chip ? "至 " + d.asOf.chip : ""],
    ["外資持股", hold.ratio ? num(hold.ratio, 2) + "%" : "—", hold.ratio && isFinite(hold.ratio20) ? "20 日 " + sg(hold.ratio - hold.ratio20, 2, " 個百分點") : ""],
    ["日均波幅 ATR", r.atrPct ? num(r.atrPct, 2) + "%" : "—", r.atr14 ? "約 " + num(r.atr14) + " 元" : ""],
    ["Beta", num(r.beta), r.vol60 ? "年化波動 " + num(r.vol60, 1) + "%" : ""],
    (function() { var pz = ind.pos250 !== undefined ? ind.pos250 : ind.pos240, lo = ind.lo250 !== undefined ? ind.lo250 : ind.lo240, hi = ind.hi250 !== undefined ? ind.hi250 : ind.hi240;
      return ["52 週位置", pz !== null && pz !== undefined ? num(pz, 0) + "%" : "—", lo ? num(lo) + " ~ " + num(hi) : ""]; })()
  ];
  return '<div class="kpi-row">' + items.map(function(k) { return '<div class="kpi"><div class="kpi-l">' + k[0] + '</div><div class="kpi-v">' + esc(k[1]) + '</div><div class="kpi-s">' + esc(k[2]) + '</div></div>'; }).join("") + '</div>';
}
var GLOSSARY_HTML = '<details class="card glossary"><summary>名詞解釋（點開）</summary><dl>'
  + [["ATR（平均真實波幅）","近 14 日平均每天的高低震盪幅度（含跳空）。用來衡量「正常一天會動多少」，停損設在 1 倍 ATR 以內很容易被正常波動掃到。"],
     ["Beta","個股相對大盤的敏感度。1.5 代表大盤漲跌 1% 時，這檔股票平均動 1.5%。以近一年日報酬計算。"],
     ["年化波動率","日報酬標準差換算成一年的幅度。30% 大約代表一年內有三分之二的機率漲跌在 ±30% 以內。"],
     ["VaR 95%","依過去一年的實際日報酬，有 95% 的交易日跌幅不會超過這個數字；另外 5% 的日子會更糟。"],
     ["最大回撤","期間內從最高點跌到最低點的最大幅度，代表「最壞時買在高點會虧多少」。"],
     ["夏普比率","每承擔一單位波動換到多少報酬，越高越好；本站以無風險利率 0 計算。"],
     ["百分位","把一群數字由小排到大後所在的位置。第 80 百分位＝比 80% 的對象高。"],
     ["含息／不含息","不含息只看股價變化；含息把領到的現金股利加回去，才是持有人實際的報酬。"],
     ["還原權息","除息、配股或分割當天股價會被動下調，還原是把歷史價格等比例調整，避免把除息誤判成下跌。"],
     ["趨勢模板","以 50／150／200 日均線的排列與股價相對一年高低點的位置，檢查是否處於上升趨勢的八項條件。"],
     ["四階段","打底→上升→做頭→下降。以 150 日均線的方向和股價在均線上或下來判定。"],
     ["海龜通道","突破 N 日最高價進場、跌破 N 日最低價出場的順勢規則；N 值為 20 日 ATR。"],
     ["獨立樣本","持有期間互不重疊的訊號次數。連續幾天重複觸發只算一次。"],
     ["證據強度","訊號後的平均報酬與「任意一天買進」相比是否有統計上的差異。樣本不足或無法區分時，不應把該訊號當成依據。"],
     ["券資比","融券餘額 ÷ 融資餘額。偏高時若股價上漲，放空者回補可能推升股價（軋空）。"],
     ["PEG","本益比 ÷ EPS 年增率，用來衡量成長是否已反映在股價上。"]]
    .map(function(g) { return '<dt>' + g[0] + '</dt><dd>' + g[1] + '</dd>'; }).join("") + '</dl></details>';

// 渲染報告
function renderReport(code, text, scored, data, isAI) {
  data = data || {}; var q = data.quote || null;
  currentTab = 0;

  // ── 評分卡 ─────────────────────────────────────────────
  var scoreCard = "";
  if (scored) {
    var sc = scored.score || 0;
    var gr = scored.grade || "—";
    var grColor = /^#[0-9a-fA-F]{3,8}$/.test(scored.gradeColor || "") ? scored.gradeColor : "#6b7280";
    var d = scored.detail || {};
    var bars = [
      { label:"基本面", val: d._fund  || 0, max: 20, color:"#60a5fa" },
      { label:"技術面", val: d._tech  || 0, max: 25, color:"#34d399" },
      { label:"量價",   val: d._vol   || 0, max: 15, color:"#a78bfa" },
      { label:"籌碼",   val: d._chip  || 0, max: 20, color:"#fb923c" },
      { label:"融資",   val: d._margin|| 0, max: 10, color:"#f87171" },
      { label:"題材",   val: d._theme || 0, max: 10, color:"#fbbf24" },
    ];
    var barsHtml = bars.map(function(b) {
      var pct = b.max > 0 ? Math.round(b.val / b.max * 100) : 0;
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">'
        + '<div style="width:36px;font-size:10px;color:var(--text3);text-align:right;flex-shrink:0">' + b.label + '</div>'
        + '<div style="flex:1;background:var(--bg4);border-radius:3px;height:8px;overflow:hidden">'
        + '<div style="width:' + pct + '%;height:100%;background:' + b.color + ';border-radius:3px;transition:width .4s"></div>'
        + '</div>'
        + '<div style="width:32px;font-size:10px;font-family:IBM Plex Mono,monospace;color:' + b.color + '">' + esc(b.val) + '/' + b.max + '</div>'
        + '</div>';
    }).join("");

    // 評分細項 tooltip 內容
    var detailItems = [
      { key:"rev_yoy",      label:"月營收年增率" },
      { key:"eps_growth",   label:"EPS年增／本益比" },
      { key:"roe",          label:"ROE" },
      { key:"margin_stable",label:"毛利率趨勢" },
      { key:"above_ma20",   label:"站上MA20" },
      { key:"ma20_up",      label:"MA20向上" },
      { key:"ma60_up",      label:"MA60向上" },
      { key:"ma_bull",      label:"多頭排列" },
      { key:"breakout",     label:"突破前高" },
      { key:"up_vol",       label:"上漲放量" },
      { key:"down_vol",     label:"回檔量縮" },
      { key:"vol_above_avg",label:"量>均量" },
      { key:"foreign_buy",  label:"外資連買" },
      { key:"site_buy",     label:"投信連買" },
      { key:"inst_total",   label:"法人合計" },
      { key:"big_player",   label:"外資持股變化" },
      { key:"margin_health",label:"融資健康" },
      { key:"margin_decrease",label:"融資去槓桿"},
      { key:"theme_main",   label:"題材強勢" },
      { key:"theme_support",label:"題材支撐" },
    ];
    var detailRows = detailItems.map(function(item) {
      var val = (scored.naKeys || []).indexOf(item.key) >= 0 ? "不適用" : String(d[item.key] || "—");
      var plus = val.startsWith("+");
      return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--border);font-size:11px">'
        + '<span style="color:var(--text2)">' + item.label + '</span>'
        + '<span style="font-family:IBM Plex Mono,monospace;color:' + (plus ? "#34d399" : "var(--text3)") + '">' + esc(val) + '</span>'
        + '</div>';
    }).join("");

    var naNote = (scored.naKeys && scored.naKeys.length) ? '<div class="note" style="text-align:left;margin-top:6px">ETF 不適用基本面、融資與題材項目：這些項目不計分，也不從 100 分的分母扣除；不同類型標的的分數不宜直接比較。</div>' : "";
    scoreCard = '<div style="background:var(--bg3);border:1px solid ' + grColor + ';border-radius:8px;padding:14px 16px;margin-bottom:16px">'
      // 標題列
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
      + '<span style="font-family:IBM Plex Mono,monospace;font-size:10px;color:var(--text3);letter-spacing:.08em">綜合評分'
      + (scored.applicable ? '　<span style="letter-spacing:0">適用滿分 ' + esc(scored.applicable) + '｜資料覆蓋 ' + esc(scored.known) + ' / ' + esc(scored.applicable) + '</span>' : '') + '</span>'
      + '<span style="font-size:11px;font-weight:600;color:' + grColor + '">' + esc(gr) + '</span>'
      + '</div>'
      // 大分數 + 進度條
      + '<div style="display:flex;gap:16px;align-items:center;margin-bottom:12px">'
      + '<div style="width:64px;height:64px;border-radius:50%;border:4px solid ' + grColor + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">'
      + '<span style="font-family:IBM Plex Mono,monospace;font-size:22px;font-weight:700;color:' + grColor + '">' + esc(sc) + '</span>'
      + '</div>'
      + '<div style="flex:1">' + barsHtml + '</div>'
      + '</div>'
      // 細項展開（預設折疊）
      + '<details style="margin-top:4px">'
      + '<summary style="cursor:pointer;font-size:10px;color:var(--text3);font-family:IBM Plex Mono,monospace;letter-spacing:.06em;outline:none">▶ 細項評分明細</summary>'
      + '<div style="margin-top:8px;padding:8px;background:var(--bg4);border-radius:4px">' + detailRows + '</div>'
      + '</details>' + naNote
      + '</div>';
  }

  text = text || "";
  var base = (data && data.text) || "";   // 規則式完整報告；AI 版本沒有的段落由它補上
  function S(name, alt) { return parseSection(text, name) || (alt ? parseSection(text, alt) : "") || parseSection(base, name); }
  var verdict = S("最終裁定");
  var isBull = data.stance ? data.stance === "偏多" : (verdict.indexOf("偏多") >= 0 || verdict.indexOf("看多") >= 0);
  var isBear = data.stance ? data.stance === "偏空" : (verdict.indexOf("偏空") >= 0 || verdict.indexOf("看空") >= 0);
  var vCls = isBull ? "bull" : isBear ? "bear" : "neut";
  var dirText = isBull ? "整體偏多" : isBear ? "整體偏空" : "中性震盪";
  var dirCls = isBull ? "up" : isBear ? "dn" : "neu";
  var barPct = isBull ? "72%" : isBear ? "28%" : "50%";
  var barType = isBull ? "bull" : isBear ? "bear" : "neutral";
  var stockName = code;
  var nm = (S("行情總覽") || "").match(/名稱[：:]\s*([^\s、，（(\n]{2,12})/);
  if (nm && nm[1] && nm[1] !== code) stockName = nm[1];
  var price = "—", chgText = dirText, chgCls = dirCls, metaText = new Date().toLocaleDateString("zh-TW");
  if (q && q.price) {
    if (q.name) stockName = q.name;
    price = Number(q.price).toLocaleString("en-US", {maximumFractionDigits: 2});
    var cp = Number(q.changePct) || 0, ch = Number(q.change) || 0;
    chgCls = cp > 0 ? "up" : cp < 0 ? "dn" : "neu";   // 台股慣例：紅漲綠跌
    chgText = (ch > 0 ? "▲ +" : ch < 0 ? "▼ " : "") + ch.toLocaleString("en-US", {maximumFractionDigits: 2}) + "（" + (cp > 0 ? "+" : "") + cp.toFixed(2) + "%）";
    metaText = [q.market, q.industry, (q.time || q.date || ""), q.realtime ? "盤中即時" : "收盤"].filter(Boolean).join(" · ");
  }
  if (data.code) code = data.code;

  // 標籤：優先用後端的結構化結果；舊版後端才退回掃描文字
  var tags = "";
  if (data.tags && data.tags.length) {
    var TAGCLS = {bull:"tag-bull", bear:"tag-bear", neutral:"tag-neutral", warn:"tag-warn", hot:"tag-hot"};
    tags = data.tags.map(function(t) { return '<span class="tag ' + (TAGCLS[t.cls] || "tag-neutral") + '">' + esc(t.text) + '</span>'; }).join("");
  } else {
    tags += '<span class="tag ' + (isBull ? "tag-bull" : isBear ? "tag-bear" : "tag-neutral") + '">' + dirText + '</span>';
    [["多頭排列","tag-bull"],["空頭排列","tag-bear"],["黃金交叉","tag-bull"],["死亡交叉","tag-bear"],["爆量","tag-hot"]].forEach(function(k) {
      if (text.indexOf(k[0]) >= 0) tags += '<span class="tag ' + k[1] + '">' + k[0] + '</span>';
    });
  }
  var links = [
    ["Yahoo 股市","https://tw.stock.yahoo.com/quote/"+encodeURIComponent(code)+".TW"],
    ["Goodinfo","https://goodinfo.tw/StockInfo/StockDetail.asp?STOCK_ID="+encodeURIComponent(code)],
    ["鉅亨網","https://www.cnyes.com/twstock/"+encodeURIComponent(code)],
    ["CMoney","https://www.cmoney.tw/finance/"+encodeURIComponent(code)],
    ["公開觀測站","https://mops.twse.com.tw"],
    ["TradingView","https://www.tradingview.com/chart/?symbol=TWSE:"+encodeURIComponent(code)]
  ].map(function(l) { return '<a class="link-btn" href="' + l[1] + '" target="_blank" rel="noopener">' + l[0] + '</a>'; }).join("");
  var chipLinks = [
    ["三大法人","https://www.twse.com.tw/fund/TWT38U?response=html&stockNo="+encodeURIComponent(code)],
    ["融資融券","https://www.twse.com.tw/exchangeReport/MI_MARGN?response=html&stockNo="+encodeURIComponent(code)],
    ["主力分點","https://goodinfo.tw/StockInfo/StockBrokerTradeSum.asp?STOCK_ID="+encodeURIComponent(code)]
  ].map(function(l) { return '<a class="link-btn" href="' + l[1] + '" target="_blank" rel="noopener">' + l[0] + '</a>'; }).join("");

  function card(title, body) { return body ? '<div class="card"><div class="card-title">' + title + '</div><div class="ai-text">' + richHTML(body) + '</div></div>' : ""; }
  function linkCard(title, inner) { return '<div class="card"><div class="card-title">' + title + '</div><div class="links">' + inner + '</div></div>'; }
  // 新聞：有結構化資料時做成可點的連結（只接受 http/https）
  var newsCard = "";
  if (data.news && data.news.length) {
    newsCard = '<div class="card"><div class="card-title">近期新聞</div><div class="ai-text">' + data.news.map(function(n) {
      var href = /^https?:\/\//.test(n.link || "") ? esc(n.link) : "";
      return '<div class="news-item"><span class="news-date">' + esc(n.date) + '</span>' + (href ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + esc(n.title) + '</a>' : esc(n.title)) + (n.source ? ' <span class="news-src">' + esc(n.source) + '</span>' : '') + '</div>';
    }).join("") + '<div class="note" style="text-align:left">系統只列出標題、不判讀內容；重大訊息請以公開資訊觀測站為準。</div></div></div>';
  } else newsCard = card("近期新聞", S("近期新聞"));

  var cov = data.coverage || null, covPct = cov ? Math.round(cov.got / cov.total * 100) : Math.min(100, Math.round((text || base).length / 120));
  var PANES = [
    card("行情總覽", S("行情總覽")) + card("多週期績效（相對大盤）", S("多週期績效")) + card("支撐壓力", S("支撐壓力")) + card("位階分析", S("位階分析")) + linkCard("即時查詢", links),
    card("技術分析", S("技術分析")) + card("趨勢結構檢核", S("趨勢結構檢核")) + card("長線趨勢分析", S("長線趨勢分析")) + card("市場風格判定", S("市場風格判定")) + card("歷史訊號統計（量化回算）", S("歷史訊號統計")),
    card("短線分析（1~5日）", S("短線分析")) + card("中線分析（1~8週）", S("中線分析")) + card("長線分析（3~12個月）", S("長線分析")),
    card("籌碼分析", S("籌碼分析")) + card("籌碼屬性分析", S("籌碼屬性分析")) + card("法人分析", S("法人分析")) + card("外資持股", S("外資持股")) + card("融資融券分析", S("融資融券分析")) + linkCard("官方資料", chipLinks),
    card("基本面分析（月營收）", S("基本面分析")) + card("獲利能力（季財報）", S("獲利能力")) + card("估值分析", S("估值分析")) + card("股利政策", S("股利政策")) + card("產業分析", S("產業分析")) + newsCard,
    card("風險分析", S("風險分析")) + card("量化風險指標", S("量化風險指標")) + card("部位規模試算", S("部位規模試算")),
    card("操作策略（情境推演）", S("操作策略")) + card("交易員檢核表", S("交易員檢核表")) + card("量化因子", S("量化因子"))
      + '<div class="ai-block"><div class="ai-header"><div class="ai-dot"></div><span class="ai-title-txt">綜合分析 — ' + esc(code) + ' ' + esc(stockName) + '</span></div><div class="ai-text">' + richHTML(S("AI綜合分析", "綜合分析")) + '</div></div>'
      + '<div class="verdict ' + vCls + '"><div class="verdict-title">最終裁定</div><div class="ai-text">' + richHTML(verdict) + '</div></div>'
      + '<div class="note">' + (data.demo ? '⚠ 目前為示範資料模式，數字並非真實行情。' : '本報告由 TWSE／TPEx + FinMind 資料生成') + '，僅供參考，不構成投資建議。評分與裁定規則未經完整回測驗證。股市有風險，投資需自負。</div>'
  ];

  var html = scoreCard + '<div class="hero fade-up">'
    + '<div class="hero-top">'
    + '<div><div class="hero-code">' + esc(code) + '</div><div class="hero-name">' + esc(stockName) + '</div><div class="hero-meta">' + esc(metaText) + '</div></div>'
    + '<div><div class="hero-price ' + chgCls + '">' + esc(price) + '</div><div class="hero-chg ' + chgCls + '">' + esc(chgText) + '</div></div>'
    + '</div>'
    + '<div class="score-bars">'
    + (data.stanceDetail && data.stanceDetail.total
      ? '<div class="score-bar"><div class="bar-label">多空類別計數（不是機率）</div><div class="bar-track" style="display:flex">'
        + '<div class="bar-fill bull" style="width:' + (data.stanceDetail.bull / data.stanceDetail.total * 100) + '%"></div><div class="bar-fill neutral" style="width:' + (data.stanceDetail.neutral / data.stanceDetail.total * 100) + '%;opacity:.35"></div><div class="bar-fill bear" style="width:' + (data.stanceDetail.bear / data.stanceDetail.total * 100) + '%"></div></div>'
        + '<div class="bar-vals"><span style="color:var(--green)">偏多 ' + data.stanceDetail.bull + ' 類</span><span>' + dirText + (data.stanceDetail.conflict ? '（分歧）' : '') + '</span><span style="color:var(--red)">偏空 ' + data.stanceDetail.bear + ' 類</span></div></div>'
      : '<div class="score-bar"><div class="bar-label">多空判斷</div><div class="bar-track"><div class="bar-fill ' + barType + '" style="width:' + barPct + '"></div></div><div class="bar-vals"><span style="color:var(--red)">偏空</span><span>' + dirText + '</span><span style="color:var(--green)">偏多</span></div></div>')
    + '<div class="score-bar"><div class="bar-label">資料完整度</div><div class="bar-track"><div class="bar-fill neutral" style="width:' + covPct + '%"></div></div><div class="bar-vals"><span></span><span>' + (cov ? cov.got + ' / ' + cov.total + ' 個資料源' : '') + '</span><span></span></div></div>'
    + '</div>'
    + horizonHTML(data.horizons)
    + kpiHTML(data)
    + '<div class="tags">' + tags + '<span class="tag tag-neutral">' + (isAI ? "AI 解讀＋量化分析" : "規則式量化分析") + '</span></div>'
    + (data.missing && data.missing.length ? '<div class="note" style="text-align:left;color:var(--yellow);margin-top:8px">⚠ 部分資料暫時無法取得（' + esc(data.missing.join("、")) + '），對應段落與評分項目未計入。</div>' : "")
    + '<div class="note" id="aiStatus" style="display:none;text-align:left;color:var(--accent2);margin-top:8px"></div>'
    + '</div>'
    + '<div class="tabs-wrap fade-up">'
    + TABS.map(function(l,i) { return '<button class="tab-btn ' + (i===0?"on":"") + '" onclick="switchTab(' + i + ')">' + l + '</button>'; }).join("")
    + '</div>'
    + PANES.map(function(p, i) { return '<div class="tab-pane' + (i === 0 ? ' on fade-up' : '') + '" id="tp' + i + '">' + p + '</div>'; }).join("")
    + GLOSSARY_HTML;

  document.getElementById("result").innerHTML = html;
}
