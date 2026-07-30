import { CAT, RANK, PREF, esc, catOf, groupRows, rowLine, groupCard, gridHtml, noticeHtml } from './groups.mjs';

// The classification/grouping/card/notice logic lives in ./groups.mjs (pure —
// unit-testable in node without a DOM). Here those exact function sources and
// JSON-serialized tables are interpolated into the served <script>, so the
// tested code and the shipped code can never drift. Tables are emitted with
// identifier keys unquoted — byte-stable with the pre-extraction bundle (the
// served-source contract tests pin those literals).
const ident = (k) => /^[A-Za-z_$][\w$]*$/.test(k);
const objLiteral = (o) => `{${Object.entries(o).map(([k, v]) => `${ident(k) ? k : JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`;
const CAT_JS = objLiteral(CAT);
const RANK_JS = objLiteral(RANK);
const PREF_JS = JSON.stringify(PREF);

export const JS = `
(function(){
  "use strict";
  var root=document.documentElement;
  var LS="ak-dash-theme", LS_TAB="ak-dash-tab";

  // Dashboard-wide session token (ADR-0014). Bootstrap is idempotent and
  // duplicated from live-view.mjs's copy (separate <script> scope, no shared
  // state) — see that file's comment for why re-running it here is safe.
  var DASH_TOKEN_KEY="ak-dash-token";
  var DASH_TOKEN=(function(){
    var m=String(location.hash||"").match(/token=([A-Za-z0-9_-]+)/);
    if(m){try{localStorage.setItem(DASH_TOKEN_KEY,m[1]);}catch(e){}try{history.replaceState(null,"",location.pathname+location.search);}catch(e){}}
    try{return localStorage.getItem(DASH_TOKEN_KEY)||"";}catch(e){return"";}
  })();
  function authHeaders(){return{"x-dash-token":DASH_TOKEN};}
  function showGate(msg){
    document.body.classList.add("gated");
    var g=document.getElementById("dash-gate"); if(g)g.hidden=false;
    var e=document.getElementById("gate-err"); if(e)e.textContent=msg||"";
  }
  function hideGate(){
    document.body.classList.remove("gated");
    var g=document.getElementById("dash-gate"); if(g)g.hidden=true;
  }
  (function wireGate(){
    var go=document.getElementById("gate-go");
    var input=document.getElementById("gate-token");
    if(go)go.addEventListener("click",function(){
      var v=input?input.value.trim():"";
      if(!v)return;
      try{localStorage.setItem(DASH_TOKEN_KEY,v);}catch(e){}
      location.reload();
    });
    if(input)input.addEventListener("keydown",function(e){if(e.key==="Enter"&&go)go.click();});
  })();
  if(!DASH_TOKEN)showGate("");

  // theme: stored choice wins; otherwise follow the OS.
  function sysTheme(){return window.matchMedia&&window.matchMedia("(prefers-color-scheme:light)").matches?"light":"dark";}
  var MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z"/></svg>';
  var SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  function applyTheme(t){
    root.setAttribute("data-theme",t);
    var ic=document.getElementById("theme-icon"); if(ic)ic.innerHTML=(t==="dark"?MOON:SUN);
    var btn=document.getElementById("theme-toggle"); if(btn)btn.setAttribute("aria-label",t==="dark"?"switch to light theme":"switch to dark theme");
  }
  var stored=null; try{stored=localStorage.getItem(LS);}catch(e){}
  applyTheme(stored||sysTheme());
  var tbtn=document.getElementById("theme-toggle");
  if(tbtn)tbtn.addEventListener("click",function(){
    var next=root.getAttribute("data-theme")==="dark"?"light":"dark";
    applyTheme(next); try{localStorage.setItem(LS,next);}catch(e){}
    render(LAST); // re-tint the sparklines to the new palette
  });

  var LEVEL_WORD={ok:"all systems nominal",warn:"attention advised",fail:"action required",unknown:"status unknown"};
  var LAST=null, lastUpdated=0;

  ${esc.toString()}

  // ── tabs (segmented control) ──
  // Category map (from ./groups.mjs — see that file): every subsystem lands in
  // exactly one tab; unknown/future subsystems fall back to Runtime.
  var TABS=["overview","hosts","providers","runtime","intel","usage","live"];
  var VIEWS=["score","limits","findings","sessions","transcript"];
  var CAT=${CAT_JS};
  ${catOf.toString()}

  var activeTab="overview";
  var usageView="score", usageSession=null, usageDays=14;
  try{var st=localStorage.getItem(LS_TAB); if(st&&TABS.indexOf(st)>=0)activeTab=st;}catch(e){}
  // deep-link: #providers etc. wins over the stored tab. Usage carries a second
  // segment: #usage/findings, #usage/sessions, or #usage/<sessionId> — anything
  // that is not a known view name is read as a session id.
  try{
    var parts=location.hash.slice(1).split("/");
    if(parts[0]&&TABS.indexOf(parts[0])>=0)activeTab=parts[0];
    if(parts[0]==="usage"&&parts[1]){
      if(VIEWS.indexOf(parts[1])>=0){usageView=parts[1];}
      else{usageView="transcript"; usageSession=decodeURIComponent(parts[1]);}
    }
  }catch(e){}

  function usageHash(){
    if(usageView==="transcript")return "#usage/"+(usageSession?encodeURIComponent(usageSession):"transcript");
    return usageView==="score"?"#usage":"#usage/"+usageView;
  }
  function syncHash(){
    try{if(history.replaceState)history.replaceState(null,"",activeTab==="usage"?usageHash():"#"+activeTab);}catch(e){}
  }

  function positionThumb(){
    var segEl=document.getElementById("seg"), thumb=document.getElementById("seg-thumb");
    if(!segEl||!thumb)return;
    var btn=segEl.querySelector('[data-tab="'+activeTab+'"]');
    if(!btn)return;
    thumb.style.left=btn.offsetLeft+"px";
    thumb.style.width=btn.offsetWidth+"px";
  }
  function setTab(id,focus){
    if(activeTab==="live"&&id!=="live"&&window.AKLive)window.AKLive.deactivate();
    activeTab=id;
    try{localStorage.setItem(LS_TAB,id);}catch(e){}
    syncHash();
    // Usage is LAZY (ADR-0009 §2): the index is only read once the tab is
    // actually opened, never on the shared status poll.
    if(id==="usage"&&!usageLoaded)loadUsage();
    if(id==="live"&&window.AKLive)window.AKLive.activate();
    for(var i=0;i<TABS.length;i++){
      var t=TABS[i], on=(t===id);
      var btn=document.querySelector('[data-tab="'+t+'"]');
      var panel=document.getElementById("panel-"+t);
      if(btn){btn.setAttribute("aria-selected",on?"true":"false"); btn.tabIndex=on?0:-1; if(on&&focus)btn.focus();}
      if(panel)panel.hidden=!on;
    }
    positionThumb();
  }
  var seg=document.getElementById("seg");
  if(seg){
    seg.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-tab]"):null;
      if(b)setTab(b.getAttribute("data-tab"));
    });
    seg.addEventListener("keydown",function(e){
      if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;
      var i=TABS.indexOf(activeTab);
      i=(i+(e.key==="ArrowRight"?1:TABS.length-1))%TABS.length;
      setTab(TABS[i],true); e.preventDefault();
    });
  }
  window.addEventListener("resize",positionThumb);
  var mapEl=document.getElementById("statusmap");
  if(mapEl)mapEl.addEventListener("click",function(e){
    var t=e.target.closest?e.target.closest("[data-go]"):null;
    if(t)setTab(t.getAttribute("data-go"));
  });

  // severity rank for rollups + triage sort; preferred order breaks ties
  // (tables + functions from ./groups.mjs).
  var RANK=${RANK_JS};
  var PREF=${PREF_JS};

  ${groupRows.toString()}

  ${rowLine.toString()}

  ${groupCard.toString()}

  ${gridHtml.toString()}
  function stagger(el){
    var cards=el.querySelectorAll(".card");
    for(var i=0;i<cards.length;i++){cards[i].style.animationDelay=(i*40)+"ms";}
  }

  function renderSummary(groups){
    var el=document.getElementById("summary");
    var f=0,w=0,g=0;
    for(var i=0;i<groups.length;i++){var L=groups[i].level;if(L==="fail")f++;else if(L==="warn")w++;else g++;}
    if(!groups.length){el.hidden=true;el.innerHTML="";return;}
    var pills=[];
    if(f)pills.push('<span class="pill" data-level="fail"><span class="dot" data-level="fail"></span><b>'+f+"</b> failing</span>");
    if(w)pills.push('<span class="pill" data-level="warn"><span class="dot" data-level="warn"></span><b>'+w+"</b> warning"+(w>1?"s":"")+"</span>");
    pills.push('<span class="pill" data-tone="calm"><span class="dot" data-level="ok"></span><b>'+g+"</b> nominal</span>");
    el.innerHTML=pills.join("");
    el.hidden=false;
  }

  function renderBadges(cats){
    for(var c in cats){
      var el=document.getElementById("badge-"+c);
      if(!el)continue;
      var f=0,w=0;
      for(var i=0;i<cats[c].length;i++){
        var L=cats[c][i].level;
        if(L==="fail")f++; else if(L==="warn")w++;
      }
      var n=f+w;
      if(!n){el.hidden=true;el.textContent="";el.removeAttribute("data-tone");}
      else{el.hidden=false;el.textContent=String(n);el.setAttribute("data-tone",f?"fail":"warn");}
    }
  }

  function tile(g){
    return '<button class="tile" type="button" data-go="'+esc(catOf(g.subsystem))+'" title="open in its tab">'
      +'<span class="dot" data-level="'+esc(g.level)+'"></span>'
      +esc(g.subsystem)
      +'<span class="tile-go">&rsaquo;</span>'
    +"</button>";
  }

  function renderPanels(rows){
    var groups=groupRows(rows||[]);
    renderSummary(groups);

    // Overview: every attention card, in full, regardless of category.
    var attn=groups.filter(function(x){return x.level==="fail"||x.level==="warn";});
    var ael=document.getElementById("attention");
    if(!groups.length){
      ael.innerHTML='<div class="empty">no subsystem rows reported.</div>';
    }else if(attn.length){
      ael.innerHTML=gridHtml(attn); stagger(ael);
    }else{
      ael.innerHTML='<div class="allclear"><span class="dot" data-level="ok"></span>All systems nominal — nothing needs attention.</div>';
    }

    // Overview: compact status map of every subsystem; tiles jump to the tab.
    var mh=document.getElementById("map-head");
    document.getElementById("statusmap").innerHTML=groups.map(tile).join("");
    mh.hidden=!groups.length;

    // Category panels.
    var cats={hosts:[],providers:[],runtime:[],intel:[]};
    for(var i=0;i<groups.length;i++)cats[catOf(groups[i].subsystem)].push(groups[i]);
    for(var c in cats){
      var el=document.getElementById("cards-"+c);
      if(!el)continue;
      if(cats[c].length){el.innerHTML=gridHtml(cats[c]); stagger(el);}
      else{el.innerHTML='<div class="empty">nothing reported here.</div>';}
    }
    renderBadges(cats);
  }

  function renderVerdict(overall){
    var dot=document.getElementById("verdict-dot");
    var txt=document.getElementById("verdict-text");
    dot.setAttribute("data-level",overall||"unknown");
    dot.className="dot";
    txt.textContent=LEVEL_WORD[overall]||LEVEL_WORD.unknown;
  }

  // Update drift renders as a quiet notice line in Overview — no banner. The
  // versions cards still carry the per-tool detail. (noticeHtml: ./groups.mjs.)
  ${noticeHtml.toString()}
  function renderNotice(drift){
    var b=document.getElementById("update-notice");
    var html=noticeHtml(drift);
    if(!html){b.hidden=true;b.innerHTML="";return;}
    b.innerHTML=html;
    b.hidden=false;
  }

  // ── sparkline (pure SVG) ──
  function accent(){return getComputedStyle(root).getPropertyValue("--accent").trim()||"#0a84ff";}
  function sparkline(values){
    var W=100,H=32,pad=3;
    if(!values.length)return "";
    var min=Math.min.apply(null,values),max=Math.max.apply(null,values);
    var span=max-min||1;
    var n=values.length;
    var x=function(i){return pad+(n===1?0:(i/(n-1))*(W-2*pad));};
    var y=function(v){return H-pad-((v-min)/span)*(H-2*pad);};
    var d="",area="";
    for(var i=0;i<n;i++){d+=(i?" L":"M")+x(i).toFixed(1)+" "+y(values[i]).toFixed(1);}
    area="M"+x(0).toFixed(1)+" "+(H-pad)+" L"+x(0).toFixed(1)+" "+y(values[0]).toFixed(1)
        +d.replace(/^M[^L]*/,"")+" L"+x(n-1).toFixed(1)+" "+(H-pad)+" Z";
    var col=accent(),lastX=x(n-1).toFixed(1),lastY=y(values[n-1]).toFixed(1);
    var gid="g"+Math.random().toString(36).slice(2,8);
    return '<svg viewBox="0 0 '+W+" "+H+'" preserveAspectRatio="none" role="img">'
      +'<defs><linearGradient id="'+gid+'" x1="0" x2="0" y1="0" y2="1">'
        +'<stop offset="0" stop-color="'+col+'" stop-opacity="0.28"/>'
        +'<stop offset="1" stop-color="'+col+'" stop-opacity="0"/>'
      +"</linearGradient></defs>"
      +'<path d="'+area+'" fill="url(#'+gid+')"/>'
      +'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      +'<circle cx="'+lastX+'" cy="'+lastY+'" r="1.9" fill="'+col+'"/>'
    +"</svg>";
  }
  function flat(msg){return '<div class="empty" style="padding:14px 0">'+esc(msg)+"</div>";}

  function renderHistory(data){
    var strip=document.getElementById("history");
    var note=document.getElementById("strip-note");
    var series=[];
    if(data.health&&data.health.length){series=data.health;}
    var pats=[],deltas=[];
    for(var i=0;i<series.length;i++){
      var s=series[i];
      if(typeof s.patternsLearned==="number")pats.push(s.patternsLearned);
      var dp=(typeof s.deltaPP==="number")?s.deltaPP:(s.improvement&&typeof s.improvement.deltaPP==="number"?s.improvement.deltaPP:null);
      if(dp!=null)deltas.push(dp);
    }
    // fall back to a single improvement snapshot for the Δpp spark
    if(!deltas.length&&data.improvement&&typeof data.improvement.deltaPP==="number"){deltas=[data.improvement.deltaPP];}

    if(!pats.length&&!deltas.length){strip.hidden=true;return;}
    strip.hidden=false;
    note.textContent=(series.length?series.length+" samples":"snapshot");
    document.getElementById("spark-patterns").innerHTML=pats.length>1?sparkline(pats):flat(pats.length?String(pats[0])+" (one sample)":"no data");
    document.getElementById("spark-delta").innerHTML=deltas.length>1?sparkline(deltas):flat(deltas.length?(deltas[0]>=0?"+":"")+deltas[0]+"pp (one sample)":"no data");
  }

  function renderRouting(rt){
    var strip=document.getElementById("routing");
    if(!rt||!rt.routes||!rt.routes.length){strip.hidden=true;return;}
    strip.hidden=false;
    var s=rt.summary||{}, byHost=s.byHost||{}, primary=rt.primaryHost||"claude";
    document.getElementById("routing-note").textContent=
      "primary: "+primary+" · "+(byHost.claude||0)+" claude · "+(byHost.codex||0)+" codex · "+(s.custom||0)+" custom · "+(s.vendors||0)+" vendors";
    var html="";
    for(var i=0;i<rt.routes.length;i++){
      var r=rt.routes[i];
      var tag=r.akOriginated?' <span class="r-tag">ak</span>':'';
      var escHtml=(r.escalate&&r.escalate.length)?'<span class="r-esc mono">↑ '+esc(r.escalate.join("→"))+"</span>":"";
      var primAttr=(r.host===primary)?' data-primary="1"':'';
      html+='<div class="r-row">'
        +'<span class="r-act mono">'+esc(r.activity)+tag+"</span>"
        +'<span class="r-host r-host-'+esc(r.host)+'"'+primAttr+' title="'+(r.host===primary?"primary host":"alternate host")+'">'+esc(r.host)+"</span>"
        +'<span class="r-model mono">'+esc(r.model)+"</span>"
        +'<span class="r-meta">'+escHtml+'<span class="r-src r-src-'+esc(r.source)+'">'+esc(r.source)+"</span></span>"
      +"</div>";
    }
    document.getElementById("route-matrix").innerHTML=html;
  }

  // Hosts & Routing tab: the distinct host+model pairs the routing policy puts
  // in play, with how many activities each covers. Hidden without a dual policy.
  function renderModels(rt){
    var strip=document.getElementById("models");
    if(!rt||!rt.routes||!rt.routes.length){strip.hidden=true;return;}
    var seen={},list=[];
    for(var i=0;i<rt.routes.length;i++){
      var r=rt.routes[i];
      if(!r.model)continue;
      var k=r.host+"|"+r.model;
      if(!seen[k]){seen[k]={host:r.host,model:r.model,n:0};list.push(seen[k]);}
      seen[k].n++;
    }
    if(!list.length){strip.hidden=true;return;}
    strip.hidden=false;
    document.getElementById("models-note").textContent="primary: "+(rt.primaryHost||"claude");
    var html="";
    for(var j=0;j<list.length;j++){
      var m=list[j];
      html+='<div class="m-row">'
        +'<span class="r-host r-host-'+esc(m.host)+'">'+esc(m.host)+"</span>"
        +'<span class="m-model mono">'+esc(m.model)+"</span>"
        +'<span class="m-n">'+m.n+" activit"+(m.n>1?"ies":"y")+"</span>"
      +"</div>";
    }
    document.getElementById("model-list").innerHTML=html;
  }

  function render(data){
    if(!data)return;
    LAST=data;
    renderVerdict(data.overall);
    renderNotice(data.drift);
    renderPanels(data.rows);
    renderHistory(data);
    renderRouting(data.routing);
    renderModels(data.routing);
    positionThumb(); // badges can change segment widths
  }

  function ago(sec){
    if(sec<2)return "just now";
    if(sec<60)return sec+"s ago";
    var m=Math.floor(sec/60); if(m<60)return m+"m ago";
    var h=Math.floor(m/60); return h+"h ago";
  }
  function tickClock(){
    var el=document.getElementById("updated");
    if(el){
      if(!lastUpdated){el.textContent="—";}
      else{el.textContent=(pollOn?"updated ":"paused · ")+ago(Math.round((Date.now()-lastUpdated)/1000));}
    }
    // Manual refresh is live except while a fetch is in the air or inside the
    // cooldown — the button's own disabled state IS the visible cooldown.
    var btn=document.getElementById("poll-now");
    if(btn)btn.disabled=inflight||(Date.now()-lastAttempt)<POLL_COOLDOWN_MS;
  }

  // ══ poll control ═══════════════════════════════════════════════════════════
  // Governs EVERY tab, not just Usage (ADR-0009 §7). The old hardcoded 5 s poll
  // predated any expensive view; 30 s is the default now, and the whole range is
  // user-chosen and persisted. Every refresh path — automatic or manual — funnels
  // through refreshAll(), so the single-flight guard and the cooldown are
  // impossible to route around.
  var LS_POLL="ak-dash-poll";
  var POLL_DEFAULT_MS=30000;
  var POLL_COOLDOWN_MS=3000;
  var POLL_LABEL={15000:"15s",30000:"30s",60000:"1m",300000:"5m",900000:"15m",
    1800000:"30m",3600000:"1h",21600000:"6h",43200000:"12h",86400000:"24h"};
  var pollOn=true, pollMs=POLL_DEFAULT_MS, pollTimer=null, inflight=false, lastAttempt=0;

  try{
    var savedPoll=JSON.parse(localStorage.getItem(LS_POLL)||"null");
    if(savedPoll&&typeof savedPoll==="object"){
      if(typeof savedPoll.on==="boolean")pollOn=savedPoll.on;
      if(POLL_LABEL[savedPoll.intervalMs])pollMs=savedPoll.intervalMs;
    }
  }catch(e){}

  function savePoll(){
    try{localStorage.setItem(LS_POLL,JSON.stringify({on:pollOn,intervalMs:pollMs}));}catch(e){}
  }

  function pollStatus(){
    return fetch("/api/status",{cache:"no-store",headers:authHeaders()}).then(function(r){
      if(r.status===401){try{localStorage.removeItem(DASH_TOKEN_KEY);}catch(e){}showGate("Wrong or missing dashboard token.");throw Error("unauthorized");}
      return r.json();
    }).then(function(d){
      hideGate();
      lastUpdated=Date.now(); render(d); tickClock();
    }).catch(function(){
      var t=document.getElementById("verdict-text"); if(t)t.textContent="server unreachable";
    });
  }

  function refreshAll(){
    // single-flight: a refresh already in the air is joined, never duplicated.
    if(inflight)return;
    // cooldown: a double-click (or a held Enter) cannot stack requests.
    if(Date.now()-lastAttempt<POLL_COOLDOWN_MS)return;
    inflight=true; lastAttempt=Date.now();
    var btn=document.getElementById("poll-now");
    if(btn)btn.classList.add("spin");
    var jobs=[pollStatus()];
    if(activeTab==="usage")jobs.push(loadUsage(true));
    Promise.all(jobs).catch(function(){}).then(function(){
      inflight=false;
      if(btn)btn.classList.remove("spin");
      tickClock();
    });
  }

  function schedulePoll(){
    if(pollTimer){clearInterval(pollTimer); pollTimer=null;}
    if(pollOn)pollTimer=setInterval(refreshAll,pollMs);
    var pulse=document.getElementById("pulse");
    if(pulse)pulse.classList.toggle("off",!pollOn);
    var play=document.getElementById("poll-play");
    if(play){
      play.classList.toggle("on",pollOn);
      play.innerHTML=pollOn?"&#9208;":"&#9654;";
      play.title=pollOn?"polling on — click to pause":"polling paused — click to resume";
      play.setAttribute("aria-label",pollOn?"pause polling":"resume polling");
    }
    var ivl=document.getElementById("poll-ivl");
    if(ivl){
      ivl.innerHTML=POLL_LABEL[pollMs]+' <span class="caret" aria-hidden="true">&#9662;</span>';
      ivl.style.opacity=pollOn?1:.55;
    }
    var menu=document.getElementById("poll-menu");
    if(menu){
      var opts=menu.querySelectorAll("[data-ms]");
      for(var i=0;i<opts.length;i++){
        var on=(Number(opts[i].getAttribute("data-ms"))===pollMs);
        opts[i].classList.toggle("sel",on);
        opts[i].innerHTML=POLL_LABEL[opts[i].getAttribute("data-ms")]+(on?" <span>&#10003;</span>":"");
      }
    }
    tickClock();
  }

  function wirePoll(){
    var play=document.getElementById("poll-play");
    var ivl=document.getElementById("poll-ivl");
    var now=document.getElementById("poll-now");
    var menu=document.getElementById("poll-menu");
    if(play)play.addEventListener("click",function(){pollOn=!pollOn; savePoll(); schedulePoll();});
    // Manual refresh survives the pause — that is the whole point of the off
    // state: stale on purpose, refreshable on demand.
    if(now)now.addEventListener("click",refreshAll);
    if(ivl&&menu)ivl.addEventListener("click",function(e){
      e.stopPropagation();
      menu.hidden=!menu.hidden;
      ivl.setAttribute("aria-expanded",menu.hidden?"false":"true");
    });
    document.addEventListener("click",function(){
      if(menu&&!menu.hidden){menu.hidden=true; if(ivl)ivl.setAttribute("aria-expanded","false");}
    });
    if(menu)menu.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-ms]"):null;
      if(!b)return;
      pollMs=Number(b.getAttribute("data-ms"))||POLL_DEFAULT_MS;
      if(!pollOn)pollOn=true;          // picking an interval implies resume
      savePoll(); schedulePoll();
      menu.hidden=true; if(ivl)ivl.setAttribute("aria-expanded","false");
    });
  }

  // ══ Usage tab ══════════════════════════════════════════════════════════════
  var USAGE=null, usageLoaded=false, usageBusy=false, TRANSCRIPT=null;

  function fmtUsd(n){
    n=Number(n)||0;
    if(n>=1000)return "$"+Math.round(n).toLocaleString();
    if(n>=10)return "$"+n.toFixed(0);
    return "$"+n.toFixed(2);
  }
  function fmtNum(n){return (Number(n)||0).toLocaleString();}
  function fmtTok(n){
    n=Number(n)||0;
    if(n>=1e9)return (n/1e9).toFixed(1)+"B";
    if(n>=1e6)return (n/1e6).toFixed(1)+"M";
    if(n>=1e3)return (n/1e3).toFixed(1)+"K";
    return String(Math.round(n));
  }
  function fmtHours(sec){var h=(Number(sec)||0)/3600; return (h>=10?Math.round(h):h.toFixed(1))+"h";}
  function fmtMins(m){m=Number(m)||0; return m>=60?Math.round(m/60)+"h":Math.round(m)+"m";}
  function fld(v,k){
    if(v==null)return 0;
    if(typeof v==="number")return k==="cost"?v:0;
    return Number(v[k])||0;
  }
  function pct(a,b){return b?(a/b*100):0;}
  function entries(map,key){
    var out=[];
    for(var k in (map||{}))out.push({name:k,v:map[k],cost:fld(map[k],key||"cost")});
    out.sort(function(a,b){return b.cost-a.cost;});
    return out;
  }

  function loadUsage(force){
    if(usageBusy)return Promise.resolve();
    usageBusy=true;
    var jobs=[fetch("/api/usage?days="+usageDays,{cache:"no-store",headers:authHeaders()}).then(function(r){return r.json();})
      .then(function(d){USAGE=d; usageLoaded=true;})];
    if(usageView==="transcript"&&usageSession&&(force||!TRANSCRIPT||TRANSCRIPT.id!==usageSession))
      jobs.push(loadTranscript(usageSession));
    return Promise.all(jobs).catch(function(){
      USAGE={error:"usage index unavailable"};
    }).then(function(){usageBusy=false; renderUsage();});
  }

  function loadTranscript(id){
    return fetch("/api/session/"+encodeURIComponent(id),{cache:"no-store",headers:authHeaders()})
      .then(function(r){return r.json();})
      .then(function(d){TRANSCRIPT=d&&!d.error?{id:id,meta:d.meta,turns:d.turns||[]}:{id:id,error:(d&&d.error)||"unreadable"};});
  }

  function setUsageView(v,session){
    usageView=v;
    if(session!==undefined)usageSession=session;
    var btns=document.querySelectorAll("#usage-seg [data-view]");
    for(var i=0;i<btns.length;i++)btns[i].setAttribute("aria-selected",btns[i].getAttribute("data-view")===v?"true":"false");
    for(var j=0;j<VIEWS.length;j++){
      var el=document.getElementById("v-"+VIEWS[j]);
      if(el)el.hidden=(VIEWS[j]!==v);
    }
    syncHash();
    if(v==="transcript"&&usageSession&&(!TRANSCRIPT||TRANSCRIPT.id!==usageSession)){
      loadTranscript(usageSession).then(renderTranscript);
    }
    // Limits is LAZY like the tab itself: the Codex side may spawn one vendor
    // subprocess server-side, so it runs when the view is opened, not on poll.
    if(v==="limits"&&!LIMITS)loadLimits();
  }

  // Explicit bridge from metadata-only Live Sessions to the separately fetched,
  // server-masked historical transcript. Returning false lets a caller keep its
  // current selection when an untrusted/malformed identifier is supplied.
  window.AKDashboardOpenTranscript=function(id){
    id=String(id==null?"":id);
    if(!/^[A-Za-z0-9._-]{1,128}$/.test(id)||id==="."||id==="..")return false;
    setTab("usage");
    setUsageView("transcript",id);
    return true;
  };

  // titleTxt is optional and goes on the OUTER .kpi, so the whole card is the
  // hover target — a tooltip anchored to the number alone would be a 40px
  // target for a 200px card. Omitted entirely when not passed, so no card
  // gains an empty title="".
  function kpi(k,v,d,cls,titleTxt){
    return '<div class="kpi '+cls+'"'+(titleTxt?' title="'+esc(titleTxt)+'"':"")
      +'><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div>'
      +'<div class="d">'+d+"</div></div>";
  }
  function bar(label,valueTxt,subTxt,share,alt,extra){
    return '<div class="mrow"'+(extra||"")+'><span class="mname'+(alt?"":" mono")+'">'+label+"</span>"
      +'<span class="mbar"><i class="'+(alt?"alt":"")+'" style="width:'+share.toFixed(1)+'%"></i></span>'
      +'<span class="mval mono">'+esc(valueTxt)+"</span>"
      +'<span class="msub mono">'+esc(subTxt)+"</span></div>";
  }

  // ADR-0009 §4 — all three time tiers, as the asserted ordering
  // engaged <= open <= summed. The visible KPI still leads with the honest
  // figure; this is the SUPPORTING EVIDENCE for it, which is why it lives in a
  // tooltip and not in the hero row. Hover is a weak channel (undiscoverable by
  // accident, absent on touch) and the ADR records that trade-off: a reader who
  // never hovers is less informed, not misled. Every figure comes from totals —
  // nothing here is computed a second way.
  function ladder(t){
    return "engaged "+fmtHours(t.engagedSeconds)
      +" ≤ open "+fmtHours(t.spanUnionSeconds)
      +" ≤ summed "+fmtHours((Number(t.spanMinutes)||0)*60)+"\\n"
      +"engaged unions active sub-intervals split at 15-min silences; "
      +"open unions whole session spans; summed double-counts overlap.";
  }

  function renderScore(d){
    var t=d.totals||{};
    var cacheShare=pct(t.cacheRead,t.tokens);
    document.getElementById("u-hero").innerHTML=
      kpi("sessions",fmtNum(t.sessions),esc(fmtNum(t.responses))+" assistant turns","")
      +kpi("api-equivalent",fmtUsd(t.cost),"list price &middot; not plan billing","accent")
      +kpi("tokens",fmtTok(t.tokens),esc(fmtTok(t.output))+" out &middot; "+esc(fmtTok(t.cacheRead))+" cached","")
      +kpi("engaged time",fmtHours(t.engagedSeconds),
        esc(fmtMins(t.spanMinutes))+" summed"
        +'<span class="d-note">sessions overlap</span>',"",ladder(t))
      +kpi("cache read",cacheShare.toFixed(1)+"%","priced at 0.1&times; input","warnv");
    document.getElementById("u-asof").textContent=d.pricesAsOf?("rates as of "+d.pricesAsOf):"";

    // cost per day
    var days=[],k;
    for(k in (d.byDay||{}))days.push({day:k,v:d.byDay[k]});
    days.sort(function(a,b){return a.day<b.day?-1:1;});
    var maxDay=0;
    for(var i=0;i<days.length;i++)maxDay=Math.max(maxDay,fld(days[i].v,"cost"));
    document.getElementById("u-days-note").textContent="api-equivalent · "+usageDays+"-day window";
    document.getElementById("u-daybars").innerHTML=days.length?days.map(function(x){
      var c=fld(x.v,"cost"), h=maxDay?Math.max(2,c/maxDay*100):2;
      var tip=x.day+" · "+fmtUsd(c)+" · "+fmtTok(fld(x.v,"tokens"))+" tok · "+fmtNum(fld(x.v,"sessions"))+" sessions";
      return '<div class="daybar" title="'+esc(tip)+'"><div class="db-fill" style="height:'+h.toFixed(1)+'%"></div>'
        +'<span class="db-lab">'+esc(x.day.slice(8))+"</span></div>";
    }).join(""):'<div class="empty">no days in window.</div>';

    // Host and inference-provider are independent axes. Fall back to the
    // historical byProvider host map only for pre-migration cached payloads.
    var prov=d.byHost||d.byTranscriptProvider||d.byProvider||{};
    var order=["claude","codex"];
    for(k in prov)if(order.indexOf(k)<0)order.push(k);
    document.getElementById("u-hosts").innerHTML=order.map(function(name){
      var v=prov[name], cost=fld(v,"cost"), sess=fld(v,"sessions"), tok=fld(v,"tokens");
      var idle=!sess&&!cost;
      return '<div class="pcard'+(idle?" idle":"")+'"><div class="ph"><span class="pdot '
        +(name==="codex"?"x":"c")+'"></span>'+esc(name)+"</div>"
        +'<div class="pv mono">'+esc(fmtUsd(cost))+"</div>"
        +'<div class="pl">'+(idle?"no sessions in window":esc(fmtNum(sess))+" sessions &middot; "+esc(fmtTok(tok))+" tokens")+"</div></div>";
    }).join("");

    var segs=[["cache read",t.cacheRead,"var(--warn)"],["cache write",t.cacheWrite,"var(--purple)"],
      ["output",t.output,"var(--accent)"],["input",t.input,"var(--ok)"]];
    document.getElementById("u-tokbar").innerHTML=segs.map(function(sg){
      return '<i style="width:'+pct(sg[1],t.tokens).toFixed(2)+"%;background:"+sg[2]+'"></i>';
    }).join("");
    document.getElementById("u-toklegend").innerHTML=segs.map(function(sg){
      return '<span class="lg"><i style="background:'+sg[2]+'"></i>'+esc(sg[0])+" <b>"+esc(fmtTok(sg[1]))+"</b></span>";
    }).join("");

    // punchcard — dow 0 = Mon
    var DOW=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], pcMax=0, key;
    for(key in (d.punchcard||{}))pcMax=Math.max(pcMax,Number(d.punchcard[key])||0);
    var pcHtml="";
    for(var dw=0;dw<7;dw++){
      pcHtml+='<div class="pc-row"><span class="pc-day">'+DOW[dw]+"</span>";
      for(var hr=0;hr<24;hr++){
        var n=Number((d.punchcard||{})[dw+"-"+hr])||0;
        var v=pcMax?(n/pcMax):0;
        pcHtml+='<i class="pc" style="--v:'+v.toFixed(3)+'" title="'+DOW[dw]+" "+(hr<10?"0":"")+hr
          +':00 — '+n+' responses"></i>';
      }
      pcHtml+="</div>";
    }
    pcHtml+='<div class="pc-axis">';
    for(var ax=0;ax<24;ax++)pcHtml+="<span>"+(ax%3===0?ax:"")+"</span>";
    pcHtml+="</div>";
    document.getElementById("u-punch").innerHTML=pcMax?pcHtml:'<div class="empty">no responses in window.</div>';

    // models + projects
    var models=entries(d.byModel), mMax=models.length?models[0].cost:0;
    document.getElementById("u-models").innerHTML=models.length?models.map(function(m){
      return bar(esc(m.name),fmtUsd(m.cost),fmtTok(fld(m.v,"tokens"))+" · "+fmtNum(fld(m.v,"responses"))+" resp",
        pct(m.cost,mMax),false);
    }).join(""):'<div class="empty">no models in window.</div>';
    // Dropped-connection / rate-limit / auth-failure turns never resolve to a
    // model — excluded from this list entirely rather than shown as a $0 row
    // (see docs/USAGE-SCORECARD-METRICS.md §10). Surfaced here instead, only
    // when nonzero, so they stay visible rather than silently vanishing.
    // On its own line (.n-sub), so no leading separator — a "·" would read as a
    // continuation of the caption above rather than the start of a new fact.
    var exc=fld(t,"exceptions");
    document.getElementById("u-models-note").textContent=exc?(fmtNum(exc)+" dropped/errored turn"+(exc===1?"":"s")+" excluded"):"";

    // Account analytics is explicitly fetched and cached by ak usage.
    // OpenRouter does not provide session/host/project correlation here, so
    // these numbers remain a separate block and never alter t/byHost/byModel.
    var ora=d.providerAnalytics&&d.providerAnalytics.openrouter;
    if(!ora){
      document.getElementById("u-openrouter-note").textContent="not refreshed · offline";
      document.getElementById("u-openrouter").innerHTML=
        '<div class="empty">No OpenRouter account cache. Run <b>ak usage refresh openrouter</b> explicitly.</div>';
    }else{
      var ot=ora.totals||{}, cov=ora.coverage||{}, oms=ora.byModel||[];
      document.getElementById("u-openrouter-note").textContent=
        "cached "+ago(Math.max(0,Math.round((Date.now()-Date.parse(ora.fetchedAt))/1000)))+" · "
        +(cov.from||"no activity")+" → "+(cov.through||"no activity")
        +" · never merged into transcript totals";
      var oMax=oms.reduce(function(m,x){return Math.max(m,fld(x,"requests"));},0);
      var cards='<div class="psplit">'
        +'<div class="pcard"><div class="ph">OpenRouter requests</div><div class="pv mono">'+esc(fmtNum(ot.requests))+'</div>'
        +'<div class="pl">'+esc(fmtTok(fld(ot,"promptTokens")+fld(ot,"completionTokens")))+" tokens · 30 completed UTC days</div></div>"
        +'<div class="pcard"><div class="ph">OpenRouter credits spent</div><div class="pv mono">'+esc(fmtUsd(ot.usage))+'</div>'
        +'<div class="pl">'+esc(fmtUsd(ot.byokUsageInference))+" BYOK inference estimate · account-level</div></div></div>";
      var modelRows=oms.length?oms.map(function(m){
        var req=fld(m,"requests");
        return bar(esc(m.model),fmtNum(req)+" req",fmtTok(fld(m,"promptTokens")+fld(m,"completionTokens"))
          +" tok · "+fmtUsd(fld(m,"usage"))+" OpenRouter credits · "
          +fmtUsd(fld(m,"byokUsageInference"))+" BYOK estimate",pct(req,oMax),false);
      }).join(""):'<div class="empty">The cache contains no completed activity.</div>';
      document.getElementById("u-openrouter").innerHTML=cards+'<div class="provider-analytics-models">'+modelRows+"</div>";
    }

    var projects=entries(d.byProject), pMax=projects.length?projects[0].cost:0;
    var shown=projects.slice(0,8);
    document.getElementById("u-projects-note").textContent=
      projects.length>8?("top 8 of "+projects.length):(projects.length+" project"+(projects.length===1?"":"s"));
    document.getElementById("u-projects").innerHTML=shown.length?shown.map(function(pr){
      return bar(esc(pr.name),fmtUsd(pr.cost),fmtNum(fld(pr.v,"sessions"))+" sess · "+fmtMins(fld(pr.v,"minutes")),
        pct(pr.cost,pMax),true);
    }).join(""):'<div class="empty">no projects in window.</div>';

    // categories — confidence is DISPLAYED, and Unclassified is never hidden.
    var cats=entries(d.byCategory), cMax=cats.length?cats[0].cost:0;
    document.getElementById("u-cats").innerHTML=cats.length?cats.map(function(c){
      var sess=fld(c.v,"sessions")||1, conf=fld(c.v,"confidence");
      var uncl=(c.name==="Unclassified");
      var dot=uncl?"":'<i class="conf" style="opacity:'+(0.5+conf*0.5).toFixed(2)
        +'" title="mean classifier confidence '+conf.toFixed(2)+'"></i>';
      return '<button type="button" class="crow'+(uncl?" uncl":"")+'" data-cat="'+esc(c.name)+'" title="click to filter sessions">'
        +'<span class="c-name">'+esc(c.name)+dot+"</span>"
        +'<span class="mbar"><i style="width:'+pct(c.cost,cMax).toFixed(1)+"%;background:"+(uncl?"var(--ink-dim)":"var(--accent)")+'"></i></span>'
        +'<span class="mval mono">'+esc(fmtUsd(c.cost))+"</span>"
        +'<span class="msub mono">'+esc(fmtNum(fld(c.v,"sessions"))+" sess · "+fmtUsd(c.cost/sess)+"/sess")+"</span></button>";
    }).join(""):'<div class="empty">nothing classified in window.</div>';
  }

  // ══ Limits view (ADR-0010) ═════════════════════════════════════════════════
  var LIMITS=null, limitsBusy=false;

  function loadLimits(){
    if(limitsBusy)return;
    limitsBusy=true;
    fetch("/api/limits?days="+usageDays,{cache:"no-store",headers:authHeaders()})
      .then(function(r){return r.json();})
      .then(function(d){LIMITS=d&&!d.error?d:{error:(d&&d.error)||"limits unavailable"};})
      .catch(function(){LIMITS={error:"limits unavailable"};})
      .then(function(){limitsBusy=false; renderLimits();});
  }

  // "as of 3m ago" — an epoch-ms fetchedAt against the browser clock. Stale is
  // LABELLED, never hidden: a yesterday's-number bar with no timestamp is a lie
  // of omission.
  function limAge(ms){
    if(!ms||!isFinite(ms))return "";
    var m=Math.max(0,Math.round((Date.now()-ms)/60000));
    if(m<1)return "just now";
    if(m<60)return m+"m ago";
    var h=Math.round(m/60);
    return h<48?h+"h ago":Math.round(h/24)+"d ago";
  }
  function limStale(ms,freshMs){return !ms||!isFinite(ms)||(Date.now()-ms)>freshMs;}
  function resetTxt(sec){
    if(!sec||!isFinite(sec))return "";
    var d=new Date(sec*1000);
    if(isNaN(d))return "";
    return "resets "+d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
  }
  // One utilization row on the shared .mrow grid; fill color says how close to
  // the cap this window is (ok <70, warn ≥70, fail ≥90).
  function limRow(label,usedPercent,resetSec,sub){
    var p=Math.max(0,Math.min(100,Number(usedPercent)||0));
    var col=p>=90?"var(--fail)":(p>=70?"var(--warn)":"var(--ok)");
    return '<div class="mrow"><span class="mname">'+esc(label)+"</span>"
      +'<span class="mbar"><i style="width:'+p.toFixed(1)+"%;background:"+col+'"></i></span>'
      +'<span class="mval mono">'+p.toFixed(0)+"%</span>"
      +'<span class="msub mono">'+esc(sub||resetTxt(resetSec))+"</span></div>";
  }

  function renderLimits(){
    var claudeEl=document.getElementById("u-lim-claude");
    var codexEl=document.getElementById("u-lim-codex");
    if(!claudeEl||!codexEl)return;
    if(!LIMITS){claudeEl.innerHTML='<div class="empty">loading&hellip;</div>'; codexEl.innerHTML='<div class="empty">loading&hellip;</div>'; return;}
    if(LIMITS.error){claudeEl.innerHTML='<div class="empty">'+esc(LIMITS.error)+"</div>"; codexEl.innerHTML=""; return;}

    var c=LIMITS.claude;
    var cn=document.getElementById("u-lim-claude-note");
    if(c&&c.windows&&c.windows.length){
      // Claude's tee is push-only: FRESH means a session wrote it in the last
      // 10 minutes; anything older gets the stale badge rather than silence.
      if(cn)cn.textContent="statusline tee · "+limAge(c.fetchedAt)+(limStale(c.fetchedAt,600000)?" · stale":"");
      claudeEl.innerHTML=c.windows.map(function(w){
        return limRow("claude · "+(w.label||w.id),w.usedPercent,w.resetsAt);
      }).join("");
    }else{
      if(cn)cn.textContent="no data";
      claudeEl.innerHTML='<div class="empty">no Claude limit data yet &mdash; it arrives while a Claude Code session runs '
        +"with the kit's managed statusline (Pro/Max plans only). Run one session, then revisit.</div>";
    }

    var x=LIMITS.codex;
    var xn=document.getElementById("u-lim-codex-note");
    if(x&&x.lanes&&x.lanes.length){
      if(xn)xn.textContent=(x.planType?("plan "+x.planType+" · "):"")+"app-server · "+limAge(x.fetchedAt);
      var html="";
      for(var i=0;i<x.lanes.length;i++){
        var lane=x.lanes[i];
        for(var j=0;j<(lane.windows||[]).length;j++){
          var w=lane.windows[j];
          html+=limRow(lane.name+" · "+(w.label||""),w.usedPercent,w.resetsAt);
        }
        if(!(lane.windows||[]).length)html+=limRow(lane.name,0,null,"no window reported");
      }
      var rc=x.resetCredits;
      if(rc&&rc.availableCount>0){
        html+='<div class="legend" style="margin-top:11px"><span class="lg"><i style="background:var(--ok)"></i>'
          +esc(fmtNum(rc.availableCount))+" rate-limit reset credit"+(rc.availableCount===1?"":"s")
          +" available &middot; redeem via codex /usage</span></div>";
      }
      codexEl.innerHTML=html;
    }else{
      if(xn)xn.textContent="no data";
      codexEl.innerHTML='<div class="empty">no Codex limit data &mdash; codex is not installed, not logged in, '
        +"or app-server did not answer.</div>";
    }

    var ins=Array.isArray(LIMITS.insights)?LIMITS.insights:[];
    document.getElementById("u-lim-insights").innerHTML=ins.length
      ?ins.map(insightCard).join("")
      :'<div class="empty">no limit findings &mdash; nothing is ahead of pace and no arbitrage is open.</div>';
  }

  function renderFindings(d){
    var ins=Array.isArray(d.insights)?d.insights:[];
    var badge=document.getElementById("u-findings-n");
    var warns=ins.filter(function(x){return x.severity==="warn";}).length;
    if(badge){if(warns){badge.hidden=false; badge.textContent=String(warns);}else{badge.hidden=true;}}
    document.getElementById("u-findings-note").innerHTML=
      ins.length+" finding"+(ins.length===1?"":"s")+", ranked by estimated impact. A finding only claims a "
      +"dollar figure when it can compute one from your data &mdash; the rest say <b>no $ claimed</b> rather "
      +"than inventing a number. Recommendations that depend on model-capability claims carry their sources.";
    document.getElementById("u-insights").innerHTML=ins.length
      ?ins.map(insightCard).join("")
      :'<div class="empty">no findings — nothing in this window crossed a detector threshold.</div>';
  }

  // One finding card. Shared by the Findings view and the Limits view — both
  // render the same Insight contract, so they must render it the same way.
  function insightCard(f,i){
    var imp=(typeof f.impact==="number")
      ? '<span class="i-imp mono">~'+esc(fmtUsd(f.impact))+"/window</span>"
      : '<span class="i-imp mono soft">no $ claimed</span>';
    var cmd=f.command?' <code class="i-cmd">'+esc(f.command)+"</code>":"";
    var src="";
    if(f.sources&&f.sources.length){
      src='<details class="i-src"><summary>grounding &mdash; '+f.sources.length+" source"
        +(f.sources.length===1?"":"s")+"</summary><ul>"
        +f.sources.map(function(sc){
          return "<li><a href=\\""+esc(sc.url)+"\\" target=\\"_blank\\" rel=\\"noreferrer noopener\\">"+esc(sc.label)+"</a></li>";
        }).join("")+"</ul></details>";
    }
    return '<article class="icard" data-sev="'+esc(f.severity||"info")+'">'
      +'<div class="i-top"><span class="i-n">'+(i+1)+"</span>"
      +'<span class="i-title">'+esc(f.title)+"</span>"
      +'<span class="i-kind">'+esc(f.kind==="trend"?"trend":"coaching")+"</span>"+imp+"</div>"
      +'<p class="i-find">'+esc(f.finding)+"</p>"
      +(f.evidence?'<p class="i-ev">'+esc(f.evidence)+"</p>":"")
      +'<div class="i-act"><span class="i-arrow">&rarr;</span><span>'+esc(f.action)+cmd+"</span></div>"
      +src+"</article>";
  }

  // A missing signal renders as an em dash and is NEVER omitted: a line that
  // disappears when the value is null teaches the reader that the field does
  // not exist, when in fact it was measured and found absent (ADR-0009 §5).
  function dash(v){return (v==null||v==="")?"—":String(v);}

  /* The ten fields that shipped on the wire and rendered nowhere. Everything
     here comes from the row the browser already holds — no route, no fetch. */
  function sdetail(sx){
    // basis is a STRING contract. Only null/empty falls back, so a non-string
    // still renders as itself and trips the harness's [object Object] net —
    // coercing it here would hide exactly the bug the net exists to catch.
    var basis=(sx.basis==null||sx.basis==="")?"no signal":sx.basis;
    var conf=(typeof sx.confidence==="number")
      ? ' <span class="sd-conf">(conf '+esc(sx.confidence.toFixed(2))+")</span>" : "";
    var models=(Array.isArray(sx.models)&&sx.models.length)?sx.models.join(", "):"—";
    var toks="in "+fmtTok(sx.input)+" · out "+fmtTok(sx.output)
      +" · cache r "+fmtTok(sx.cacheRead)+" / w "+fmtTok(sx.cacheWrite)
      // Codex-only detail: reasoning tokens are a SUBSET of output (they bill
      // as output), so this annotates the split without changing any sum.
      +((Number(sx.reasoningOutput)||0)>0?" · reasoning "+fmtTok(sx.reasoningOutput)+" (in out)":"");
    var tmap=(sx.tools&&typeof sx.tools==="object"&&!Array.isArray(sx.tools))?sx.tools:{};
    var tl=[],tk;
    for(tk in tmap)tl.push({n:tk,c:Number(tmap[tk])||0});
    tl.sort(function(a,b){return b.c-a.c;});
    var tools=tl.length?tl.slice(0,6).map(function(x){return x.n+" "+x.c;}).join(" · "):"—";
    var flags="skill "+dash(sx.skill)+" · plugin "+dash(sx.plugin)
      +" · sidechain "+(sx.sidechain==null?"—":(sx.sidechain?"yes":"no"))
      +" · worktree "+dash(sx.worktree);
    var rows=[["basis",esc(basis)+conf],["models",esc(models)],["tokens",esc(toks)],
      ["tools",esc(tools)],["flags",esc(flags)]];
    return '<div class="sdetail" id="sd-'+esc(sx.id)+'" hidden>'
      +rows.map(function(r){
        // The literal space is load-bearing, not formatting: adjacent
        // inline-blocks with no whitespace between them collapse into one
        // unbroken word in the rendered text ("FLAGSskill"), destroying the
        // word boundary that anything reading it depends on.
        return '<div class="sd-line"><span class="sd-k">'+r[0]+'</span> <span class="sd-v">'+r[1]+"</span></div>";
      }).join("")+"</div>";
  }

  // Returns TWO siblings: the grid row, then its detail strip. The strip is a
  // block-level sibling inside .pbody, not a grid child of .srow, so it spans
  // the full width without joining the column layout.
  function sessionRow(sx){
    var host=sx.host||sx.transcriptProvider||((sx.provider==="codex")?"codex":"claude");
    var provider=sx.provider||sx.inferenceProvider||"unknown";
    var cat=sx.category||"Unclassified";
    var uncl=(cat==="Unclassified");
    var weak=(typeof sx.confidence==="number"&&sx.confidence<0.6)?"0":"1";
    var when=sx.start?new Date(sx.start):null;
    var whenTxt=when&&!isNaN(when)?when.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"—";
    // Session ids are validated against [A-Za-z0-9._-]{1,128} by parseSessionId
    // before they are ever indexed, so they are safe AND unique as DOM ids.
    var sid=esc(sx.id);
    var wt=sx.worktree!=null?'<span class="s-wt" title="git worktree — the repo is the project">⑂'+esc(sx.worktree)+"</span>":"";
    return '<div class="srow" data-id="'+sid+'" title="open transcript">'
      +'<button class="s-exp" type="button" aria-expanded="false" aria-controls="sd-'+sid+'"'
        +' title="show session detail" aria-label="show session detail">&rsaquo;</button>'
      +'<span class="s-host s-'+esc(host)+'" title="host: '+esc(host)+' · provider: '+esc(provider)+'">'+esc(host)
        +'<small class="s-provider">'+esc(provider)+"</small></span>"
      +'<span class="s-title">'+esc(sx.title||"(untitled)")+wt+"</span>"
      +'<span class="cat'+(uncl?" uncl":"")+'" data-w="'+weak+'">'+esc(cat)+"</span>"
      +'<span class="s-when mono">'+esc(whenTxt)+"</span>"
      +'<span class="s-dur mono">'+esc(fmtMins(sx.minutes))+"</span>"
      +'<span class="s-turns mono">'+esc((sx.prompts||0)+"/"+(sx.responses||0))+"</span>"
      +'<span class="s-tok mono">'+esc(fmtTok(sx.tokens))+"</span>"
      +'<span class="s-cost mono">'+esc(fmtUsd(sx.cost))+"</span>"
      +'<button class="s-tx" type="button" data-tx="'+sid+'" title="open transcript" aria-label="open transcript">&#9707;</button>'
    +"</div>"+sdetail(sx);
  }

  function renderSessions(d){
    var tree=Array.isArray(d.projectTree)?d.projectTree:[];
    var n=document.getElementById("u-sessions-n");
    if(n)n.textContent=tree.length?" "+fmtNum((d.totals||{}).sessions):"";
    document.getElementById("u-tree").innerHTML=tree.length?tree.map(function(g){
      var chips="";
      // usage-index emits categories as a COST-RANKED ARRAY of
      // {category, sessions, cost} — already ordered, so no re-sort here. The
      // keyed-map fallback below is for older cached payloads only; treating an
      // array as a map yields Object.keys() === ["0","1"...] and renders
      // "0 [object Object]", so the shape check is load-bearing, not defensive noise.
      var cs=g.categories;
      if(Array.isArray(cs)){
        for(var i=0;i<cs.length&&i<3;i++){
          var c=cs[i]||{};
          chips+='<span class="pchip">'+esc(c.category)+" <b>"+esc(String(c.sessions))+"</b></span>";
        }
      }else if(cs&&typeof cs==="object"){
        var ck=Object.keys(cs).sort(function(a,b){return (cs[b]||0)-(cs[a]||0);}).slice(0,3);
        for(var j=0;j<ck.length;j++)chips+='<span class="pchip">'+esc(ck[j])+" <b>"+esc(String(cs[ck[j]]))+"</b></span>";
      }
      var rows=Array.isArray(g.rows)?g.rows:[];
      var body=rows.length?rows.slice(0,25).map(sessionRow).join(""):'<div class="smore">no sessions loaded for this project.</div>';
      if(rows.length>25||g.sessions>rows.length){
        body+='<div class="smore">showing '+Math.min(25,rows.length)+" of "+fmtNum(g.sessions)
          +' · <button type="button" data-more="'+esc(g.project)+'">load all</button></div>';
      }
      // Every project starts COLLAPSED. Auto-opening the first one pushed the
      // remaining projects below the fold, which defeats the point of the
      // aggregate view — the comparison across projects IS the top-level answer.
      return '<div class="pgroup">'
        +'<button class="phead" type="button"><span class="chev">&rsaquo;</span>'
        +'<span class="pname">'+esc(g.project)+"</span>"
        +'<span class="pchips">'+chips+"</span>"
        +'<span class="pn mono">'+esc(fmtNum(g.sessions))+" sess</span>"
        +'<span class="pn mono p-h">'+esc(fmtMins(g.minutes))+"</span>"
        +'<span class="pn mono p-tok">'+esc(fmtTok(g.tokens))+"</span>"
        +'<span class="pcost mono">'+esc(fmtUsd(g.cost))+"</span></button>"
        +'<div class="pbody" data-body="'+esc(g.project)+'">'+body+"</div></div>";
    }).join(""):'<div class="empty">no sessions in window.</div>';
  }

  // Secrets are masked SERVER-side (ADR-0009 §8) — nothing here can un-redact
  // what never left the process. This only makes the redactions visible as
  // redactions, so a reader can see that something was withheld.
  // The masker emits "<prefix>\u2026redacted" (sk-\u2026redacted, Bearer \u2026redacted).
  // This used to hunt for ***, \u2022\u2022\u2022 or [REDACTED] \u2014 sentinels nothing ever
  // produced \u2014 so no .masked span was ever created and the styling below was
  // dead code. There is deliberately NO click-to-reveal: masking happens
  // server-side and the original never reaches the browser, so there is nothing
  // here to reveal. Marking it is the whole feature.
  function markRedactions(text){
    return esc(text).replace(/([A-Za-z_.-]*\u2026redacted)/g,function(m){
      return '<span class="masked" title="masked server-side \u2014 the original was never sent to this page">'+m+"</span>";
    });
  }

  // Harness sentinel markup \u2014 the XML wrappers Claude Code writes into
  // transcript text (<command-name>, <system-reminder>, <local-command-*>) \u2014
  // rendered as styled structure instead of literal angle-bracket soup.
  // PRESENTATION ONLY: the wrapped content is kept verbatim (ADR-0009 \u00a78's
  // no-silent-alteration rule); only the wrapper tags become styling. Runs on
  // ESCAPED html (after markRedactions), so patterns match &lt;tag&gt;. An
  // unmatched tag (e.g. cut mid-sentinel by turn truncation) is left raw.
  var H_TAGS={"system-reminder":"system reminder","local-command-caveat":"caveat",
    "local-command-stdout":"command output","local-command-stderr":"command stderr",
    "bash-stdout":"bash output","bash-stderr":"bash stderr","task-notification":"task notification"};
  function fmtHarness(html){
    return html
      .replace(/&lt;command-name&gt;([\\s\\S]*?)&lt;\\/command-name&gt;\\s*(?:&lt;command-message&gt;([\\s\\S]*?)&lt;\\/command-message&gt;\\s*)?(?:&lt;command-args&gt;([\\s\\S]*?)&lt;\\/command-args&gt;)?/g,
        function(_,name,msg,args){
          var n=name.trim(), a=(args||"").trim(), m=(msg||"").trim();
          return '<span class="h-cmd"'+(m&&m!==n.replace(/^\\//,"")?' title="'+m+'"':"")
            +'>'+n+(a?" "+a:"")+"</span>";
        })
      // bash-input is the person's own "! command" — a chip, prefixed so it
      // reads as the shell invocation it was, not as prose.
      .replace(/&lt;bash-input&gt;([\\s\\S]*?)&lt;\\/bash-input&gt;/g,
        function(_,cmd){return '<span class="h-cmd" title="shell command run with the ! prefix">! '+cmd.trim()+"</span>";})
      .replace(/&lt;(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification)&gt;\\s*([\\s\\S]*?)\\s*&lt;\\/\\1&gt;/g,
        function(_,tag,body){
          return '<span class="h-note"><i class="h-tag">'+H_TAGS[tag]+"</i>"+body+"</span>";
        });
  }

  // ADR-0009 §8 — an abridged turn must not be readable as a complete one, and
  // "truncated" alone is not enough: a reader who cannot tell 1% loss from 90%
  // loss knows something is missing and nothing about whether it matters.
  //
  // The SHOWN figure is DERIVED, never hardcoded. MAX_TURN_CHARS lives in
  // usage-index.mjs and the browser never sees it, so a literal 40000 here
  // would silently desync the day someone changes the constant — which is the
  // failure mode this whole ADR exists to prevent. We subtract the marker the
  // producer appends from the text we actually received.
  var TRUNC_MARK="\\n…[truncated]";
  function truncBadge(tn){
    if(!tn||tn.truncated!==true)return "";
    var shown=String(tn.text==null?"":tn.text);
    var n=shown.length-(shown.slice(-TRUNC_MARK.length)===TRUNC_MARK?TRUNC_MARK.length:0);
    // A cached payload can carry truncated:true with no originalChars. Say so,
    // rather than inventing a denominator or dropping the badge — §6's rule
    // about claiming a figure only when you can compute one.
    if(typeof tn.originalChars!=="number"||!isFinite(tn.originalChars)||tn.originalChars<=0)
      return '<span class="t-trunc" title="this turn was abridged before it was sent to this page; '
        +'the original length was not recorded">truncated</span>';
    return '<span class="t-trunc" title="'
      +esc(fmtNum(n)+" of "+fmtNum(tn.originalChars)
        +" characters shown; the rest was not sent to this page")+'">truncated · '
      +esc(fmtTok(n))+" of "+esc(fmtTok(tn.originalChars))+"</span>";
  }

  function renderTranscript(){
    var crumb=document.getElementById("u-crumb"), body=document.getElementById("u-turns");
    if(!usageSession){
      crumb.innerHTML='<button type="button" data-back="1">&lsaquo; sessions</button><span>no session selected</span>';
      body.innerHTML='<div class="empty">pick a session in the Sessions view to read it here.</div>';
      return;
    }
    var t=TRANSCRIPT&&TRANSCRIPT.id===usageSession?TRANSCRIPT:null;
    var m=(t&&t.meta)||{};
    crumb.innerHTML='<button type="button" data-back="1">&lsaquo; sessions</button>'
      +'<b style="color:var(--ink)">'+esc(m.title||usageSession)+"</b>"
      +'<span class="mono">'+esc([m.project,fmtMins(m.minutes),
        (m.prompts||0)+" prompts / "+(m.responses||0)+" responses",fmtTok(m.tokens),fmtUsd(m.cost)]
        .filter(Boolean).join(" · "))+"</span>";
    if(!t){body.innerHTML='<div class="empty">loading transcript…</div>'; return;}
    if(t.error){body.innerHTML='<div class="empty">'+esc(t.error)+"</div>"; return;}
    body.innerHTML=t.turns.length?t.turns.map(function(tn){
      var user=(tn.role==="user");
      var text=tn.text!=null?tn.text:(tn.body!=null?tn.body:(tn.content!=null?tn.content:""));
      var tools=(tn.tools&&tn.tools.length)
        ?'<div class="chips">'+tn.tools.map(function(x){return '<span class="tool">'+esc(x)+"</span>";}).join("")+"</div>":"";
      var meta=truncBadge(tn)
        +(tn.output?'<span class="t-meta mono">'+esc(fmtNum(tn.output))+" out</span>":"");
      // role "user" ≠ "the human typed this": the Messages API records tool
      // results and harness context injections under the user role, and the
      // parser marks WHICH via tn.kind. Only kind "prompt" earns "you" — a
      // tool result labeled "you" attributes the harness's work to the person.
      // Fallback for a turn without kind: the prompt flag (false ⇒ tool
      // feedback was the overwhelmingly dominant non-prompt case).
      var kind=tn.kind||(user?(tn.prompt===false?"tool-result":"prompt"):"");
      var who,cls,title="";
      if(!user){who=tn.model||tn.role||"assistant"; cls="t-asst";}
      else if(kind==="tool-result"){who="tool result"; cls="t-tool"; title="output returned to the model by the tooling — not typed by you";}
      else if(kind==="context"){who="context"; cls="t-tool"; title="context injected by the harness — not typed by you";}
      else{who="you"; cls="t-user";}
      return '<div class="turn '+cls+'"><div class="t-who"'+(title?' title="'+esc(title)+'"':"")+'>'
        +esc(who)+meta+"</div>"
        +'<div class="t-body">'+fmtHarness(markRedactions(String(text)))+tools+"</div></div>";
    }).join(""):'<div class="empty">this session has no readable turns.</div>';
  }

  function renderUsage(){
    if(!USAGE)return;
    if(USAGE.error){
      document.getElementById("u-hero").innerHTML='<div class="empty">'+esc(USAGE.error)+"</div>";
      return;
    }
    renderScore(USAGE);
    renderFindings(USAGE);
    renderSessions(USAGE);
    if(usageView==="transcript")renderTranscript();
  }

  function wireUsage(){
    var seg=document.getElementById("usage-seg");
    if(seg)seg.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-view]"):null;
      if(b)setUsageView(b.getAttribute("data-view"));
    });
    var chips=document.getElementById("usage-days");
    if(chips)chips.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-days]"):null;
      if(!b)return;
      usageDays=Number(b.getAttribute("data-days"))||14;
      var all=chips.querySelectorAll("[data-days]");
      for(var i=0;i<all.length;i++)all[i].classList.toggle("on",all[i]===b);
      usageLoaded=false; loadUsage(true);
      // limit findings are computed against the same window; refetch on change.
      LIMITS=null; if(usageView==="limits")loadLimits();
    });
    var panel=document.getElementById("panel-usage");
    if(panel)panel.addEventListener("click",function(e){
      var tgt=e.target;
      var head=tgt.closest?tgt.closest(".phead"):null;
      if(head){
        var g=head.parentElement;
        if(g.hasAttribute("data-open"))g.removeAttribute("data-open"); else g.setAttribute("data-open","1");
        return;
      }
      var more=tgt.closest?tgt.closest("[data-more]"):null;
      if(more){loadProjectSessions(more.getAttribute("data-more")); return;}
      // MUST come before the [data-id] branch below: the caret lives INSIDE the
      // row, so closest("[data-id]") matches it too. stopPropagation() first,
      // then toggle — the row's click-to-open-transcript path is shipped
      // behaviour and this must not disturb it. State is ephemeral by design:
      // not persisted, not in the hash (a poll refresh re-renders collapsed).
      var exp=tgt.closest?tgt.closest(".s-exp"):null;
      if(exp){
        e.stopPropagation();
        var wasOpen=exp.getAttribute("aria-expanded")==="true";
        exp.setAttribute("aria-expanded",wasOpen?"false":"true");
        var det=document.getElementById(exp.getAttribute("aria-controls"));
        if(det)det.hidden=wasOpen;
        return;
      }
      // the glyph is the explicit affordance, but the whole row is a target too —
      // a 14px icon is a cruel click target for a row you can already see.
      var row=tgt.closest?tgt.closest("[data-id]"):null;
      if(row){setUsageView("transcript",row.getAttribute("data-id")); return;}
      var cat=tgt.closest?tgt.closest("[data-cat]"):null;
      if(cat){filterByCategory(cat.getAttribute("data-cat")); return;}
      var back=tgt.closest?tgt.closest("[data-back]"):null;
      if(back){setUsageView("sessions",null); return;}
      var mask=tgt.closest?tgt.closest(".masked"):null;
      if(mask)mask.classList.toggle("shown");
    });
  }

  function loadProjectSessions(project){
    fetch("/api/sessions?days="+usageDays+"&project="+encodeURIComponent(project)+"&limit=1000",{cache:"no-store",headers:authHeaders()})
      .then(function(r){return r.json();}).then(function(d){
        var el=document.querySelector('[data-body="'+project.replace(/"/g,"")+'"]');
        if(!el)return;
        el.innerHTML=(d.sessions||[]).map(sessionRow).join("")
          ||'<div class="smore">no sessions.</div>';
      }).catch(function(){});
  }

  function filterByCategory(cat){
    setUsageView("sessions");
    fetch("/api/sessions?days="+usageDays+"&category="+encodeURIComponent(cat)+"&limit=1000",{cache:"no-store",headers:authHeaders()})
      .then(function(r){return r.json();}).then(function(d){
        document.getElementById("u-tree").innerHTML=
          '<div class="pgroup" data-open="1"><button class="phead" type="button">'
          +'<span class="chev">&rsaquo;</span><span class="pname">'+esc(cat)+"</span>"
          +'<span class="pchips"><span class="pchip">filtered <b>'+fmtNum(d.total||0)+"</b></span></span>"
          +'<span class="pn mono"></span><span class="pn mono"></span><span class="pn mono"></span>'
          +'<span class="pcost mono"></span></button>'
          +'<div class="pbody">'+((d.sessions||[]).map(sessionRow).join("")
            ||'<div class="smore">no sessions in this category.</div>')+"</div></div>";
      }).catch(function(){});
  }

  setTab(activeTab);
  setUsageView(usageView);
  wirePoll();
  wireUsage();
  schedulePoll();
  lastAttempt=Date.now(); inflight=true;
  Promise.all([pollStatus()].concat(activeTab==="usage"?[loadUsage()]:[]))
    .catch(function(){}).then(function(){inflight=false; tickClock();});
  setInterval(tickClock,1000);
})();
`;
