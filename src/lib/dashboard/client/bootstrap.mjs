// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { render, syncIntelStream } from './intelligence.mjs';
import { loadSystem } from './system-projects.mjs';
import { loadUsage } from './usage.mjs';

  "use strict";
  export var root=document.documentElement;
  var LS="ak-dash-theme", LS_TAB="ak-dash-tab", LS_OVERVIEW="ak-dash-overview-view";
  export var LS_SYSTEM="ak-dash-system-view", LS_ABOUT_NUDGE="ak-dash-about-nudge";

  // Dashboard-wide session token (ADR-0014). Bootstrap is idempotent and
  // duplicated from live-view.mjs's copy (separate <script> scope, no shared
  // state) — see that file's comment for why re-running it here is safe.
  export var DASH_TOKEN_KEY="ak-dash-token";
  export var DASH_TOKEN=(function(){
    var m=String(location.hash||"").match(/token=([A-Za-z0-9_-]+)/);
    if(m){try{localStorage.setItem(DASH_TOKEN_KEY,m[1]);}catch(e){}try{history.replaceState(null,"",location.pathname+location.search);}catch(e){}}
    try{return localStorage.getItem(DASH_TOKEN_KEY)||"";}catch(e){return"";}
  })();
  export function authHeaders(){return{"x-dash-token":DASH_TOKEN};}
  export function showGate(msg){
    document.body.classList.add("gated");
    var g=document.getElementById("dash-gate"); if(g)g.hidden=false;
    var e=document.getElementById("gate-err"); if(e)e.textContent=msg||"";
  }
  export function hideGate(){
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

  export var LEVEL_WORD={ok:"all systems nominal",warn:"attention advised",fail:"action required",unknown:"status unknown"};
  export var LAST=null, lastUpdated=0;

  // Intelligence project selection (machine-wide redesign, see server-side
  // dashboard-server.mjs's collectData()). selectedProjectKey starts null so
  // the very first /api/status and /api/live/intelligence requests omit
  // ?project= entirely and let the server apply ITS OWN default (the
  // most-recently-active discovered project) rather than the client guessing
  // at one — there is no "current project"/cwd concept on this side anymore.
  // Every later request carries the current selection explicitly.
  export var intelProjects=[], selectedProjectKey=null, selectedProjectLabel=null, intelRequestSeq=0;

  export function esc(s) { return String(s); } // PLACEHOLDER:esc

  // ── tabs (segmented control) ──
  // Category map (from ./groups.mjs — see that file): every subsystem lands in
  // exactly one tab; unknown/future subsystems fall back to Runtime.
  // Tab ORDER is the array order: About leads (orientation first), System
  // trails (the machine-resource family). Overview stays the LANDING view —
  // activeTab's initial value below is deliberately not TABS[0].
  var TABS=["about","overview","usage","observability","system"];
  var AREAS={about:"panel-about",overview:"area-overview",usage:"panel-usage",
    observability:"panel-observability",system:"area-system"};
  var OVERVIEW_VIEWS=["summary","hosts","providers","runtime","intel"];
  var SYSTEM_VIEWS=["summary","advisory","sessions","storage","runtime","catalog","projects"];
  export var ABOUT_SECTIONS=["hosts","engine","quality","kit","configured"];
  export var VIEWS=["score","limits","findings","prompts","models","sessions","transcript"];
  var CAT = {}; // PLACEHOLDER:CAT_JS
  export function catOf(s) { return CAT[s] || 'runtime'; } // PLACEHOLDER:catOf

  export var activeTab="overview", overviewView="summary", initialLiveScope="live";
  export var usageView="score", usageSession=null, usageDays=14;
  export var systemView="summary", aboutSection=null;
  try{var st=localStorage.getItem(LS_TAB); if(st&&TABS.indexOf(st)>=0)activeTab=st;}catch(e){}
  try{var ov=localStorage.getItem(LS_OVERVIEW);if(ov&&OVERVIEW_VIEWS.indexOf(ov)>=0)overviewView=ov;}catch(e){}
  try{var sv=localStorage.getItem(LS_SYSTEM);if(sv&&SYSTEM_VIEWS.indexOf(sv)>=0)systemView=sv;}catch(e){}
  // Canonical hierarchical deep links: #overview/runtime, #usage/sessions,
  // #observability/history, #system/storage, and #about/configured. A Usage
  // segment that is not a known view is a session id and opens the masked
  // transcript reader; an About segment is a section to scroll to, since About
  // is one continuous page rather than a set of sub-views.
  try{
    var parts=location.hash.slice(1).split("/");
    if(parts[0]&&TABS.indexOf(parts[0])>=0)activeTab=parts[0];
    if(parts[0]==="overview"&&parts[1]){
      var requestedOverview=parts[1]==="intelligence"?"intel":parts[1];
      if(OVERVIEW_VIEWS.indexOf(requestedOverview)>=0)overviewView=requestedOverview;
    }
    if(parts[0]==="usage"&&parts[1]){
      if(VIEWS.indexOf(parts[1])>=0){usageView=parts[1];}
      else{usageView="transcript"; usageSession=decodeURIComponent(parts[1]);}
    }
    if(parts[0]==="observability"&&parts[1]==="history")initialLiveScope="history";
    if(parts[0]==="system"&&parts[1]&&SYSTEM_VIEWS.indexOf(parts[1])>=0)systemView=parts[1];
    if(parts[0]==="about"&&parts[1]&&ABOUT_SECTIONS.indexOf(parts[1])>=0)aboutSection=parts[1];
  }catch(e){}

  function overviewHash(){return"#overview/"+(overviewView==="intel"?"intelligence":overviewView);}
  function usageHash(){
    if(usageView==="transcript")return "#usage/"+(usageSession?encodeURIComponent(usageSession):"transcript");
    return "#usage/"+usageView;
  }
  export function syncHash(){
    var hash="#"+activeTab;
    if(activeTab==="about")hash=aboutSection?"#about/"+aboutSection:"#about";
    else if(activeTab==="overview")hash=overviewHash();
    else if(activeTab==="usage")hash=usageHash();
    else if(activeTab==="system")hash="#system/"+systemView;
    else hash="#observability/"+(window.AKLive&&window.AKLive.state.scope||initialLiveScope);
    try{if(history.replaceState)history.replaceState(null,"",hash);}catch(e){}
  }

  export function positionThumb(){
    var segEl=document.getElementById("seg"), thumb=document.getElementById("seg-thumb");
    if(!segEl||!thumb)return;
    var btn=segEl.querySelector('[data-tab="'+activeTab+'"]');
    if(!btn)return;
    thumb.style.left=btn.offsetLeft+"px";
    thumb.style.width=btn.offsetWidth+"px";
  }
  function setOverviewView(id,focus,skipHash){
    if(OVERVIEW_VIEWS.indexOf(id)<0)return;
    overviewView=id;
    try{localStorage.setItem(LS_OVERVIEW,id);}catch(e){}
    for(var i=0;i<OVERVIEW_VIEWS.length;i++){
      var view=OVERVIEW_VIEWS[i],on=view===id,button=document.querySelector('[data-overview-view="'+view+'"]'),panel=document.getElementById("panel-"+(view==="summary"?"overview":view));
      if(button){button.setAttribute("aria-selected",on?"true":"false");button.tabIndex=on?0:-1;if(on&&focus)button.focus();}
      if(panel)panel.hidden=!on;
    }
    if(!skipHash&&activeTab==="overview")syncHash();
    syncIntelStream();
  }
  // System's five sub-views ride the same secondary rail as Overview's, with
  // the same persistence and the same aria wiring. Switching a view NEVER
  // fetches: the whole payload is one document, so a sub-view is a filter on
  // data already in hand, and a deep scan is only ever the Rescan button.
  export function setSystemView(id,focus,skipHash){
    if(SYSTEM_VIEWS.indexOf(id)<0)return;
    systemView=id;
    try{localStorage.setItem(LS_SYSTEM,id);}catch(e){}
    for(var i=0;i<SYSTEM_VIEWS.length;i++){
      var view=SYSTEM_VIEWS[i],on=view===id;
      var button=document.querySelector('[data-system-view="'+view+'"]');
      var panel=document.getElementById("panel-sys-"+view);
      if(button){button.setAttribute("aria-selected",on?"true":"false");button.tabIndex=on?0:-1;if(on&&focus)button.focus();}
      if(panel)panel.hidden=!on;
    }
    if(!skipHash&&activeTab==="system")syncHash();
  }
  // setTab was one CC-26 function mixing lazy per-tab data loads, the tab
  // button/area/secondary-rail paint loop, and sub-view/scroll bookkeeping.
  // Split the first two out (same call order as before); each keeps its
  // original logic verbatim, so behavior is unchanged.
  function tabLazyLoad(id){
    // Usage is LAZY (ADR-0009 §2): the index is only read once the tab is
    // actually opened, never on the shared status poll.
    if(id==="usage"&&!usageLoaded)loadUsage();
    if(id==="observability"&&window.AKLive)window.AKLive.activate();
    // System is lazy the same way, and lazier still: opening it reads the CHEAP
    // tier only (ADR-0025 §3). It never triggers a deep scan — a multi-second
    // walk on tab-open is exactly the hang the tiering exists to prevent.
    if(id==="system"&&!SYSTEM&&!systemBusy)loadSystem();
  }

  function paintTabButtons(id,focus){
    for(var i=0;i<TABS.length;i++){
      var t=TABS[i], on=(t===id);
      var btn=document.querySelector('[data-tab="'+t+'"]');
      if(btn){btn.setAttribute("aria-selected",on?"true":"false"); btn.tabIndex=on?0:-1; if(on&&focus)btn.focus();}
      var area=document.getElementById(AREAS[t]);
      if(area)area.hidden=!on;
      var secondary=document.getElementById("secondary-"+t);
      if(secondary)secondary.hidden=!on;
    }
  }

  export function setTab(id,focus,skipHash){
    if(TABS.indexOf(id)<0)return;
    if(activeTab==="observability"&&id!=="observability"&&window.AKLive)window.AKLive.deactivate();
    activeTab=id;
    try{localStorage.setItem(LS_TAB,id);}catch(e){}
    if(!skipHash)syncHash();
    tabLazyLoad(id);
    paintTabButtons(id,focus);
    if(id==="overview")setOverviewView(overviewView,false,true);
    if(id==="system")setSystemView(systemView,false,true);
    // Deliberately NOT scrolling here: at boot this runs before the directory
    // has rendered, so the section positions it would measure are the ones an
    // empty page has. renderAbout owns the one-shot scroll (aboutScrollPending).
    if(id==="about"&&aboutSection)aboutScrollPending=true;
    positionThumb();
    syncIntelStream();
  }
  var seg=document.getElementById("seg");
  if(seg){
    seg.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-tab]"):null;
      if(b)setTab(b.getAttribute("data-tab"));
    });
    seg.addEventListener("keydown",function(e){
      if(!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key))return;
      var i=TABS.indexOf(activeTab);
      i=e.key==="Home"?0:e.key==="End"?TABS.length-1:(i+(e.key==="ArrowRight"?1:TABS.length-1))%TABS.length;
      setTab(TABS[i],true); e.preventDefault();
    });
  }
  var overviewSeg=document.getElementById("overview-seg");
  if(overviewSeg){
    overviewSeg.addEventListener("click",function(e){var b=e.target.closest?e.target.closest("[data-overview-view]"):null;if(b)setOverviewView(b.getAttribute("data-overview-view"));});
    overviewSeg.addEventListener("keydown",function(e){if(!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key))return;var i=OVERVIEW_VIEWS.indexOf(overviewView);i=e.key==="Home"?0:e.key==="End"?OVERVIEW_VIEWS.length-1:(i+(e.key==="ArrowRight"?1:OVERVIEW_VIEWS.length-1))%OVERVIEW_VIEWS.length;setOverviewView(OVERVIEW_VIEWS[i],true);e.preventDefault();});
  }
  var systemSeg=document.getElementById("system-seg");
  if(systemSeg){
    systemSeg.addEventListener("click",function(e){var b=e.target.closest?e.target.closest("[data-system-view]"):null;if(b)setSystemView(b.getAttribute("data-system-view"));});
    systemSeg.addEventListener("keydown",function(e){if(!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key))return;var i=SYSTEM_VIEWS.indexOf(systemView);i=e.key==="Home"?0:e.key==="End"?SYSTEM_VIEWS.length-1:(i+(e.key==="ArrowRight"?1:SYSTEM_VIEWS.length-1))%SYSTEM_VIEWS.length;setSystemView(SYSTEM_VIEWS[i],true);e.preventDefault();});
  }
  // About sections are anchors, not sub-views: one continuous page, so the rail
  // scrolls rather than swapping panels. The click is intercepted so the hash
  // stays in the dashboard's own #tab/segment grammar instead of the browser
  // writing a bare fragment the router does not recognize.
  // The sticky tabbar and rail would otherwise cover the heading being scrolled
  // to; .ab-sec carries the scroll-margin-top that keeps it clear.
  export function scrollToAboutSection(){
    if(!aboutSection)return;
    var target=document.getElementById("ab-"+aboutSection);
    if(target&&target.scrollIntoView)target.scrollIntoView({block:"start",behavior:"auto"});
  }
  // A deep link into a section is a ONE-SHOT scroll that has to wait for the
  // cards to exist: the section headings are static markup, so before the
  // directory renders they are all stacked near the top and a scroll there
  // lands nowhere. renderAbout consumes this flag once — which is also what
  // stops the 30s status poll from yanking a reader back to the linked section.
  export var aboutScrollPending=!!aboutSection;
  var aboutAnchors=document.getElementById("about-anchors");
  if(aboutAnchors)aboutAnchors.addEventListener("click",function(e){
    var a=e.target.closest?e.target.closest("a[href]"):null;
    if(!a)return;
    e.preventDefault();
    var seg=String(a.getAttribute("href")||"").split("/")[1]||null;
    if(ABOUT_SECTIONS.indexOf(seg)<0)return;
    aboutSection=seg;
    if(activeTab!=="about")setTab("about");
    else syncHash();
    // The cards already exist by the time any anchor is clickable (renderAbout
    // runs at boot), so this scroll needs no deferral — unlike the deep-link
    // path, which fires while the page is still assembling itself.
    aboutScrollPending=false;
    scrollToAboutSection();
  });
  window.addEventListener("resize",positionThumb);
  var mapEl=document.getElementById("statusmap");
  if(mapEl)mapEl.addEventListener("click",function(e){
    var t=e.target.closest?e.target.closest("[data-go]"):null;
    if(t){setTab("overview");setOverviewView(t.getAttribute("data-go"));}
  });

  // severity rank for rollups + triage sort; preferred order breaks ties
  // (tables + functions from ./groups.mjs).
  export var RANK = {}; // PLACEHOLDER:RANK_JS
  var PREF = []; // PLACEHOLDER:PREF_JS

  export function groupRows(rows) { return RANK && PREF && rows; } // PLACEHOLDER:groupRows

  function rowLine(r) { return String(r); } // PLACEHOLDER:rowLine

  function groupCard(g) { return rowLine(g); } // PLACEHOLDER:groupCard

  export function gridHtml(groups) { return groupCard(groups); } // PLACEHOLDER:gridHtml
  export function stagger(el){
    var cards=el.querySelectorAll(".card");
    for(var i=0;i<cards.length;i++){cards[i].style.animationDelay=(i*40)+"ms";}
  }

