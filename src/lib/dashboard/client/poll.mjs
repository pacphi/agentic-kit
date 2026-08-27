// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { renderAbout } from './about.mjs';
import { DASH_TOKEN_KEY, activeTab, authHeaders, hideGate, showGate, systemView } from './bootstrap.mjs';
import { render, tickClock } from './intelligence.mjs';
import { PROJ_SORT, loadSystem, renderSysProjects } from './system-projects.mjs';
import { loadModelLifecycle, loadUsage } from './usage.mjs';

  // ══ poll control ═══════════════════════════════════════════════════════════
  // Governs EVERY tab, not just Usage (ADR-0009 §7). The old hardcoded 5 s poll
  // predated any expensive view; 30 s is the default now, and the whole range is
  // user-chosen and persisted. Every refresh path — automatic or manual — funnels
  // through refreshAll(), so the single-flight guard and the cooldown are
  // impossible to route around.
  var LS_POLL="ak-dash-poll";
  var POLL_DEFAULT_MS=30000;
  export var POLL_COOLDOWN_MS=3000;
  var POLL_LABEL={15000:"15s",30000:"30s",60000:"1m",300000:"5m",900000:"15m",
    1800000:"30m",3600000:"1h",21600000:"6h",43200000:"12h",86400000:"24h"};
  export var pollOn=true, pollMs=POLL_DEFAULT_MS, pollTimer=null, inflight=false, lastAttempt=0;

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

  // ── Panel collapse (.strip-toggle) ──────────────────────────────────────────
  // Persisted, unlike the ephemeral row expanders: these panels are re-rendered
  // by every poll, so an unpersisted collapse would reopen itself within 30 s.
  // Only DEPARTURES from each panel's markup default are stored, so the default
  // stays the single source of truth (provider account analytics ships
  // aria-expanded="false"; the routing panels ship "true") and changing one in
  // page.mjs does not need a matching change here or a localStorage migration.
  var LS_COLLAPSE="ak-dash-collapse";
  var collapseState={};
  try{
    var savedCollapse=JSON.parse(localStorage.getItem(LS_COLLAPSE)||"null");
    if(savedCollapse&&typeof savedCollapse==="object")collapseState=savedCollapse;
  }catch(e){}

  function saveCollapse(){
    try{localStorage.setItem(LS_COLLAPSE,JSON.stringify(collapseState));}catch(e){}
  }

  function setStripCollapsed(btn,collapsed){
    var id=btn.getAttribute("aria-controls");
    var body=id?document.getElementById(id):null;
    btn.setAttribute("aria-expanded",collapsed?"false":"true");
    if(body)body.hidden=collapsed;
    if(id){collapseState[id]=collapsed;saveCollapse();}
  }

  // Collapsible panels live in more than one tab (Overview's routing pair, the
  // Usage scorecard's provider analytics), so the listener is DOCUMENT-level
  // rather than hung off any one panel — the per-panel listeners each only fire
  // inside their own subtree, which would silently leave the others inert.
  // Then apply saved state once: panels whose id was never toggled keep
  // whatever page.mjs declared.
  export function wireStripCollapse(){
    document.addEventListener("click",function(e){
      var btn=e.target&&e.target.closest?e.target.closest(".strip-toggle"):null;
      if(!btn)return;
      setStripCollapsed(btn,btn.getAttribute("aria-expanded")==="true");
    });
    // Projects table sorting. Same column toggles direction; a different column
    // adopts ITS natural direction and takes over as the only active sort.
    document.addEventListener("click",function(e){
      var btn=e.target&&e.target.closest?e.target.closest("[data-proj-sort]"):null;
      if(!btn)return;
      var key=btn.getAttribute("data-proj-sort");
      if(!PROJ_SORT[key])return;
      projSort=projSort.key===key
        ? {key:key,dir:projSort.dir==="asc"?"desc":"asc"}
        : {key:key,dir:PROJ_SORT[key].dir};
      if(SYSTEM)renderSysProjects(SYSTEM);
    });
    // Storage's session rows open the same transcript view Usage does, through
    // the public bridge rather than a second navigation path. It validates the
    // id itself and returns false on a bad one, so a stale row cannot strand
    // the user on an empty view.
    document.addEventListener("click",function(e){
      var link=e.target&&e.target.closest?e.target.closest("[data-transcript]"):null;
      if(!link)return;
      window.AKDashboardOpenTranscript(link.getAttribute("data-transcript"));
    });
    var btns=document.querySelectorAll(".strip-toggle");
    for(var i=0;i<btns.length;i++){
      var id=btns[i].getAttribute("aria-controls");
      if(id&&typeof collapseState[id]==="boolean")setStripCollapsed(btns[i],collapseState[id]);
    }
  }

  export function pollStatus(){
    // Carries the CURRENT project selection on every request (omitted only
    // before the very first response has told us the server's own default —
    // see the intelProjects/selectedProjectKey block above). intelRequestSeq
    // guards against a slow response for a project the picker has since
    // moved away from (wireIntelPicker) clobbering a newer one's render.
    var seq=++intelRequestSeq;
    var url="/api/status"+(selectedProjectKey?"?project="+encodeURIComponent(selectedProjectKey):"");
    return fetch(url,{cache:"no-store",headers:authHeaders()}).then(function(r){
      if(r.status===401){try{localStorage.removeItem(DASH_TOKEN_KEY);}catch(e){}showGate("Wrong or missing dashboard token.");throw Error("unauthorized");}
      return r.json();
    }).then(function(d){
      hideGate();
      lastUpdated=Date.now();
      if(seq===intelRequestSeq)render(d);
      tickClock();
    }).catch(function(){
      var t=document.getElementById("verdict-text"); if(t)t.textContent="server unreachable";
      // About is editorial content plus a runtime join. Losing the join must
      // cost the chips, never the page: every card still renders, each one
      // saying its state is unknown and why (ADR-0026, ADR-0023).
      renderAbout(null);
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
    if(activeTab==="usage"){
      jobs.push(loadUsage(true));
      if(usageView==="models")jobs.push(loadModelLifecycle(true));
    }
    // The Runtime view is a live census — processes, CPU, RSS, daemon ages —
    // and it used to load ONCE when the System tab was first opened, so its
    // "live" figures could sit unchanged for an entire session while the
    // header cheerfully reported "updated 4s ago". It now refreshes on the
    // same clock as everything else the header speaks for.
    //
    // Only the cheap tier: this is the plain /api/system read, which is
    // memoized server-side and never walks the filesystem. The deep scan stays
    // behind Rescan (?refresh=deep) — putting a multi-minute walk on a 30s
    // timer would be a different feature and a much worse one.
    if(activeTab==="system"&&systemView==="runtime"&&!systemBusy)jobs.push(loadSystem());
    Promise.all(jobs).catch(function(){}).then(function(){
      inflight=false;
      if(btn)btn.classList.remove("spin");
      tickClock();
    });
  }

  export function schedulePoll(){
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

  export function wirePoll(){
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

