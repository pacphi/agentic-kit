import { CAT, RANK, PREF, esc, catOf, groupRows, rowLine, groupCard, gridHtml, noticeHtml } from './groups.mjs';
import { directoryEntries } from './about-directory.mjs';

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
// The About area's authored directory, serialized into the bundle rather than
// fetched: it is release-versioned editorial content, not machine state, so it
// ships with the page and needs no endpoint of its own (ADR-0026). Runtime
// facts arrive from the /api/status payload the dashboard already polls and are
// joined in the browser.
const ABOUT_JS = JSON.stringify(directoryEntries());

export const JS = `
(function(){
  "use strict";
  var root=document.documentElement;
  var LS="ak-dash-theme", LS_TAB="ak-dash-tab", LS_OVERVIEW="ak-dash-overview-view";
  var LS_SYSTEM="ak-dash-system-view", LS_ABOUT_NUDGE="ak-dash-about-nudge";

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

  // Intelligence project selection (machine-wide redesign, see server-side
  // dashboard-server.mjs's collectData()). selectedProjectKey starts null so
  // the very first /api/status and /api/live/intelligence requests omit
  // ?project= entirely and let the server apply ITS OWN default (the
  // most-recently-active discovered project) rather than the client guessing
  // at one — there is no "current project"/cwd concept on this side anymore.
  // Every later request carries the current selection explicitly.
  var intelProjects=[], selectedProjectKey=null, selectedProjectLabel=null, intelRequestSeq=0;

  ${esc.toString()}

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
  var SYSTEM_VIEWS=["summary","storage","runtime","catalog","projects"];
  var ABOUT_SECTIONS=["hosts","engine","quality","kit","configured"];
  var VIEWS=["score","limits","findings","sessions","transcript"];
  var CAT=${CAT_JS};
  ${catOf.toString()}

  var activeTab="overview", overviewView="summary", initialLiveScope="live";
  var usageView="score", usageSession=null, usageDays=14;
  var systemView="summary", aboutSection=null;
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
  function syncHash(){
    var hash="#"+activeTab;
    if(activeTab==="about")hash=aboutSection?"#about/"+aboutSection:"#about";
    else if(activeTab==="overview")hash=overviewHash();
    else if(activeTab==="usage")hash=usageHash();
    else if(activeTab==="system")hash="#system/"+systemView;
    else hash="#observability/"+(window.AKLive&&window.AKLive.state.scope||initialLiveScope);
    try{if(history.replaceState)history.replaceState(null,"",hash);}catch(e){}
  }

  function positionThumb(){
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
  function setSystemView(id,focus,skipHash){
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
  function setTab(id,focus,skipHash){
    if(TABS.indexOf(id)<0)return;
    if(activeTab==="observability"&&id!=="observability"&&window.AKLive)window.AKLive.deactivate();
    activeTab=id;
    try{localStorage.setItem(LS_TAB,id);}catch(e){}
    if(!skipHash)syncHash();
    // Usage is LAZY (ADR-0009 §2): the index is only read once the tab is
    // actually opened, never on the shared status poll.
    if(id==="usage"&&!usageLoaded)loadUsage();
    if(id==="observability"&&window.AKLive)window.AKLive.activate();
    // System is lazy the same way, and lazier still: opening it reads the CHEAP
    // tier only (ADR-0025 §3). It never triggers a deep scan — a multi-second
    // walk on tab-open is exactly the hang the tiering exists to prevent.
    if(id==="system"&&!SYSTEM&&!systemBusy)loadSystem();
    for(var i=0;i<TABS.length;i++){
      var t=TABS[i], on=(t===id);
      var btn=document.querySelector('[data-tab="'+t+'"]');
      if(btn){btn.setAttribute("aria-selected",on?"true":"false"); btn.tabIndex=on?0:-1; if(on&&focus)btn.focus();}
      var area=document.getElementById(AREAS[t]);
      if(area)area.hidden=!on;
      var secondary=document.getElementById("secondary-"+t);
      if(secondary)secondary.hidden=!on;
    }
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
  function scrollToAboutSection(){
    if(!aboutSection)return;
    var target=document.getElementById("ab-"+aboutSection);
    if(target&&target.scrollIntoView)target.scrollIntoView({block:"start",behavior:"auto"});
  }
  // A deep link into a section is a ONE-SHOT scroll that has to wait for the
  // cards to exist: the section headings are static markup, so before the
  // directory renders they are all stacked near the top and a scroll there
  // lands nowhere. renderAbout consumes this flag once — which is also what
  // stops the 30s status poll from yanking a reader back to the linked section.
  var aboutScrollPending=!!aboutSection;
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
    var affected=0,aggregateFail=false;
    for(var c in cats){
      var el=document.getElementById("badge-"+c);
      if(!el)continue;
      var f=0,w=0;
      for(var i=0;i<cats[c].length;i++){
        var L=cats[c][i].level;
        if(L==="fail")f++; else if(L==="warn")w++;
      }
      var n=f+w;
      if(n){affected++;if(f)aggregateFail=true;}
      if(!n){el.hidden=true;el.textContent="";el.removeAttribute("data-tone");}
      else{el.hidden=false;el.textContent=String(n);el.setAttribute("data-tone",f?"fail":"warn");}
    }
    var aggregate=document.getElementById("badge-overview");
    if(aggregate){aggregate.hidden=!affected;aggregate.textContent=affected?String(affected):"";aggregate.title=affected?affected+" Overview section"+(affected===1?"":"s")+" need attention":"";aggregate.setAttribute("aria-label",aggregate.title);if(affected)aggregate.setAttribute("data-tone",aggregateFail?"fail":"warn");else aggregate.removeAttribute("data-tone");}
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

    // ── neural pattern store: entries CURRENTLY on disk
    // (.claude-flow/neural/patterns.json), shipped un-bucketed — bucketed and
    // summed by day-of-creation here. A point-in-time inventory of the
    // store's live contents, NOT the same figure as the patternsLearned
    // lifetime counter charted above (that counter only ever climbs; this
    // store can be pruned/compacted). See intel-history.mjs's header comment.
    var byDay={},storeEntries=Array.isArray(data.patternStore)?data.patternStore:[];
    for(var j=0;j<storeEntries.length;j++){
      var entry=storeEntries[j];
      var day=entry&&typeof entry.createdAt==="string"?entry.createdAt.slice(0,10):null;
      if(!day)continue;
      byDay[day]=(byDay[day]||0)+1;
    }
    var days=Object.keys(byDay).sort();
    var storeSeries=[],storeTotal=0;
    for(var d=0;d<days.length;d++){storeTotal+=byDay[days[d]];storeSeries.push(storeTotal);}

    // ── reasoning graph: point-in-time size samples
    // (.claude-flow/data/intelligence-snapshot.json) — a structural-growth
    // series independent of the pattern-count metrics above.
    var graphArr=Array.isArray(data.graph)?data.graph:[];
    var nodesSeries=graphArr.map(function(g){return Number(g&&g.nodes)||0;});
    var lastGraph=graphArr.length?graphArr[graphArr.length-1]:null;

    // ── improvement eval: within-run learning curve (cold→warm accuracy at
    // each k-step checkpoint) — a different view of the SAME eval run the
    // Δpp scalar below summarizes; this is the trajectory that produced it.
    var imp=data.improvement||null;
    var curveArr=(imp&&Array.isArray(imp.curve))?imp.curve:[];
    var curveVals=curveArr.map(function(c){return Number(c&&c.acc)||0;});

    if(!pats.length&&!deltas.length&&!storeSeries.length&&!nodesSeries.length&&!curveVals.length){strip.hidden=true;return;}
    strip.hidden=false;
    note.textContent=(series.length?series.length+" samples":"snapshot")+(intelSource?" · live":"");

    document.getElementById("spark-patterns").innerHTML=pats.length>1?sparkline(pats):flat(pats.length?String(pats[0])+" (one sample)":"no data");

    document.getElementById("spark-pattern-store").innerHTML=storeSeries.length>1?sparkline(storeSeries):flat(storeSeries.length?String(storeTotal)+" entries (one day)":"no data");

    document.getElementById("spark-graph").innerHTML=nodesSeries.length>1?sparkline(nodesSeries):flat(nodesSeries.length?String(nodesSeries[0])+" nodes (one sample)":"no data");
    var graphMeta=document.getElementById("graph-meta");
    if(graphMeta)graphMeta.textContent=lastGraph?("latest: "+fmtNum(lastGraph.nodes)+" nodes · "+fmtNum(lastGraph.edges)+" edges"):"";

    document.getElementById("spark-delta").innerHTML=deltas.length>1?sparkline(deltas):flat(deltas.length?(deltas[0]>=0?"+":"")+deltas[0]+"pp (one sample)":"no data");
    var deltaMeta=document.getElementById("delta-meta");
    if(deltaMeta){
      var verdict=imp&&typeof imp.verdict==="string"?imp.verdict:null;
      var pVal=imp&&typeof imp.pValue==="number"?imp.pValue:null;
      var dVal=imp&&typeof imp.cohensD==="number"?imp.cohensD:null;
      if(!verdict&&pVal==null&&dVal==null){deltaMeta.hidden=true;deltaMeta.innerHTML="";}
      else{
        var lvl=verdict==="PASS"?"ok":"warn";
        var pTxt=pVal==null?"—":(pVal<0.001?"<.001":"="+pVal);
        var dTxt=dVal==null?"—":dVal.toFixed(2);
        deltaMeta.hidden=false;
        deltaMeta.innerHTML=(verdict?'<span class="pill" data-level="'+lvl+'"><span class="dot" data-level="'+lvl+'"></span><b>'+esc(verdict)+"</b></span>":"")
          +'<span class="mono" style="margin-left:8px;color:var(--ink-dim)">p'+esc(pTxt)+" · d="+esc(dTxt)+"</span>";
      }
    }

    document.getElementById("spark-curve").innerHTML=curveVals.length>1?sparkline(curveVals):flat(curveVals.length?(curveVals[0]*100).toFixed(0)+"% (one sample)":"no data");
  }

  // ── machine-wide Intelligence (ALWAYS visible) + project selection ──
  // intel.machineWide (from /api/status) is the full machine-wide rollup,
  // independent of whichever project is selected in the picker below it —
  // see render()'s wiring. Reuses the shared kpi()/esc()/fmtNum()/ago()
  // helpers (defined further down, but function declarations hoist) rather
  // than inventing a second vocabulary for stat tiles.
  function buildHistoryView(data){
    var intel=(data&&data.intel)||{};
    return {
      health:intel.health, globalStats:intel.globalStats,
      patternStore:intel.patternStore, graph:intel.graph,
      // "improvement" is a DIFFERENT, unchanged contract (the dashboard's own
      // launching-project .claude-flow/improvement.json — see
      // dashboard-server.mjs's own comment on this) — never project-selectable,
      // so it rides along unchanged rather than being pulled from intel.*.
      improvement:data&&data.improvement,
    };
  }

  function renderMachineWide(mw){
    var totals=(mw&&mw.totals)||{};
    var perProject=Array.isArray(mw&&mw.perProject)?mw.perProject.slice():[];
    var note=document.getElementById("mw-note");
    if(note)note.textContent=totals.projectCount
      ?(fmtNum(totals.projectCount)+" project"+(totals.projectCount===1?"":"s")+" tracked on this machine")
      :"no ruflo-initialized projects discovered on this machine";
    var hero=document.getElementById("mw-hero");
    if(hero)hero.innerHTML=
      kpi("patterns learned",fmtNum(totals.patternsLearnedLifetime),"lifetime &middot; every tracked project","")
      +kpi("projects tracked",fmtNum(totals.projectCount),"ruflo-initialized on this machine","")
      +kpi("most active project",totals.mostActiveProject||"—","by most recent learning adaptation","accent");
    perProject.sort(function(a,b){return (Number(b&&b.patternsLearned)||0)-(Number(a&&a.patternsLearned)||0);});
    var table=document.getElementById("mw-table");
    if(!table)return;
    if(!perProject.length){table.innerHTML='<div class="empty">no projects discovered on this machine.</div>';return;}
    var html='<div class="mw-row mw-head"><span>project</span><span class="mw-val">patterns learned</span>'
      +'<span class="mw-val">pattern store</span><span class="mw-val">last active</span></div>';
    for(var i=0;i<perProject.length;i++){
      var p=perProject[i]||{};
      var lastMs=Number(p.lastAdaptation)||0;
      var lastTxt=lastMs?ago(Math.max(0,Math.round((Date.now()-lastMs)/1000))):"—";
      html+='<div class="mw-row">'
        +'<span class="mw-name">'+esc(p.label||"(unlabeled)")+"</span>"
        +'<span class="mw-val mono">'+esc(fmtNum(p.patternsLearned))+"</span>"
        +'<span class="mw-val mono">'+esc(fmtNum(p.patternStoreCount))+"</span>"
        +'<span class="mw-val mono">'+esc(lastTxt)+"</span>"
      +"</div>";
    }
    table.innerHTML=html;
  }

  // The picker's option list AND its default selection come from the SAME
  // /api/status response as the machine-wide rollup above — no separate
  // fetch for the option list. selectedProjectKey/Label are only ADOPTED
  // from a response's own intel.selectedProjectKey/Label when they differ
  // from the current selection — a manual pick (wireIntelPicker) updates
  // both synchronously and intelRequestSeq (pollStatus) keeps a slow,
  // now-stale response from a previously selected project clobbering it.
  function renderProjectPicker(intel){
    intelProjects=Array.isArray(intel.projects)?intel.projects:[];
    if(intel.selectedProjectKey!==selectedProjectKey){
      selectedProjectKey=intel.selectedProjectKey;
      selectedProjectLabel=intel.selectedProjectLabel;
    }
    var note=document.getElementById("intel-picker-note");
    if(note)note.textContent=intelProjects.length
      ?(intelProjects.length+" project"+(intelProjects.length===1?"":"s")+" available")
      :"no projects discovered";
    var nameEl=document.getElementById("history-project-name");
    if(nameEl)nameEl.textContent=selectedProjectLabel||"—";
    var sel=document.getElementById("intel-project-select");
    if(!sel)return;
    if(!intelProjects.length){
      sel.innerHTML='<option value="">no projects discovered</option>';
      sel.disabled=true;
      return;
    }
    sel.disabled=false;
    sel.innerHTML=intelProjects.map(function(p){
      return '<option value="'+esc(p.key)+'"'+(p.key===selectedProjectKey?" selected":"")+'>'+esc(p.label)+"</option>";
    }).join("");
  }

  function wireIntelPicker(){
    var sel=document.getElementById("intel-project-select");
    if(!sel)return;
    sel.addEventListener("change",function(){
      var key=sel.value;
      if(!key||key===selectedProjectKey)return;
      var proj=null;
      for(var i=0;i<intelProjects.length;i++){if(intelProjects[i].key===key){proj=intelProjects[i];break;}}
      selectedProjectKey=key;
      selectedProjectLabel=proj?proj.label:null;
      var nameEl=document.getElementById("history-project-name");
      if(nameEl)nameEl.textContent=selectedProjectLabel||"—";
      // Same connect/reconnect/cleanup discipline as a tab switch
      // (syncIntelStream): tear down the stream watching the OLD project
      // before opening one for the newly selected project, so a client is
      // never subscribed to two projects' frames at once.
      closeIntelStream();
      syncIntelStream();
      pollStatus();
    });
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
      var escHtml=(r.escalation&&r.escalation.length)?'<span class="r-esc mono">↑ '+esc(r.escalation.join("→"))+"</span>":"";
      var primAttr=(r.host===primary)?' data-primary="1"':'';
      html+='<div class="r-row">'
        +'<span class="r-act mono">'+esc(r.activity)+tag+"</span>"
        +'<span class="r-host r-host-'+esc(r.host)+'"'+primAttr+' title="'+(r.host===primary?"primary host":"alternate host")+'">'+esc(r.host)+"</span>"
        +'<span class="r-model mono">'+esc(r.model)+"</span>"
        +'<span class="r-meta">'+escHtml+'<span class="r-src r-src-'+esc(r.provenance)+'">'+esc(r.provenance)+"</span></span>"
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

  // ── /api/live/intelligence (SSE) ── pushes fresh intel-history frames so the
  // Intelligence panel repaints immediately instead of waiting out the ~30s
  // poll tick. Mirrors live/client.mjs's openStream() for /api/live/events:
  // same dashSseUrl token-in-query-param bridge (EventSource cannot set
  // headers), same named-event addEventListener wiring, and no manual
  // reconnect loop — EventSource retries natively on error, same as there.
  function dashSseUrl(u){return DASH_TOKEN?u+(u.indexOf("?")<0?"?":"&")+"token="+encodeURIComponent(DASH_TOKEN):u;}
  var intelSource=null;
  function closeIntelStream(){
    if(intelSource){intelSource.close();intelSource=null;}
  }
  function receiveIntel(d){
    // readIntelHistory()'s own field names (healthRing) differ from
    // collectData()'s renamed "health" on /api/status's nested intel object —
    // reshape here, then funnel through the SAME renderHistory() (via
    // buildHistoryView) the poll path uses, so there is exactly one code path
    // for drawing the panel, not two. "improvement" isn't part of this
    // stream's payload, so whatever the last poll saw stays put. No project
    // check is needed here: the stream itself is already scoped to the
    // selected project via its own ?project=<key> URL (openIntelStream).
    if(!d||typeof d!=="object"||!LAST||!LAST.intel)return;
    LAST.intel.health=d.healthRing;
    LAST.intel.globalStats=d.globalStats;
    LAST.intel.patternStore=d.patternStore;
    LAST.intel.graph=d.graph;
    renderHistory(buildHistoryView(LAST));
  }
  function openIntelStream(){
    if(intelSource||!window.EventSource)return;
    // Same ?project=<key> contract as /api/status, resolved identically
    // server-side (resolveSelectedProject) — omitted entirely when no
    // selection is known yet, which defers to the server's own default
    // rather than the client guessing at one.
    var url="/api/live/intelligence"+(selectedProjectKey?"?project="+encodeURIComponent(selectedProjectKey):"");
    var src=new EventSource(dashSseUrl(url));
    intelSource=src;
    src.addEventListener("init",function(e){try{receiveIntel(JSON.parse(e.data));}catch(e){}});
    src.addEventListener("update",function(e){try{receiveIntel(JSON.parse(e.data));}catch(e){}});
    src.onerror=function(){}; // native retry — nothing else to do here, same as openStream()
  }
  // Connected only while the Intelligence view is actually visible, closed the
  // moment it isn't — the same "activate while shown, deactivate on hide"
  // discipline AKLive.activate()/deactivate() applies to the Observability tab.
  function syncIntelStream(){
    if(activeTab==="overview"&&overviewView==="intel")openIntelStream();
    else closeIntelStream();
  }

  function render(data){
    if(!data)return;
    LAST=data;
    renderVerdict(data.overall);
    renderNotice(data.drift);
    renderAbout(data);
    renderPanels(data.rows);
    renderMachineWide(data.intel&&data.intel.machineWide);
    renderProjectPicker(data.intel||{});
    renderHistory(buildHistoryView(data));
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

  // One pill per HOST, not per sourceHealth field: Codex carries two fields
  // (its transcript root, plus the thread ledger that corrects subagent-replay
  // token inflation) but is still one host, so the worse of the two drives the
  // pill's status and both stay reachable via the status side's tooltip.
  var SOURCE_HEALTH_GROUPS=[
    {host:"claude",label:"Claude",title:"Claude Code — ~/.claude/projects/**/*.jsonl",parts:[{key:"claude"}]},
    {host:"codex",label:"Codex",title:"Codex — ~/.codex/sessions/**/rollout-*.jsonl, plus Codex's own thread ledger",
      parts:[{key:"codex",sub:"transcripts"},{key:"codexLedger",sub:"ledger"}]},
    {host:"opencode",label:"OpenCode",title:"OpenCode — its SQLite session store",parts:[{key:"opencode"}]}
  ];
  var SOURCE_HEALTH_RANK={degraded:0,"not-read":1,absent:2,ok:3}; // lower sorts first = worse
  function sourceHealthRank(status){
    var r=SOURCE_HEALTH_RANK[status];
    return r===undefined?1:r;
  }
  // Same brand marks as the Observability Live view's hostIcon() (live/client.mjs)
  // — reused verbatim so a host reads as the same glyph everywhere in the
  // dashboard, not a second, subtly different icon set.
  function sourceHostIcon(host){
    var view="0 0 16 16",body;
    if(host==="claude")body='<path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"/>';
    else if(host==="codex"){
      view="146 227 268 267";
      body='<path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"/>';
    } else if(host==="opencode"){
      view="0 0 300 300";
      body='<g transform="translate(30 0)"><path d="M180 240H60V120H180V240Z" fill="#4B4646"/><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#F1ECEC" fill-rule="evenodd"/></g>';
    } else body='<path d="M3 8h10M8 3v10"/>';
    return'<svg class="live-host-icon" viewBox="'+view+'" focusable="false" aria-hidden="true" data-host="'+esc(host)+'">'+body+'</svg>';
  }

  function renderSourceHealth(health){
    var el=document.getElementById("u-source-health");
    if(!el)return;
    health=health||{};
    var pills=[];
    for(var g=0; g<SOURCE_HEALTH_GROUPS.length; g++){
      var grp=SOURCE_HEALTH_GROUPS[g],present=[];
      for(var p=0; p<grp.parts.length; p++){
        var part=grp.parts[p],item=health[part.key];
        if(item) present.push({status:String(item.status||"not-read"),reason:item.reason,sub:part.sub});
      }
      if(!present.length)continue;
      var lead=present.slice().sort(function(a,b){
        return sourceHealthRank(a.status)-sourceHealthRank(b.status);
      })[0];
      var detail=grp.label+": "+present.map(function(pt){
        var d=pt.status+(pt.reason?" · "+pt.reason:"");
        return pt.sub?pt.sub+": "+d:d;
      }).join(" · ");
      pills.push('<span class="source-pill" data-status="'+esc(lead.status)+'">'
        +'<span class="sp-icon live-host" data-host="'+esc(grp.host)+'" title="'+esc(grp.title)+'">'+sourceHostIcon(grp.host)+'</span>'
        +'<span class="sp-status" title="'+esc(detail)+'">'+esc(lead.status)+'</span>'
        +'</span>');
    }
    el.hidden=pills.length===0;
    el.innerHTML=pills.join("");
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
    var headings={score:["Usage scorecard","Token consumption, API-equivalent cost, efficiency, and trends."],limits:["Provider limits","Current provider windows, reset timing, and available capacity."],findings:["Usage findings","Actionable anomalies, efficiency opportunities, and evidence-backed recommendations."],sessions:["Session usage","Browse retained sessions by project, category, duration, tokens, and cost."],transcript:["Transcript detail","Inspect the selected session's locally retained, server-masked evidence."]},heading=headings[v]||headings.score;
    document.getElementById("usage-view-title").textContent=heading[0];document.getElementById("usage-view-description").textContent=heading[1];
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

  // Explicit bridge from Observability metadata to the separately fetched,
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

    // Host and inference-provider are independent canonical axes. All three
    // supported hosts always render (idle/grayed-out when a host has no
    // sessions in this window) rather than appearing/disappearing based on
    // setup state — the scorecard reflects observed transcript evidence, not
    // which ak setup --host flags were ever run.
    var prov=d.byHost||{};
    var order=["claude","codex","opencode"];
    for(k in prov)if(order.indexOf(k)<0)order.push(k);
    var PDOT_CLASS={claude:"c",codex:"x",opencode:"o"};
    var activeHosts=0;
    document.getElementById("u-hosts").innerHTML=order.map(function(name){
      var v=prov[name], cost=fld(v,"cost"), sess=fld(v,"sessions"), tok=fld(v,"tokens");
      var idle=!sess&&!cost;
      if(!idle)activeHosts++;
      return '<div class="pcard'+(idle?" idle":"")+'"><div class="ph"><span class="pdot '
        +(PDOT_CLASS[name]||"c")+'"></span>'+esc(name)+"</div>"
        +'<div class="pv mono">'+esc(fmtUsd(cost))+"</div>"
        +'<div class="pl">'+(idle?"no sessions in window":esc(fmtNum(sess))+" sessions &middot; "+esc(fmtTok(tok))+" tokens")+"</div></div>";
    }).join("");
    var hostsNoteEl=document.getElementById("u-hosts-note");
    if(hostsNoteEl)hostsNoteEl.textContent=activeHosts+" active of "+order.length;

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
  function reportedIdentity(v){v=String(v==null?"":v).trim();return v&&!/^unknown$/i.test(v)?v:null;}
  function identityName(v){var raw=reportedIdentity(v);if(!raw)return"Not recorded";return{claude:"Claude Code",codex:"Codex",opencode:"OpenCode",anthropic:"Anthropic",openai:"OpenAI",openrouter:"OpenRouter",bedrock:"AWS Bedrock",vertex:"Google Vertex AI",foundry:"Microsoft Foundry",gateway:"Custom gateway",ollama:"Ollama",lmstudio:"LM Studio"}[raw.toLowerCase()]||raw;}

  /* The ten fields that shipped on the wire and rendered nowhere. Everything
     here comes from the row the browser already holds — no route, no fetch. */
  function sdetail(sx){
    // basis is a STRING contract. Only null/empty falls back, so a non-string
    // still renders as itself and trips the harness's [object Object] net —
    // coercing it here would hide exactly the bug the net exists to catch.
    var basis=(sx.basis==null||sx.basis==="")?"no signal":sx.basis;
    var conf=(typeof sx.confidence==="number")
      ? ' <span class="sd-conf">(conf '+esc(sx.confidence.toFixed(2))+")</span>" : "";
    var modelList=(Array.isArray(sx.models)?sx.models:[]).filter(function(model){return reportedIdentity(model);});
    var models=modelList.length?modelList.join(", "):"Not recorded";
    var providerRaw=reportedIdentity(sx.provider),provider=identityName(providerRaw),provenance=reportedIdentity(sx.providerProvenance)||"unknown",providerContext=providerRaw?provenance+" evidence":"not established by source";
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
    var rows=[["execution host",esc(identityName(sx.host))],["inference provider",esc(provider)+" <span class='sd-conf'>("+esc(providerContext)+")</span>"],["models",esc(models)],["basis",esc(basis)+conf],["tokens",esc(toks)],
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
    var host=reportedIdentity(sx.host)||"unknown";
    var provider=reportedIdentity(sx.provider);
    var modelList=(Array.isArray(sx.models)?sx.models:[]).filter(function(model){return reportedIdentity(model);});
    var identityTip="Execution host: "+identityName(host)+" · Inference provider: "+identityName(provider)+" · Model: "+(modelList.length?modelList.join(", "):"Not recorded");
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
        +' title="show identity, model, usage, and classification details" aria-label="show identity, model, usage, and classification details">&rsaquo;</button>'
      +'<span class="s-host s-'+esc(host)+'" title="'+esc(identityTip)+'" aria-label="Execution host: '+esc(identityName(host))+'">'+esc(identityName(host))+"</span>"
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
      renderSourceHealth(null);
      document.getElementById("u-hero").innerHTML='<div class="empty">'+esc(USAGE.error)+"</div>";
      return;
    }
    renderSourceHealth(USAGE.sourceHealth);
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
    if(seg)seg.addEventListener("keydown",function(e){if(!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key))return;var i=VIEWS.indexOf(usageView);i=e.key==="Home"?0:e.key==="End"?VIEWS.length-1:(i+(e.key==="ArrowRight"?1:VIEWS.length-1))%VIEWS.length;setUsageView(VIEWS[i]);var b=seg.querySelector('[data-view="'+VIEWS[i]+'"]');if(b)b.focus();e.preventDefault();});
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

  // ══ About area (ADR-0026) ══════════════════════════════════════════════════
  // Editorial content comes from the versioned directory below; runtime facts
  // come from the /api/status payload this file already polls. No endpoint, no
  // second fetch — the join happens here, and its absence is rendered, not
  // hidden.
  var ABOUT=${ABOUT_JS};

  // Directory category -> the page section that carries it. Quality, Safety and
  // Knowledge are three one-card categories that read as one cluster, so they
  // share a section; the directory keeps them distinct because they are
  // distinct concerns, and the page groups them because they scan better that way.
  var ABOUT_SECTION_OF={hosts:"hosts","engine-memory":"engine",quality:"quality",
    safety:"quality",knowledge:"quality",kit:"kit",configured:"configured"};

  // Which \`ak status\` rows are unambiguously ABOUT a given component.
  //   host      one host id inside the shared "hosts" subsystem, matched on the
  //             row's leading word (those rows are "<host> …" by construction).
  //   versions  one package inside the shared "versions" subsystem, matched the
  //             same way, because that subsystem carries every managed package.
  //   subs      whole subsystems that belong to this component alone.
  // A component with NO entry here — or one whose rows are simply absent from
  // this payload — degrades to "state unknown". That is the honest reading: an
  // unjoined key is an unmeasured fact, never a satisfied one. The permission
  // allowlist is the standing example: ak emits no permissions row today.
  var ABOUT_JOIN={
    "hosts.claude":{host:"claude"},
    "hosts.codex":{host:"codex"},
    "hosts.opencode":{host:"opencode"},
    "ruflo":{versions:"ruflo"},
    "agentdb":{subs:["agentdb"]},
    "agentic-qe":{subs:["aqe"],versions:"agentic-qe"},
    "security":{subs:["security"]},
    "ruvnet-brain":{subs:["ruvnet-brain"]},
    "self":{subs:["self"]},
    "mcp":{subs:["mcp","codex-mcp"]},
    "blocks":{subs:["blocks"]},
    // Two statusline surfaces, one card: the worst of the pair drives the chip,
    // or Codex's line could be broken while the card reads green.
    "statusline":{subs:["statusline","codex-statusline"]},
    "routing":{subs:["routing"]},
    "daemons":{subs:["daemons"]}
  };
  var ABOUT_WORD={ok:"installed",warn:"needs attention",fail:"not working"};
  var ABOUT_WORD_CONF={ok:"configured",warn:"needs attention",fail:"not working"};

  function aboutLead(msg,word){
    return String(msg||"").toLowerCase().indexOf(String(word).toLowerCase()+" ")===0;
  }
  function aboutRows(rows,join){
    var out=[];
    for(var i=0;i<rows.length;i++){
      var r=rows[i]||{},sub=r.subsystem;
      if(join.host&&sub==="hosts"&&aboutLead(r.message,join.host))out.push(r);
      else if(join.versions&&sub==="versions"&&aboutLead(r.message,join.versions))out.push(r);
      else if(join.subs&&join.subs.indexOf(sub)>=0)out.push(r);
    }
    return out;
  }
  function aboutState(entry,data){
    var configured=entry.category==="configured";
    if(!data||!Array.isArray(data.rows))
      return {state:"unknown",word:"state unknown",title:"the dashboard could not read /api/status",detail:null};
    var join=ABOUT_JOIN[entry.detectionKey||entry.subsystem||""];
    if(!join)
      return {state:"unknown",word:"state unknown",title:"ak status reports no row for this surface yet",detail:null};
    var rows=aboutRows(data.rows,join);
    if(!rows.length)
      return {state:"unknown",word:"state unknown",title:"no ak status row reported this on this machine",detail:null};
    var level="info",worst=null,titles=rows.map(function(r){return r.level+": "+r.message;}).join(" \\u00b7 ");
    for(var i=0;i<rows.length;i++){
      if((RANK[rows[i].level]||0)>=(RANK[level]||0)&&rows[i].level!=="info"){level=rows[i].level;worst=rows[i];}
    }
    // Only info rows means the subsystem stated a fact without a verdict — it
    // told us something, but not that this component is working. Claiming
    // "installed" from that would be inventing the one thing we were not told.
    if(level==="info")return {state:"unknown",word:"state unknown",title:titles,detail:null};
    var state=(level==="warn"||level==="fail")?level:(configured?"configured":"ok");
    var word=(configured?ABOUT_WORD_CONF:ABOUT_WORD)[level==="warn"||level==="fail"?level:"ok"];
    return {
      state:state,word:word,title:titles,
      // Only a problem earns a line of its own on the card; a healthy component
      // says so in four words and gets out of the way.
      detail:(worst&&(level==="warn"||level==="fail"))?worst:null
    };
  }
  // The version chip's fact source is the drift array /api/status already
  // carries, keyed by package name. A component with no drift entry (Claude
  // Code is externally installed; aidefence ships inside ruflo) shows its state
  // WITHOUT a version rather than a version scraped out of prose.
  function aboutVersion(entry,data){
    if(!entry.npmPackage||!data||!Array.isArray(data.drift))return null;
    for(var i=0;i<data.drift.length;i++){
      var d=data.drift[i];
      if(d&&d.pkg===entry.npmPackage&&d.installed)return d;
    }
    return null;
  }
  function aboutVerLabel(v){
    v=String(v==null?"":v);
    return /^v/i.test(v)?v:"v"+v;
  }
  function aboutTile(icon){
    if(icon&&icon.kind==="official")
      return '<span class="ab-tile" data-mark="'+esc(icon.ref)+'" aria-hidden="true">'+sourceHostIcon(icon.ref)+"</span>";
    // The hue is a token NAME chosen by the directory, never a colour value —
    // the pattern test is what keeps it that way if the directory ever grows.
    var hue=(icon&&/^--[a-z-]+$/.test(String(icon.hue||"")))?icon.hue:"--info";
    return '<span class="ab-tile ab-mg" style="background:var('+hue+')" aria-hidden="true">'
      +esc((icon&&icon.ref)||"?")+"</span>";
  }
  function aboutCard(entry,data){
    var st=aboutState(entry,data),ver=aboutVersion(entry,data);
    // Release-tagged tools (the Brain) already record their leading "v"; npm
    // packages do not. Prefixing unconditionally produced "vv4.0.7".
    var chipText=st.word+(ver?" \\u00b7 "+aboutVerLabel(ver.installed):"");
    var detail="";
    if(st.detail){
      detail='<p class="ab-detail" data-level="'+esc(st.detail.level)+'">'+esc(st.detail.message)
        +(st.detail.fix?' <code>'+esc(st.detail.fix)+"</code>":"")+"</p>";
    }else if(ver&&ver.outdated&&ver.latest){
      detail='<p class="ab-detail">update available \\u2014 '+esc(aboutVerLabel(ver.latest))+' <code>ak sync</code></p>';
    }
    var tail="";
    if(entry.links&&entry.links.length){
      tail='<div class="ab-links">'+entry.links.map(function(l){
        // https only, and outbound only: these are plain anchors the reader
        // clicks. Nothing on this page ever fetches them (ADR-0025/0026's
        // zero-egress line), which is why there is no preview, no favicon,
        // and no link check in the browser.
        if(!l||!/^https:\\/\\//.test(String(l.url||"")))return "";
        return '<a class="ab-pill" href="'+esc(l.url)+'" target="_blank" rel="noreferrer noopener">'
          +esc(l.label)+" &#8599;</a>";
      }).join("")+"</div>";
    }else if(entry.manage){
      tail='<div class="ab-manage">manage: '+esc(entry.manage)+"</div>";
    }
    return '<article class="ab-card'+(entry.category==="kit"?" ab-wide":"")+'">'
      +'<div class="ab-head">'+aboutTile(entry.icon)
      +'<span class="ab-name"><b>'+esc(entry.name)+"</b>"
      +'<span class="ab-state" data-state="'+esc(st.state)+'" title="'+esc(st.title)+'">'+esc(chipText)+"</span>"
      +"</span></div>"
      +'<span class="ab-tagline">'+esc(entry.tagline)+"</span>"
      +'<p class="ab-body">'+esc(entry.paragraph)+"</p>"
      +detail+tail
    +"</article>";
  }
  function renderAbout(data){
    var buckets={},i,entry,section;
    for(i=0;i<ABOUT_SECTIONS.length;i++)buckets[ABOUT_SECTIONS[i]]=[];
    var packaged=0,configured=0,detected=0,joined=false;
    for(i=0;i<ABOUT.length;i++){
      entry=ABOUT[i];
      section=ABOUT_SECTION_OF[entry.category];
      if(!buckets[section])continue;
      buckets[section].push(aboutCard(entry,data));
      if(entry.category==="configured")configured++;
      else{
        packaged++;
        var st=aboutState(entry,data);
        if(st.state!=="unknown")joined=true;
        if(st.state==="ok")detected++;
      }
    }
    for(i=0;i<ABOUT_SECTIONS.length;i++){
      var el=document.getElementById("ab-cards-"+ABOUT_SECTIONS[i]);
      if(el)el.innerHTML=buckets[ABOUT_SECTIONS[i]].join("");
    }
    var lede=document.getElementById("ab-hero-lede");
    if(lede){
      // Counts describe the DIRECTORY (what ak manages), which is a release
      // fact and true on any machine. Per-component state lives on each card's
      // own chip; an aggregate tally here would just restate it less precisely.
      lede.innerHTML="agentic-kit manages <b>"+packaged+" components</b> and <b>"+configured
        +" configurations</b>. This page says what each one is, in plain words \\u2014 and where to "
        +"read more. Health lives in Overview, spend in Usage, activity in Observability; here, "
        +"everything just introduces itself.";
    }
    if(aboutScrollPending&&activeTab==="about"){aboutScrollPending=false;scrollToAboutSection();}
  }

  // The first-run nudge. Overview stays the landing view; this points at About
  // once and remembers being dismissed, in the same localStorage the poll and
  // theme preferences use. Opening About counts as dismissing it: the tip has
  // done its job and should not greet a returning reader.
  function aboutNudgeDismissed(){
    try{return localStorage.getItem(LS_ABOUT_NUDGE)==="1";}catch(e){return false;}
  }
  function dismissAboutNudge(){
    try{localStorage.setItem(LS_ABOUT_NUDGE,"1");}catch(e){}
    var el=document.getElementById("about-nudge");
    if(el)el.hidden=true;
  }
  function wireAboutNudge(){
    var el=document.getElementById("about-nudge");
    if(el&&!aboutNudgeDismissed()&&activeTab!=="about")el.hidden=false;
    var go=document.getElementById("about-nudge-go");
    if(go)go.addEventListener("click",function(){dismissAboutNudge();setTab("about");});
    var x=document.getElementById("about-nudge-x");
    if(x)x.addEventListener("click",dismissAboutNudge);
  }

  // ══ System area (ADR-0025) ════════════════════════════════════════════════
  // One payload (GET /api/system), five sub-views. The cheap tier arrives on
  // open; the deep tier is whatever the last user-triggered scan measured,
  // carried forward with ITS timestamp. Nothing here ever renders an unmeasured
  // quantity as 0 — mhtml() has no code path that can.
  var SYSTEM=null, systemBusy=false, systemPollTimer=null;

  // ── Measurement vocabulary (walk.mjs's, read-side) ──
  function mval(m){return m&&typeof m.value==="number"&&isFinite(m.value)?m.value:null;}
  function unkHtml(reason,never){
    return '<span class="sy-unk" title="'+esc(reason||"not measured")+'">'
      +(never?"not measured yet":"unavailable")+"</span>";
  }
  // The ONLY renderer for a Measurement. A missing field is "not measured yet"
  // (the deep tier has never run); a failed one is "unavailable" with its
  // reason on hover; a capped or partially-degraded one is prefixed with a
  // "at least" sign, because those figures are floors and a bare total would
  // read as a ceiling.
  function mhtml(m,fmt){
    if(!m||typeof m!=="object")return unkHtml("this section has not been deep-scanned yet",true);
    if(m.status==="unknown"||m.value==null)return unkHtml(m.reason,false);
    return (m.partial?"&#8805;&#8239;":"")+esc((fmt||fmtNum)(m.value));
  }
  function fmtBytes(n){
    n=Number(n)||0;
    var abs=Math.abs(n);
    if(abs>=1e12)return (n/1e12).toFixed(2)+" TB";
    if(abs>=1e9)return (n/1e9).toFixed(2)+" GB";
    if(abs>=1e6)return (n/1e6).toFixed(1)+" MB";
    if(abs>=1e3)return (n/1e3).toFixed(0)+" KB";
    return Math.round(n)+" B";
  }
  function bytesPair(n){
    n=Number(n)||0;
    var abs=Math.abs(n);
    if(abs>=1e12)return {n:(n/1e12).toFixed(2),u:"TB"};
    if(abs>=1e9)return {n:(n/1e9).toFixed(2),u:"GB"};
    if(abs>=1e6)return {n:(n/1e6).toFixed(1),u:"MB"};
    if(abs>=1e3)return {n:(n/1e3).toFixed(0),u:"KB"};
    return {n:String(Math.round(n)),u:"B"};
  }
  function fmtDur(ms){
    ms=Number(ms)||0;
    var m=Math.floor(ms/60000),h=Math.floor(m/60);
    if(h>=24)return Math.floor(h/24)+"d "+(h%24)+"h";
    return h?(h+"h "+(m%60)+"m"):(m+"m");
  }
  // Series tokens are chosen from a fixed set — never interpolated from data —
  // so nothing in a payload can reach a style attribute as a colour.
  var SERIES=["var(--s1)","var(--s2)","var(--s3)","var(--s4)"];
  var HOST_SERIES={claude:"var(--s1)",codex:"var(--s2)",opencode:"var(--s3)"};
  var CAT_SERIES={transcripts:"var(--s1)","ledgers-and-logs":"var(--s2)",
    "learning-stores":"var(--s3)","kit-caches":"var(--s4)"};
  // The catalog's kind ids are wire identifiers; these are what a reader sees.
  // An unknown future kind falls through as its own id rather than vanishing.
  var KIND_LABEL={skill:"skills",agent:"agents",command:"commands",plugin:"plugins",mcpServer:"MCP"};
  var KIND_PLURAL={skill:"skills",agent:"agents",command:"commands",plugin:"plugins",mcpServer:"MCP servers"};
  function hostColor(h){return HOST_SERIES[h]||"var(--dim)";}
  function catColor(k){return CAT_SERIES[k]||"var(--dim)";}
  function sysEmpty(msg){return '<div class="empty">'+esc(msg)+"</div>";}
  var NOT_SCANNED="not measured yet \\u2014 press Rescan to run a deep scan.";

  // ── odometer readout ──
  // Each digit rolls from 0 to its target. Under prefers-reduced-motion the
  // page-wide transition kill makes the same code paint the final value at once.
  function mountOdometers(root){
    var els=(root||document).querySelectorAll(".od[data-od]");
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el.getAttribute("data-mounted")==="1")continue;
      el.setAttribute("data-mounted","1");
      var s=String(el.getAttribute("data-od")||""),html="",c,d;
      for(c=0;c<s.length;c++){
        var ch=s.charAt(c);
        if(ch>="0"&&ch<="9"){
          html+='<span class="dcol"><span class="dstack" data-d="'+ch+'">';
          for(d=0;d<=9;d++)html+="<span>"+d+"</span>";
          html+="</span></span>";
        }else html+='<span class="lit">'+esc(ch)+"</span>";
      }
      el.innerHTML=html;
      (function(node){
        var stacks=node.querySelectorAll(".dstack");
        var apply=function(){
          for(var k=0;k<stacks.length;k++)
            stacks[k].style.transform="translateY("+(-34*Number(stacks[k].getAttribute("data-d")))+"px)";
        };
        if(window.requestAnimationFrame)requestAnimationFrame(function(){requestAnimationFrame(apply);});
        else apply();
      })(el);
    }
  }
  function kpiCard(label,valueHtml,sub){
    return '<div class="sy-kpi"><span class="lbl">'+esc(label)+"</span>"
      +'<div class="val">'+valueHtml+"</div>"
      +'<div class="sub">'+sub+"</div></div>";
  }
  function odBytes(m){
    if(!m||m.status==="unknown"||m.value==null)return mhtml(m,fmtBytes);
    var p=bytesPair(m.value);
    return (m.partial?'<span class="unit">&#8805;</span>':"")
      +'<span class="od" data-od="'+esc(p.n)+'"></span><span class="unit">'+p.u+"</span>";
  }
  function odCount(m){
    if(!m||m.status==="unknown"||m.value==null)return mhtml(m);
    return (m.partial?'<span class="unit">&#8805;</span>':"")
      +'<span class="od" data-od="'+esc(String(Math.round(m.value)))+'"></span>';
  }

  // ── charts (inline SVG, built from the payload; no image, no remote asset) ──
  function gaugePoint(f){
    var a=Math.PI*(1-f);
    return [(110+88*Math.cos(a)).toFixed(2),(118-88*Math.sin(a)).toFixed(2)];
  }
  function gaugeArc(f){
    var s=gaugePoint(0),e=gaugePoint(Math.max(0,Math.min(1,f)));
    return "M "+s[0]+" "+s[1]+" A 88 88 0 0 1 "+e[0]+" "+e[1];
  }
  function svgGauge(usedBytes,totalBytes,freeBytes,caption){
    var f=(totalBytes>0)?Math.max(0,Math.min(1,usedBytes/totalBytes)):0;
    // A share small enough to be invisible as an arc is still a real answer, so
    // the share is ALWAYS stated as a number. The arc is never padded up to a
    // visible minimum: overdrawing a 0.2% slice to make it look like something
    // would be a picture that disagrees with its own caption.
    var share=(f*100)<0.1?"<0.1%":(f*100).toFixed(f<0.1?1:0)+"%";
    return '<svg viewBox="0 0 220 152" role="img" aria-label="'+esc(caption)+'">'
      +'<path d="'+gaugeArc(1)+'" fill="none" stroke="var(--panel-2)" stroke-width="16" stroke-linecap="round"/>'
      +(f>0.004?'<path d="'+gaugeArc(f)+'" fill="none" stroke="var(--accent)" stroke-width="16" stroke-linecap="round"><title>'
        +esc(fmtBytes(usedBytes)+" \\u00b7 toolchain")+"</title></path>":"")
      +'<text class="big" text-anchor="middle" x="110" y="100">'+esc(fmtBytes(usedBytes))+"</text>"
      +'<text text-anchor="middle" x="110" y="118">'+esc(share)+" of a "+esc(fmtBytes(totalBytes))+" disk</text>"
      +'<text text-anchor="middle" x="110" y="134">'+esc(fmtBytes(freeBytes))+" free</text>"
    +"</svg>";
  }
  function svgDonut(slices,total,unit){
    var C=2*Math.PI*56,off=0,arcs="";
    for(var i=0;i<slices.length;i++){
      var frac=total>0?(slices[i].value/total):0,len=C*frac;
      arcs+='<circle r="56" fill="none" stroke="'+slices[i].color+'" stroke-width="20" '
        +'stroke-dasharray="'+len.toFixed(2)+" "+(C-len).toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)+'">'
        +"<title>"+esc(slices[i].label+" \\u00b7 "+fmtBytes(slices[i].value))+"</title></circle>";
      off+=len;
    }
    var p=bytesPair(total);
    return '<svg viewBox="0 0 150 150" width="150" role="img" aria-label="'+esc(unit)+'">'
      +'<g transform="translate(75 75) rotate(-90)">'+arcs+"</g>"
      +'<text class="big" text-anchor="middle" x="75" y="72">'+esc(p.n)+"</text>"
      +'<text text-anchor="middle" x="75" y="88">'+esc(p.u+" retained")+"</text>"
    +"</svg>";
  }
  function svgArea(values,color,label){
    if(!values.length)return sysEmpty("no days measured");
    var W=180,H=54,max=Math.max.apply(null,values)||1,pts=[],i;
    for(i=0;i<values.length;i++){
      var x=values.length===1?W:(i/(values.length-1))*W;
      var y=H-4-(values[i]/max)*(H-10);
      pts.push(x.toFixed(1)+","+y.toFixed(1));
    }
    var line=pts.join(" "),last=pts[pts.length-1].split(",");
    return '<svg viewBox="0 0 180 54" role="img" aria-label="'+esc(label)+'">'
      +'<polyline class="gridline" points="0,53 180,53"/>'
      +'<polygon fill="'+color+'" opacity=".18" points="'+line+' 180,53 0,53"/>'
      +'<polyline fill="none" stroke="'+color+'" stroke-width="2" points="'+line+'"/>'
      +'<circle cx="'+last[0]+'" cy="'+last[1]+'" r="3" fill="'+color+'"/>'
      +"<title>"+esc(label)+"</title>"
    +"</svg>";
  }
  // Geometry constants, not magic numbers: the plot radius is what the data
  // occupies and the label radius is outside it, both chosen so the widest
  // label ("commands") still fits inside the viewBox at either flank.
  var RADAR={cx:150,cy:142,r:90,label:112};
  function radarPoint(axis,axes,r){
    var a=-Math.PI/2+(2*Math.PI*axis)/axes;
    return [(RADAR.cx+r*Math.cos(a)).toFixed(1),(RADAR.cy+r*Math.sin(a)).toFixed(1)];
  }
  function radarRing(axes,r){
    var pts=[];
    for(var i=0;i<axes;i++)pts.push(radarPoint(i,axes,r).join(","));
    return pts.join(" ");
  }
  function svgRadar(axes,series){
    if(!axes.length||!series.length)return sysEmpty("nothing measured to compare");
    var n=axes.length,g="",i,j;
    for(i=1;i<=4;i++)g+='<polygon class="gridline" points="'+radarRing(n,(RADAR.r/4)*i)+'"/>';
    for(i=0;i<n;i++){
      var tip=radarPoint(i,n,RADAR.r);
      g+='<line class="gridline" x1="'+RADAR.cx+'" y1="'+RADAR.cy+'" x2="'+tip[0]+'" y2="'+tip[1]+'"/>';
    }
    for(i=0;i<series.length;i++){
      var pts=[];
      for(j=0;j<n;j++){
        var mx=axes[j].max||0,v=series[i].values[j];
        pts.push(radarPoint(j,n,mx>0&&v!=null?(v/mx)*RADAR.r:0).join(","));
      }
      g+='<polygon fill="'+series[i].color+'" opacity=".14" stroke="'+series[i].color
        +'" stroke-width="2" points="'+pts.join(" ")+'"><title>'+esc(series[i].tip)+"</title></polygon>";
    }
    for(i=0;i<n;i++){
      var lp=radarPoint(i,n,RADAR.label);
      var dx=Number(lp[0])-RADAR.cx;
      var anchor=dx>6?"start":(dx<-6?"end":"middle");
      g+='<text x="'+lp[0]+'" y="'+lp[1]+'" text-anchor="'+anchor+'" dominant-baseline="middle">'
        +esc(axes[i].label)+"</text>";
    }
    return '<svg viewBox="0 0 300 274" role="img" aria-label="per-host inventory profile, each axis normalized to its own maximum">'+g+"</svg>";
  }

  // ── data shaping ──
  function storageHostTotals(storage){
    var totals={},cats=(storage&&storage.categories)||[],i,j;
    for(i=0;i<cats.length;i++){
      var kids=cats[i].children||[];
      for(j=0;j<kids.length;j++){
        var v=mval(kids[j].bytes);
        if(v==null)continue;
        totals[kids[j].key]=(totals[kids[j].key]||0)+v;
      }
    }
    return totals;
  }
  function topConsumers(d,limit){
    var rows=[],i,j;
    var cats=(d.storage&&d.storage.categories)||[];
    for(i=0;i<cats.length;i++){
      var kids=cats[i].children||[];
      for(j=0;j<kids.length;j++){
        var v=mval(kids[j].bytes);
        if(v==null||v<=0)continue;
        rows.push({label:kids[j].key+" "+cats[i].key,bytes:v,color:hostColor(kids[j].host||kids[j].key)});
      }
    }
    var tools=(d.install&&d.install.tools)||[];
    for(i=0;i<tools.length;i++){
      var tb=mval(tools[i].bytes);
      if(tb!=null&&tb>0)rows.push({label:tools[i].label+" install tree",bytes:tb,color:"var(--dim)"});
    }
    var caches=(d.install&&d.install.sharedCaches)||[];
    for(i=0;i<caches.length;i++){
      var cb=mval(caches[i].bytes);
      if(cb!=null&&cb>0)rows.push({label:caches[i].label,bytes:cb,color:"var(--dim)"});
    }
    rows.sort(function(a,b){return b.bytes-a.bytes;});
    return rows.slice(0,limit||6);
  }
  // Lines of code across the catalog. Projects whose count is unmeasured are
  // EXCLUDED from the sum and named in the caption, so the total is an honest
  // floor over the projects that were counted rather than a figure that
  // silently treats an unreadable project as containing no code.
  function locSummary(projects){
    if(!projects)return unkHtml("projects have not been deep-scanned yet",true)+" lines";
    var list=projects.projects||[],total=0,counted=0,i;
    for(i=0;i<list.length;i++){
      var v=mval(list[i].loc&&list[i].loc.total);
      if(v==null)continue;
      total+=v; counted++;
    }
    if(!counted)return unkHtml("no project reported a line count",false)+" lines";
    return "&#8776;"+esc(fmtTok(total))+" lines across "+counted+" of "+list.length
      +(projects.truncated?" \\u00b7 catalog truncated":"");
  }
  function rankedBars(rows){
    if(!rows.length)return sysEmpty(NOT_SCANNED);
    var max=rows[0].bytes||1,html="",i;
    for(i=0;i<rows.length;i++){
      html+='<div class="sy-bar"><span class="n" title="'+esc(rows[i].label)+'">'+esc(rows[i].label)+"</span>"
        +'<div class="sy-track"><i class="sy-fill" style="width:'+Math.max(1,(rows[i].bytes/max)*100).toFixed(1)
        +"%;background:"+rows[i].color+'"></i></div>'
        +'<span class="v">'+esc(fmtBytes(rows[i].bytes))+"</span></div>";
    }
    return '<div class="sy-bars">'+html+"</div>";
  }

  // ── views ──
  function renderSysSummary(d){
    var install=d.install,storage=d.storage,catalog=d.catalog,projects=d.projects;
    var rt=d.runtime||{},totals=rt.totals||{},machine=rt.machine||{};
    var kpis=document.getElementById("sys-kpis");
    if(kpis){
      var counts=(catalog&&catalog.counts)||{};
      kpis.innerHTML=
        kpiCard("install footprint",odBytes(install&&install.totals&&install.totals.installBytes),
          mhtml(install&&install.totals&&install.totals.toolsPresent)+" managed tools \\u00b7 "
          +mhtml(install&&install.totals&&install.totals.nativeAddons)+" native addons")
        +kpiCard("data retained",odBytes(storage&&storage.totals&&storage.totals.bytes),
          "transcripts, ledgers, stores, caches")
        +kpiCard("live processes",odCount(totals.processCount),
          mhtml(totals.rssBytes,fmtBytes)+" resident \\u00b7 "
          +mhtml(totals.cpuPercent,function(v){return v.toFixed(1)+"%";})+" CPU combined")
        +kpiCard("projects",odCount(projects&&projects.count),locSummary(projects))
        +kpiCard("catalog",odCount(counts.skill),
          "skills \\u00b7 "+mhtml(counts.agent)+" agents \\u00b7 "+mhtml(counts.command)+" commands");
      mountOdometers(kpis);
    }
    var gauge=document.getElementById("sys-gauge");
    if(gauge){
      var disk=(install&&install.disk)||null;
      var total=mval(disk&&disk.totalBytes),free=mval(disk&&disk.freeBytes);
      var used=mval(install&&install.totals&&install.totals.installBytes),data=mval(storage&&storage.totals&&storage.totals.bytes);
      if(total==null||used==null||data==null){
        gauge.innerHTML=sysEmpty(install?"the disk denominator needs install and storage figures; at least one is unmeasured.":NOT_SCANNED);
      }else{
        gauge.innerHTML=svgGauge(used+data,total,free==null?0:free,
          "toolchain uses "+fmtBytes(used+data)+" of a "+fmtBytes(total)+" disk")
          +'<div class="sy-legend" style="margin-top:6px"><span><i style="background:var(--accent)"></i>install '
          +esc(fmtBytes(used))+" + retained "+esc(fmtBytes(data))+"</span>"
          +(free==null?'<span><i style="background:var(--dim)"></i>free space unmeasured</span>':"")+"</div>";
      }
    }
    var cons=document.getElementById("sys-consumers");
    if(cons)cons.innerHTML=(!d.storage&&!d.install)?sysEmpty(NOT_SCANNED):rankedBars(topConsumers(d,6));
  }

  function renderSysStorage(d){
    var s=d.storage,i,j;
    var donut=document.getElementById("sys-donut");
    if(donut){
      if(!s){donut.innerHTML=sysEmpty(NOT_SCANNED);}
      else{
        var slices=[],legend="",total=0;
        for(i=0;i<(s.categories||[]).length;i++){
          var v=mval(s.categories[i].bytes);
          if(v==null)continue;
          slices.push({label:s.categories[i].label,value:v,color:catColor(s.categories[i].key)});
          total+=v;
        }
        for(i=0;i<slices.length;i++){
          legend+='<span><i style="background:'+slices[i].color+'"></i>'+esc(slices[i].label)+" <b>"
            +esc(fmtBytes(slices[i].value))+" \\u00b7 "+(total>0?pct(slices[i].value,total).toFixed(0):"0")+"%</b></span>";
        }
        donut.innerHTML=slices.length
          ?('<div class="sy-donut">'+svgDonut(slices,total,fmtBytes(total)+" retained by category")
            +'<div class="sy-legend" style="flex-direction:column;gap:7px">'+legend+"</div></div>")
          :sysEmpty("no storage category could be measured.");
      }
    }
    var split=document.getElementById("sys-hostsplit");
    if(split){
      if(!s){split.innerHTML=sysEmpty(NOT_SCANNED);}
      else{
        var byHost={},order=[],cats=s.categories||[];
        for(i=0;i<cats.length;i++){
          var kids=cats[i].children||[];
          for(j=0;j<kids.length;j++){
            var b=mval(kids[j].bytes);
            if(b==null)continue;
            if(!byHost[kids[j].key]){byHost[kids[j].key]={key:kids[j].key,parts:[],total:0};order.push(kids[j].key);}
            byHost[kids[j].key].parts.push({color:catColor(cats[i].key),bytes:b,
              label:kids[j].key+" \\u00b7 "+cats[i].label+" "+fmtBytes(b)});
            byHost[kids[j].key].total+=b;
          }
        }
        order.sort(function(a,b2){return byHost[b2].total-byHost[a].total;});
        var scale=order.length?byHost[order[0]].total:0,rowsHtml="";
        for(i=0;i<order.length;i++){
          var row=byHost[order[i]],seg="";
          for(j=0;j<row.parts.length;j++){
            seg+='<i class="sy-fill" style="width:'+(scale>0?(row.parts[j].bytes/scale)*100:0).toFixed(2)
              +"%;background:"+row.parts[j].color+'" title="'+esc(row.parts[j].label)+'"></i>';
          }
          rowsHtml+='<div class="sy-bar"><span class="n">'+esc(row.key)+"</span>"
            +'<div class="sy-track tall">'+seg+"</div>"
            +'<span class="v">'+esc(fmtBytes(row.total))+"</span></div>";
        }
        var catLegend="";
        for(i=0;i<cats.length;i++)catLegend+='<span><i style="background:'+catColor(cats[i].key)+'"></i>'+esc(cats[i].label)+"</span>";
        split.innerHTML=order.length
          ?('<div class="sy-bars">'+rowsHtml+'</div><div class="sy-legend" style="margin-top:10px">'+catLegend+"</div>")
          :sysEmpty("no per-host storage node could be measured.");
      }
    }
    var growth=document.getElementById("sys-growth");
    if(growth){
      var g=s&&s.growth;
      if(!g||!g.hosts||!g.hosts.length){growth.innerHTML=sysEmpty(s?"no growth series was measured.":NOT_SCANNED);}
      else{
        var panels="";
        for(i=0;i<g.hosts.length&&i<6;i++){
          var h=g.hosts[i],vals=(h.days||[]).map(function(x){return Number(x&&x.bytes)||0;});
          var avg=mval(h.perDayAvgBytes),tot=mval(h.totalBytes);
          panels+='<div><div class="sy-legend" style="margin-bottom:4px"><span><i style="background:'
            +hostColor(h.host)+'"></i>'+esc(h.host)+"</span></div>"
            +svgArea(vals,hostColor(h.host),h.host+" \\u00b7 "+(tot==null?"total unmeasured":fmtBytes(tot)+" over "+g.windowDays+"d")
              +(avg==null?"":" \\u00b7 "+fmtBytes(avg)+"/day avg"))
            +"</div>";
        }
        growth.innerHTML='<div class="sy-spark">'+panels+"</div>"
          +'<div class="sy-legend" style="margin-top:8px"><span class="sy-approx">approximate \\u00b7 '
          +esc(String(g.basis||"file mtime and size only"))+"</span></div>";
      }
    }
    var rec=document.getElementById("sys-reclaim");
    if(rec){
      var list=(s&&s.reclaimables)||null;
      if(!s){rec.innerHTML=sysEmpty(NOT_SCANNED);}
      else if(!list||!list.length){rec.innerHTML=sysEmpty("nothing crossed a reclaimable threshold \\u2014 a real, measured nothing.");}
      else{
        var advHtml="";
        for(i=0;i<list.length;i++){
          var r=list[i];
          advHtml+='<div class="sy-adv"><span class="tag">&#9888; '+mhtml(r.bytes,fmtBytes)+"</span>"
            +'<div><div>'+esc(r.label)+"</div>"
            +'<div class="why">'+esc(r.rationale||"")+"</div>"
            +'<div class="sy-path">'+esc(r.path||"")+"</div>"
            +(r.cleanupHint?'<div class="why">&rarr; <span class="mono">'+esc(r.cleanupHint)+"</span></div>":"")
          +"</div></div>";
        }
        rec.innerHTML=advHtml;
      }
    }
    var top=document.getElementById("sys-topsessions");
    if(top){
      var sess=(s&&s.topSessions)||null;
      if(!s){top.innerHTML=sysEmpty(NOT_SCANNED);}
      else if(!sess||!sess.length){top.innerHTML=sysEmpty("no session files were measured.");}
      else{
        var hostTotals=storageHostTotals(s),body="";
        for(i=0;i<sess.length;i++){
          var x=sess[i],ht=hostTotals[x.host],share=ht>0?(x.bytes/ht)*100:null;
          body+='<tr><td class="mono" title="'+esc(x.path||"")+'">'+esc(String(x.session||"").slice(0,34))+"</td>"
            +'<td><span class="sy-dot" style="background:'+hostColor(x.host)+'"></span>'+esc(x.host||"\\u2014")+"</td>"
            +"<td>"+(x.project?esc(x.project):'<span class="sy-unk" title="this file is not attributable to a project ('+esc(x.attribution||"none")+')">not attributable</span>')+"</td>"
            +'<td class="num">'+esc(fmtBytes(x.bytes))+"</td>"
            +"<td>"+(share==null
              ?unkHtml("this host's retained total was not measured",false)
              :('<div class="sy-inbar" title="'+share.toFixed(1)+'% of '+esc(x.host)+' retained bytes"><i class="sy-fill" style="width:'
                +Math.max(1,Math.min(100,share)).toFixed(1)+"%;background:"+hostColor(x.host)+'"></i></div>'))
            +"</td></tr>";
        }
        top.innerHTML='<div class="sy-tblwrap"><table class="sy-table"><thead><tr><th>Session</th><th>Host</th>'
          +'<th>Project</th><th style="text-align:right">Size</th><th>Share of host</th></tr></thead><tbody>'
          +body+"</tbody></table></div>";
      }
    }
  }

  function renderSysRuntime(d){
    var rt=d.runtime||{},i;
    var procs=document.getElementById("sys-procs");
    if(procs){
      var pm=rt.processes;
      if(!pm||pm.status==="unknown"||!Array.isArray(pm.value)){
        procs.innerHTML=sysEmpty((pm&&pm.reason)||"the process census is unavailable.");
      }else if(!pm.value.length){
        procs.innerHTML=sysEmpty("no host process is running right now \\u2014 a measured zero.");
      }else{
        var rows=pm.value,maxRss=0,body="";
        for(i=0;i<rows.length;i++){var rv=mval(rows[i].rssBytes);if(rv!=null&&rv>maxRss)maxRss=rv;}
        for(i=0;i<rows.length;i++){
          var p=rows[i],rss=mval(p.rssBytes);
          // The project cell is the honest-degradation surface: the census
          // states WHY a process could not be attributed (including the Windows
          // reasons), and that sentence is what renders. Never blank, never a guess.
          var proj=p.project&&p.project.status!=="unknown"&&p.project.value
            ? esc(p.project.value.label||p.project.value.path)
            : '<span class="sy-unk" title="'+esc((p.project&&p.project.reason)||"not attributable")+'">'
              +esc(String((p.project&&p.project.reason)||"not attributable").split("\\u2014")[0].trim())+"</span>";
          body+='<tr><td><span class="sy-dot" style="background:'+hostColor(p.host)+'"></span>'+esc(p.host)+"</td>"
            +'<td class="num">'+esc(String(p.pid))+"</td>"
            +"<td>"+proj+"</td>"
            +'<td class="num">'+mhtml(p.uptimeMs,fmtDur)+"</td>"
            +'<td class="num">'+mhtml(p.cpuPercent,function(v){return v.toFixed(1)+"%";})+"</td>"
            +'<td><div class="sy-rss"><div class="sy-inbar" style="min-width:110px"><i class="sy-fill" style="width:'
              +(rss!=null&&maxRss>0?Math.max(2,(rss/maxRss)*100):0).toFixed(1)+"%;background:"+hostColor(p.host)+'"></i></div>'
            +'<span class="mono" style="font-size:11.5px">'+mhtml(p.rssBytes,fmtBytes)+"</span></div></td></tr>";
        }
        procs.innerHTML='<div class="sy-tblwrap"><table class="sy-table"><thead><tr><th>Host</th><th>pid</th>'
          +'<th>Project</th><th style="text-align:right">Uptime</th><th style="text-align:right">CPU</th>'
          +"<th>RSS</th></tr></thead><tbody>"+body+"</tbody></table></div>"
          +'<div class="sy-legend" style="margin-top:8px"><span>child &amp; MCP-server processes: <b>'
          +mhtml(rt.childProcessCount)+"</b></span>"
          +'<span class="sy-approx">observed '+esc(String(rt.observedAt||"")).slice(11,19)+" \\u00b7 never persisted</span></div>";
      }
    }
    var mem=document.getElementById("sys-mem");
    if(mem){
      var tot=rt.totals||{},mach=rt.machine||{};
      var rssV=mval(tot.rssBytes),physV=mval(mach.physicalMemoryBytes);
      var pair=rssV==null?null:bytesPair(rssV);
      mem.innerHTML='<div class="val" style="display:flex;align-items:baseline;gap:5px">'
        +(pair?('<span class="od lit" style="font-size:26px">'+esc(pair.n)+'</span><span class="unit">'+pair.u+" resident combined</span>")
          :mhtml(tot.rssBytes,fmtBytes))+"</div>"
        +(rssV!=null&&physV>0
          ?('<div class="sy-meter" title="'+esc(fmtBytes(rssV)+" of "+fmtBytes(physV)+" physical memory")+'"><i style="width:'
            +Math.min(100,(rssV/physV)*100).toFixed(1)+'%"></i></div>'
            +'<div style="font-size:11.5px;color:var(--ink-2)">of '+esc(fmtBytes(physV))+" physical \\u00b7 "
            +mhtml(tot.cpuPercent,function(v){return v.toFixed(1)+"%";})+" CPU across "+mhtml(mach.cpuCount)+" cores</div>")
          :'<div style="font-size:11.5px;color:var(--ink-2)">'+unkHtml("the physical-memory denominator was not reported",false)
            +" \\u2014 no share of memory can be stated</div>");
    }
    var dae=document.getElementById("sys-daemons");
    if(dae){
      var dm=rt.daemons||{},ttl=Number(dm.ttlSecs)||0,oldest=mval(dm.oldestAgeSecs);
      dae.innerHTML='<div class="sy-tiles">'
        +'<div class="sy-tile"><div class="t-v">'+mhtml(dm.count)+'</div><div class="t-l">running \\u00b7 oldest '
          +(oldest==null?unkHtml((dm.oldestAgeSecs&&dm.oldestAgeSecs.reason)||"no start time recorded",false)
            :esc((oldest/3600).toFixed(1)+"h"))
          +(ttl?" of "+esc((ttl/3600).toFixed(0))+"h TTL":"")+"</div></div>"
        +'<div class="sy-tile"><div class="t-v">'+mhtml(dm.staleCount)+'</div><div class="t-l">past TTL</div></div>'
        +'<div class="sy-tile"><div class="t-v" style="font-size:14px">'+unkHtml((dm.budget&&dm.budget.reason)||"no readable budget state",false)
          +'</div><div class="t-l">AI-worker budget</div></div>'
      +"</div>";
    }
  }

  function renderSysCatalog(d){
    var c=d.catalog,i,j;
    var radar=document.getElementById("sys-radar");
    var countsEl=document.getElementById("sys-catcounts");
    var matrix=document.getElementById("sys-matrix");
    if(!c){
      if(radar)radar.innerHTML=sysEmpty(NOT_SCANNED);
      if(countsEl)countsEl.innerHTML="";
      if(matrix)matrix.innerHTML="";
      return;
    }
    var kinds=c.kinds||[],hosts=c.hosts||[];
    if(radar){
      var axes=[],series=[];
      for(j=0;j<kinds.length;j++){
        var max=0;
        for(i=0;i<hosts.length;i++){
          var v=mval(c.perHost&&c.perHost[hosts[i]]&&c.perHost[hosts[i]][kinds[j]]);
          if(v!=null&&v>max)max=v;
        }
        axes.push({label:KIND_LABEL[kinds[j]]||kinds[j],max:max});
      }
      for(i=0;i<hosts.length&&i<3;i++){
        var vals=[],tip=hosts[i];
        for(j=0;j<kinds.length;j++){
          var pv=mval(c.perHost&&c.perHost[hosts[i]]&&c.perHost[hosts[i]][kinds[j]]);
          vals.push(pv);
          tip+=" \\u00b7 "+(pv==null?"unmeasured":pv)+" "+(KIND_PLURAL[kinds[j]]||kinds[j]);
        }
        series.push({color:SERIES[i]||"var(--dim)",values:vals,tip:tip});
      }
      var legend="";
      for(i=0;i<series.length;i++)legend+='<span><i style="background:'+series[i].color+'"></i>'+esc(hosts[i])+"</span>";
      radar.innerHTML=svgRadar(axes,series)+'<div class="sy-legend">'+legend+"</div>";
    }
    if(countsEl){
      var tiles="";
      for(j=0;j<kinds.length;j++){
        tiles+='<div class="sy-tile"><div class="t-v">'+mhtml(c.counts&&c.counts[kinds[j]])+"</div>"
          +'<div class="t-l">unique '+esc(KIND_PLURAL[kinds[j]]||kinds[j])+"</div></div>";
      }
      countsEl.innerHTML='<div class="sy-tiles">'+tiles+"</div>";
    }
    if(matrix){
      var items=(c.items||[]).slice(0,14),head="<span></span>",body="";
      for(i=0;i<hosts.length;i++)head+='<span class="h">'+esc(hosts[i])+"</span>";
      for(i=0;i<items.length;i++){
        body+='<span class="nm" title="'+esc(items[i].kind+" \\u00b7 "+items[i].name)+'">'+esc(items[i].name)+"</span>";
        for(j=0;j<hosts.length;j++){
          var on=(items[i].hosts||[]).indexOf(hosts[j])>=0;
          body+='<span class="cell"><i class="'+(on?"on":"off")+'" title="'+esc(hosts[j]+(on?" carries":" does not carry")+" "+items[i].name)+'"></i></span>';
        }
      }
      var rest=(c.items||[]).length-items.length;
      matrix.innerHTML='<div class="sy-matrix" role="table" aria-label="per-host presence of catalog items" '
        +'style="grid-template-columns:minmax(120px,1fr) repeat('+hosts.length+',68px)">'+head+body+"</div>"
        +(rest>0?'<div class="sy-more">'+esc("\\u2026"+fmtNum(rest)+" more deduplicated items measured")+"</div>":"");
    }
  }

  function renderSysProjects(d){
    var el=document.getElementById("sys-projects");
    if(!el)return;
    var p=d.projects;
    if(!p){el.innerHTML=sysEmpty(NOT_SCANNED);return;}
    var list=p.projects||[];
    if(!list.length){el.innerHTML=sysEmpty("no project was discovered on this machine.");return;}
    var LANG=["var(--s1)","var(--s2)","var(--s3)"],body="",i,j;
    for(i=0;i<list.length;i++){
      var pr=list[i];
      // Language slots are categorical identity: the top three keep their own
      // hue and everything past them folds into one gray "other", because a
      // fourth and fifth hue would claim a distinction the reader cannot see.
      var langs=[],k;
      for(k in (pr.loc&&pr.loc.byLanguage)||{})langs.push({k:k,v:Number(pr.loc.byLanguage[k])||0});
      langs.sort(function(a,b){return b.v-a.v;});
      var locTotal=mval(pr.loc&&pr.loc.total),locBar="",shown=0;
      for(j=0;j<langs.length&&j<3;j++){
        if(locTotal>0)locBar+='<i class="sy-fill" style="width:'+pct(langs[j].v,locTotal).toFixed(1)
          +"%;background:"+LANG[j]+'" title="'+esc(langs[j].k+" \\u00b7 "+fmtNum(langs[j].v)+" lines")+'"></i>';
        shown+=langs[j].v;
      }
      if(locTotal>shown&&locTotal>0)locBar+='<i class="sy-fill" style="width:'+pct(locTotal-shown,locTotal).toFixed(1)
        +'%;background:var(--dim)" title="'+esc("other \\u00b7 "+fmtNum(locTotal-shown)+" lines")+'"></i>';
      var tree=mval(pr.treeBytes),git=mval(pr.gitBytes),nm=mval(pr.nodeModulesBytes);
      var diskTotal=mval(pr.totalBytes),diskBar="";
      if(diskTotal>0){
        // One entity's ranked parts — shades of ONE hue, darkest for the part
        // the user wrote, faintest for the reinstallable overhead.
        if(tree!=null)diskBar+='<i class="sy-fill" style="width:'+pct(tree,diskTotal).toFixed(1)
          +'%;background:var(--s1)" title="'+esc("working tree \\u00b7 "+fmtBytes(tree))+'"></i>';
        if(git!=null)diskBar+='<i class="sy-fill" style="width:'+pct(git,diskTotal).toFixed(1)
          +'%;background:var(--s1);opacity:.55" title="'+esc(".git \\u00b7 "+fmtBytes(git))+'"></i>';
        if(nm!=null)diskBar+='<i class="sy-fill" style="width:'+pct(nm,diskTotal).toFixed(1)
          +'%;background:var(--s1);opacity:.28" title="'+esc("node_modules \\u00b7 "+fmtBytes(nm))+'"></i>';
      }
      var rem=pr.remote||null,name;
      if(rem&&rem.status==="linked"&&/^https:\\/\\//.test(String(rem.webUrl||""))){
        name='<a href="'+esc(rem.webUrl)+'" target="_blank" rel="noreferrer noopener" title="'+esc(rem.raw||"")+'">'
          +esc(pr.label)+"&#8239;&#8599;</a>"
          +'<div class="sy-sub">'+esc((rem.host||"remote")+" \\u00b7 "+(rem.slug||""))+"</div>";
      }else{
        name=esc(pr.label)+'<div class="sy-sub">'+esc(rem&&rem.reason?rem.reason:"local only \\u2014 no git remote")+"</div>";
      }
      var last=mval(pr.lastActivity);
      body+="<tr><td>"+name+"</td>"
        +'<td class="num">'+mhtml(pr.loc&&pr.loc.total,function(v){return "~"+fmtTok(v);})+"</td>"
        +'<td><div class="sy-inbar" style="min-width:120px">'+locBar+"</div></td>"
        +'<td class="num">'+mhtml(pr.totalBytes,fmtBytes)+"</td>"
        +'<td><div class="sy-inbar" style="min-width:140px">'+diskBar+"</div></td>"
        +'<td class="num">'+(last==null?unkHtml((pr.lastActivity&&pr.lastActivity.reason)||"no readable entry",false)
          :esc(ago(Math.max(0,Math.round((Date.now()-last)/1000)))))+"</td></tr>";
    }
    el.innerHTML='<div class="sy-legend" style="margin-bottom:4px">lines: '
      +'<span><i style="background:var(--s1)"></i>1st language</span>'
      +'<span><i style="background:var(--s2)"></i>2nd</span>'
      +'<span><i style="background:var(--s3)"></i>3rd</span>'
      +'<span><i style="background:var(--dim)"></i>other</span>'
      +'<span style="margin-left:10px">disk: <i style="background:var(--s1)"></i>tree'
      +'<i style="background:var(--s1);opacity:.55;margin-left:8px"></i>.git'
      +'<i style="background:var(--s1);opacity:.28;margin-left:8px"></i>node_modules</span></div>'
      +'<div class="sy-tblwrap"><table class="sy-table"><thead><tr><th>Project</th>'
      +'<th style="text-align:right">Lines &#8776;</th><th>By language</th>'
      +'<th style="text-align:right">Disk</th><th>tree &middot; .git &middot; node_modules</th>'
      +'<th style="text-align:right">Last active</th></tr></thead><tbody>'+body+"</tbody></table></div>"
      +'<div class="sy-more">'+mhtml(p.count)+" projects discovered \\u00b7 line counts are approximate: "
      +"extension-bucketed, with node_modules and vendored trees excluded</div>";
  }

  // Freshness is a contract, not a caption (ADR-0025 §3): every deep figure on
  // this page was measured at ONE moment, and the label says which. Past the
  // staleness horizon it nudges — but it still never scans on its own.
  function renderSystemFreshness(){
    var el=document.getElementById("sys-asof"),btn=document.getElementById("sys-rescan");
    if(!el)return;
    var scan=(SYSTEM&&SYSTEM.scan)||null,snap=(SYSTEM&&SYSTEM.snapshot)||null;
    el.removeAttribute("data-stale");
    if(scan&&scan.running){
      el.innerHTML='<span class="sy-scan">scanning\\u2026 '+esc(scan.phase||"")
        +(scan.total?" ("+fmtNum(scan.scanned)+"/"+fmtNum(scan.total)+")":"")+"</span>";
      if(btn){btn.disabled=true;btn.title="a deep scan is already running";}
      return;
    }
    if(btn){btn.disabled=false;btn.title="re-measure the deep tier now";}
    if(!SYSTEM){el.textContent="deep scan \\u2014 not loaded";return;}
    if(!snap||!snap.measured||snap.asOf==null){
      el.textContent="deep scan \\u2014 never run on this machine";
      el.title=(snap&&snap.reason)||"no snapshot has been written yet";
      el.setAttribute("data-stale","1");
      return;
    }
    // limAge, not ago(): a snapshot is a DAYS-scale artifact and the staleness
    // horizon is a week, so "240h ago" is the wrong unit for the one label that
    // has to make "older than seven days" obvious. Reusing the Limits view's
    // formatter keeps one vocabulary for "how old is this figure".
    var age=limAge(Date.now()-Math.max(0,Number(snap.ageMs)||0));
    el.textContent="deep scan \\u00b7 "+age+(snap.stale?" \\u00b7 stale, rescan":"")
      +(scan&&scan.error?" \\u00b7 last scan reported a problem":"");
    el.title=(scan&&scan.error?scan.error+" \\u2014 ":"")
      +"deep-tier figures were measured "+age+"; nothing rescans on its own";
    if(snap.stale)el.setAttribute("data-stale","1");
  }

  function renderSystem(){
    if(!SYSTEM)return;
    if(SYSTEM.error){
      var ids=["sys-kpis","sys-gauge","sys-consumers","sys-donut","sys-hostsplit","sys-growth",
        "sys-reclaim","sys-topsessions","sys-procs","sys-mem","sys-daemons","sys-radar",
        "sys-catcounts","sys-matrix","sys-projects"];
      var msg=sysEmpty(SYSTEM.error+(SYSTEM.reason?" \\u2014 "+SYSTEM.reason:""));
      for(var i=0;i<ids.length;i++){
        var el=document.getElementById(ids[i]);
        if(el)el.innerHTML=msg;
      }
      renderSystemFreshness();
      return;
    }
    renderSysSummary(SYSTEM);
    renderSysStorage(SYSTEM);
    renderSysRuntime(SYSTEM);
    renderSysCatalog(SYSTEM);
    renderSysProjects(SYSTEM);
    renderSystemFreshness();
  }

  // A deep refresh is a re-MEASUREMENT of local state, which is why it rides a
  // GET (ADR-0025 §5). The server answers immediately with the running scan
  // state; the poll below tracks it to completion and stops the moment it
  // settles. Nothing here starts a scan that the user did not ask for.
  function loadSystem(deep){
    if(systemBusy)return Promise.resolve();
    systemBusy=true;
    if(deep&&SYSTEM&&SYSTEM.scan)SYSTEM.scan.running=true;
    renderSystemFreshness();
    return fetch("/api/system"+(deep?"?refresh=deep":""),{cache:"no-store",headers:authHeaders()})
      .then(function(r){return r.json();})
      .then(function(d){SYSTEM=d;})
      .catch(function(){SYSTEM={error:"the system footprint could not be read",scan:null,snapshot:null};})
      .then(function(){
        systemBusy=false;
        renderSystem();
        scheduleSystemPoll();
      });
  }
  function scheduleSystemPoll(){
    if(systemPollTimer){clearTimeout(systemPollTimer);systemPollTimer=null;}
    if(!SYSTEM||!SYSTEM.scan||!SYSTEM.scan.running)return;
    // Bounded by the scan itself: the timer is only ever re-armed while the
    // server still reports it running, so a finished scan stops the polling
    // without any client-side deadline to get wrong.
    systemPollTimer=setTimeout(function(){loadSystem();},3000);
  }
  function wireSystem(){
    var btn=document.getElementById("sys-rescan");
    if(btn)btn.addEventListener("click",function(){
      if(btn.disabled)return;
      loadSystem(true);
    });
  }

  window.AKDashboardSyncHash=syncHash;
  if(window.AKLive&&window.AKLive.setScope)window.AKLive.setScope(initialLiveScope,false);
  setTab(activeTab);
  setUsageView(usageView);
  setSystemView(systemView,false,true);
  // About paints its editorial content immediately, with every chip reading
  // "state unknown" until the first /api/status response supplies the join.
  renderAbout(null);
  renderSystemFreshness();
  wirePoll();
  wireUsage();
  wireIntelPicker();
  wireAboutNudge();
  wireSystem();
  schedulePoll();
  lastAttempt=Date.now(); inflight=true;
  Promise.all([pollStatus()].concat(activeTab==="usage"?[loadUsage()]:[]))
    .catch(function(){}).then(function(){inflight=false; tickClock();});
  setInterval(tickClock,1000);
})();
`;
