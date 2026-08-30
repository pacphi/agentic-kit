// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { VIEWS, authHeaders, esc, setTab, syncHash } from './bootstrap.mjs';
import { ago } from './intelligence.mjs';
import { renderModelFacets, renderModelInventory, renderModelLifecycle } from './model-lifecycle.mjs';
import { bucketPercentile, bucketPositionPct, deltaChip, donut2, histogram, rankedRows, sparklineSvg, stackedDays } from './usage-rhythm.mjs';
import { coachingPanel, hostInterplay, patternsTable, promptKpis, provenancePanel, reAskPanel, steerPanel, tapLengthPanel, taxonomyPlaceholder } from './usage-prompts.mjs';
import { renderUsage } from './usage-orchestrators.mjs';

  // ══ Usage tab ══════════════════════════════════════════════════════════════
  export var USAGE=null, usageLoaded=false, usageBusy=false, TRANSCRIPT=null;
  export var MODELS=null,MODEL_PAGE=null,modelRows=[],modelSnapshotId=null,modelsBusy=false,modelRequestSeq=0,modelSearchTimer=null;
  export var MODEL_LIMIT=50,modelSort="lifecycle",modelDirection="asc",modelRouteSort="model",modelRouteDirection="asc";

  function fmtUsd(n){
    n=Number(n)||0;
    if(n>=1000)return "$"+Math.round(n).toLocaleString();
    if(n>=10)return "$"+n.toFixed(0);
    return "$"+n.toFixed(2);
  }
  // A POSITIVE figure that rounds away at two decimals is not $0.00 — printing
  // it that way beside a caption about excluding $0-by-construction sessions
  // reads as "the median session was free", which is a different claim from
  // "the median session cost less than a cent". The threshold is derived from
  // fmtUsd's own output rather than restating its rounding rule, so the two
  // cannot disagree. A true zero is left alone: it is not less than a cent.
  function fmtUsdMin(n){
    var v=Number(n)||0,txt=fmtUsd(v);
    return (v>0&&txt==="$0.00")?"<$0.01":txt;
  }
  export function fmtNum(n){return (Number(n)||0).toLocaleString();}
  export function fmtTok(n){
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
  export function pct(a,b){return b?(a/b*100):0;}
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
  export function sourceHostIcon(host){
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

  export function renderSourceHealth(health){
    var el=document.getElementById("u-source-health");
    if(!el)return;
    health=health||{};
    var pills=[];
    for(var g=0; g<SOURCE_HEALTH_GROUPS.length; g++){
      var grp=SOURCE_HEALTH_GROUPS[g],present=[];
      for(var p=0; p<grp.parts.length; p++){
        var part=grp.parts[p],item=health[part.key];
        if(item) present.push({status:String(item.status||"not-read"),reason:item.reason,diagnostics:item.diagnostics,sub:part.sub});
      }
      if(!present.length)continue;
      var lead=present.slice().sort(function(a,b){
        return sourceHealthRank(a.status)-sourceHealthRank(b.status);
      })[0];
      var detail=grp.label+": "+present.map(function(pt){
        var d=pt.status+(pt.reason?" · "+pt.reason:"");
        var q=pt.diagnostics;
        if(q&&q.files) d+=" · "+fmtNum(q.responses)+" responses / "+fmtNum(q.files)+" files";
        if(q&&q.warnings&&q.warnings.length) d+=" · "+q.warnings.join(", ");
        if(q&&q.common) d+=" · "+fmtNum(q.common.unitsParsed)+"/"+fmtNum(q.common.unitsSeen)+" parsed · "+fmtNum(q.common.prompts)+" prompts / "+fmtNum(q.common.responses)+" responses";
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

  export function loadUsage(force){
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

  function modelJson(url){
    return fetch(url,{cache:"no-store",headers:authHeaders()}).then(function(r){
      return r.json().then(function(d){
        if(!r.ok){var error=new Error(d&&d.error||"unavailable");error.status=r.status;throw error;}
        return d;
      });
    });
  }

  export function modelFilters(){
    function value(id){var el=document.getElementById(id);return el?String(el.value||"").trim():"";}
    var evidenceField=value("mli-evidence-field"),evidenceValue=value("mli-evidence-value");
    if(!evidenceField||!evidenceValue){evidenceField="";evidenceValue="";}
    return {search:value("mli-search"),host:value("mli-host"),provider:value("mli-provider"),
      relevance:value("mli-relevance")||"relevant",
      lifecycle:value("mli-lifecycle"),evidenceField:evidenceField,evidenceValue:evidenceValue};
  }

  function modelInventoryUrl(offset){
    var query=new URLSearchParams({view:"inventory",offset:String(offset||0),limit:String(MODEL_LIMIT),
      sort:modelSort,direction:modelDirection}),filters=modelFilters();
    if(modelSnapshotId)query.set("snapshotId",modelSnapshotId);
    Object.keys(filters).forEach(function(key){if(filters[key])query.set(key,filters[key]);});
    return "/api/models?"+query.toString();
  }

  function setModelsBusy(busy,message){
    modelsBusy=busy;
    var panel=document.getElementById("v-models"),status=document.getElementById("mli-load-status"),more=document.getElementById("mli-load-more");
    if(panel)panel.setAttribute("aria-busy",busy?"true":"false");
    if(more)more.disabled=busy;
    if(status&&message)status.textContent=message;
  }

  export function loadModelInventory(offset,append,focusAfter){
    var seq=++modelRequestSeq,priorLength=modelRows.length;
    setModelsBusy(true,append?"Loading more model evidence.":"Loading model inventory evidence.");
    return modelJson(modelInventoryUrl(offset)).then(function(d){
      if(seq!==modelRequestSeq)return;
      var nextSnapshotId=d&&d.snapshot&&d.snapshot.snapshotId||null;
      if(modelSnapshotId&&nextSnapshotId!==modelSnapshotId){
        modelSnapshotId=null;
        return loadModelLifecycle(true,focusAfter,true);
      }
      modelSnapshotId=nextSnapshotId;
      MODEL_PAGE=d&&d.inventory||{};
      var items=Array.isArray(MODEL_PAGE.items)?MODEL_PAGE.items:[];
      modelRows=append?modelRows.concat(items):items;
      renderModelInventory();
      renderModelFacets();
      setModelsBusy(false,"Model lifecycle evidence loaded. "+modelRows.length+" rows shown.");
      var more=document.getElementById("mli-load-more");if(more)more.textContent="Load 50 more";
      if(focusAfter){
        var headers=document.querySelectorAll("#mli-models tr > th[scope=row]");
        var target=headers[append?priorLength:0],region=document.querySelector(".mli-table-wrap");
        if(append&&more&&!more.hidden)more.focus();else if(target)target.focus();else if(region)region.focus();
      }
    }).catch(function(error){
      if(seq!==modelRequestSeq)return;
      if(error&&error.status===409){
        modelSnapshotId=null;
        setModelsBusy(true,"Model inventory changed; reloading its summary and first page.");
        return loadModelLifecycle(true,focusAfter,true);
      }
      if(append){
        var more=document.getElementById("mli-load-more");
        if(more){more.hidden=false;more.disabled=false;more.textContent="Retry loading 50 more";more.focus();}
        setModelsBusy(false,"More model lifecycle evidence is unavailable; prior rows were preserved.");
        return;
      }
      MODEL_PAGE={items:[],total:0,filteredTotal:0,relevantTotal:0,offset:0,limit:MODEL_LIMIT,hasMore:false};
      modelRows=[];modelSnapshotId=null;
      renderModelInventory();
      setModelsBusy(false,"Model lifecycle evidence is unavailable.");
    });
  }

  export function loadModelLifecycle(force,focusAfter,recovering){
    if(!recovering&&(modelsBusy||(!force&&MODELS)))return Promise.resolve();
    setModelsBusy(true,"Loading model lifecycle summary.");
    return modelJson("/api/models?view=summary&days="+usageDays).then(function(d){
      MODELS=d;
      modelSnapshotId=d&&d.snapshot&&d.snapshot.snapshotId||null;
      renderModelLifecycle();
      if(!LIMITS)loadLimits();
      return loadModelInventory(0,false,!!focusAfter);
    }).catch(function(){
      MODELS={error:"model inventory unavailable"};MODEL_PAGE=null;modelRows=[];modelSnapshotId=null;
      renderModelLifecycle();renderModelInventory();
      setModelsBusy(false,"Model lifecycle evidence is unavailable.");
    });
  }

  export function setUsageView(v,session){
    usageView=v;
    if(session!==undefined)usageSession=session;
    var headings={score:["Usage scorecard","Token consumption, API-equivalent cost, efficiency, and trends."],limits:["Provider limits","Current provider windows, reset timing, and available capacity."],findings:["Usage findings","Actionable anomalies, efficiency opportunities, and evidence-backed recommendations."],prompts:["Prompt patterns","What you type across every host, which patterns repeat, and what to change — from fingerprints, never prompt text."],sessions:["Session usage","Browse retained sessions by project, category, duration, tokens, and cost."],models:["Models","Observed models in this window, configured routes, and the separate provider/local catalogue."],transcript:["Transcript detail","Inspect the selected session's locally retained, server-masked evidence."]},heading=headings[v]||headings.score;
    document.getElementById("usage-view-title").textContent=heading[0];document.getElementById("usage-view-description").textContent=heading[1];
    var btns=document.querySelectorAll("#usage-seg [data-view]");
    for(var i=0;i<btns.length;i++){var on=btns[i].getAttribute("data-view")===v;btns[i].setAttribute("aria-selected",on?"true":"false");btns[i].tabIndex=on?0:-1;}
    for(var j=0;j<VIEWS.length;j++){
      var el=document.getElementById("v-"+VIEWS[j]);
      if(el){
        var visible=VIEWS[j]===v;
        // The hidden attribute is the semantic boundary. Keep the visual
        // boundary inline and important as well: third-party browser CSS or a
        // broad future section rule must not expose Models beneath another
        // Usage view.
        el.hidden=!visible;
        el.setAttribute("aria-hidden",visible?"false":"true");
        if(visible){el.removeAttribute("inert");el.style.removeProperty("display");}
        else{el.setAttribute("inert","");el.style.setProperty("display","none","important");}
      }
    }
    syncHash();
    if(v==="transcript"&&usageSession&&(!TRANSCRIPT||TRANSCRIPT.id!==usageSession)){
      loadTranscript(usageSession).then(renderTranscript);
    }
    var days=document.getElementById("usage-days");if(days)days.hidden=(v==="transcript");
    // BEFORE the per-view loaders, not after. Leaving Prompts with All (365)
    // selected resets the window to 30, and a loader that ran first would have
    // already fetched at 365: two requests in flight for different windows with
    // no ordering guarantee, so a late 365 response paints year-wide figures
    // under a chip row reading 30d. Settling the window first means each loader
    // below fires once, at the window the reader can actually see.
    syncAllHistoryChip(v);
    // Limits is LAZY like the tab itself: the Codex side may spawn one vendor
    // subprocess server-side, so it runs when the view is opened, not on poll.
    if(v==="limits"&&!LIMITS)loadLimits();
    if(v==="models"){loadModelLifecycle();if(!LIMITS)loadLimits();}
    // Prompts renders from the payload the poll already holds, so opening the
    // tab is a re-render rather than a fetch — cheap enough to run on entry so
    // the view is populated before the next poll, even though page.mjs ships
    // every u-pr-* container statically and renderUsage also calls this.
    if(v==="prompts"&&USAGE&&!USAGE.error)renderPrompts(USAGE);
  }

  // Whole-history is offered on the Prompts view alone: patterns are lifetime
  // phenomena, where every other view's figures are about a recent window.
  // Leaving Prompts with it selected drops back to 30d rather than carrying a
  // 365-day window into a view whose chip row no longer shows it — a selected
  // window the reader cannot see is worse than a narrower one they can.
  function syncAllHistoryChip(v){
    var all=document.getElementById("usage-days-all");
    if(!all)return;
    var on=(v==="prompts");
    all.hidden=!on;
    if(!on&&usageDays>=365){
      var fallback=document.querySelector('#usage-days [data-days="30"]');
      if(fallback)fallback.click();
    }
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
  export function kpi(k,v,d,cls,titleTxt){
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
      +" ≤ summed "+fmtHours((Number(t.spanMinutes)||0)*60)+"\n"
      +"engaged unions active sub-intervals split at 15-min silences; "
      +"open unions whole session spans; summed double-counts overlap.";
  }

  // ── panels grafted onto the served scorecard markup ───────────────────────
  // page.mjs renders the scorecard's containers. The panels below arrived
  // after that markup shipped and build their own container instead of growing
  // the served template with ids it has no other reason to know about. Every
  // one is IDEMPOTENT: renderScore runs on each poll, so a second call finds
  // the container the first call built rather than stacking a duplicate.
  //
  // scoreBlock walks up to the direct child of #v-score that owns `id`, which
  // is the granularity the scorecard's own layout uses (a .strip, a .two pair,
  // the .hero grid) — so an inserted panel lands between whole sections, never
  // inside one.
  function scoreBlock(id){
    var el=document.getElementById(id),view=document.getElementById("v-score");
    if(!el||!view)return null;
    while(el&&el.parentNode&&el.parentNode!==view)el=el.parentNode;
    return (el&&el.parentNode===view)?el:null;
  }
  function ensureBlock(probeId,html,afterId){
    var existing=document.getElementById(probeId);
    if(existing)return existing;
    var anchor=scoreBlock(afterId);
    if(!anchor)return null;
    var host=document.createElement("div");
    host.innerHTML=html;
    var node=host.firstElementChild;
    if(!node)return null;
    anchor.parentNode.insertBefore(node,anchor.nextSibling);
    return document.getElementById(probeId);
  }
  // The same heading grammar the served markup uses, so an inserted panel is
  // indistinguishable from a static one. `note` is escaped: every caller
  // passes a literal caption, and a panel's live figures belong in its body
  // (rewritten each render) rather than in a header this builds once.
  function stripHtml(bodyId,heading,note){
    return '<section class="strip"><div class="sh"><h2>'+esc(heading)+"</h2>"
      +'<span class="n mono">'+esc(note)+"</span></div>"
      +'<div id="'+esc(bodyId)+'"></div></section>';
  }
  // A legend the chart primitives do not draw for themselves. Reuses the
  // scorecard's own .legend/.lg grammar so an external legend is the same
  // object here as it is under the token bar. The label is always spelled out
  // beside the swatch — the hue is a hint, never the only way to read a series.
  function chartLegend(items){
    return '<div class="legend">'+items.map(function(it){
      return '<span class="lg"><i style="background:'+esc(it.color)+'"></i>'+esc(it.label)
        +' <b class="tnum">'+esc(it.value)+"</b></span>";
    }).join("")+"</div>";
  }

  // byDay ascending. Shared by the day-bar strip and every per-day series
  // below, so they cannot disagree about which days are in the window.
  function dayRows(d){
    var out=[],k;
    for(k in (d.byDay||{}))out.push({day:k,v:d.byDay[k]});
    out.sort(function(a,b){return a.day<b.day?-1:1;});
    return out;
  }
  // engagedByDay is a SIBLING map with its own key set, not a byDay field:
  // byDay's presence contract is billed days only, and a day worked but never
  // billed still has engaged time. Sorting it separately keeps that day in the
  // trend instead of dropping it to match a different question's day set.
  function mapRows(map){
    var out=[],k;
    for(k in (map||{}))out.push({day:k,v:map[k]});
    out.sort(function(a,b){return a.day<b.day?-1:1;});
    return out;
  }
  function fmtRatio(n){
    if(n==null||!isFinite(n))return "—";
    return Math.abs(n)>=10?String(Math.round(n)):n.toFixed(1);
  }
  // Durations that span four orders of magnitude (a 1.4s reply, a 3h session)
  // in one compact token. A whole number of hours prints as "2h", not "2.0h":
  // the extra digit claims a precision a bucket floor does not have.
  function fmtSecs(sec){
    sec=Number(sec)||0;
    // <=60, not <60: the latency histogram's overflow bucket floor IS 60s, and
    // that value has to read "60s" so "≥60s" names the bucket edge the reader
    // can see on the axis. Rolling it up to "1m" renamed the boundary.
    if(sec<=60)return (sec<10?Math.round(sec*10)/10:Math.round(sec))+"s";
    if(sec<5400)return Math.round(sec/60)+"m";
    var h=Math.round(sec/360)/10;
    return (h%1===0?String(h):h.toFixed(1))+"h";
  }
  // A value from a histogram's OVERFLOW bucket has no upper edge to
  // interpolate towards, so the percentile reports that bucket's FLOOR.
  // Printing it bare would state a figure the counts cannot support, so it is
  // prefixed and reads "at least this". `lastEdge` is that floor.
  function fmtAtLeast(v,lastEdge,fmt){
    if(v==null||!isFinite(v))return "—";
    return (v>=lastEdge?"≥":"")+fmt(v);
  }
  // renderScore was one CC-41 function writing ~10 independent scorecard
  // regions (hero KPIs, cost-per-day bars, host cards, token bar/legend,
  // punchcard, models, OpenRouter, projects, categories) in sequence. Split
  // by region; each keeps its original logic verbatim, so the rendered DOM
  // and its ordering are unchanged.

  // A hero tile's footer: the change against the previous equal-length window,
  // and a per-day trend for the same figure. Both self-suppress when the data
  // cannot support them (deltaChip is '' with no previous window, sparklineSvg
  // is '' below two points), so a tile with neither renders exactly as it did
  // before this row existed.
  function kpiFoot(chip,spark){
    return (chip||spark)?'<div class="kpi-foot">'+chip+spark+"</div>":"";
  }
  // The cache tile's own dollar claim. cacheSavedUsd is computed server-side
  // as a DIFFERENCE — the same tokens priced as fresh input minus priced as
  // cache reads, at the rate in effect on the day they were spent — so it
  // cannot drift out of step with the pricing table the way a hardcoded
  // discount factor would. Rendered only when there is a figure to render.
  function cacheSubtitle(t){
    var saved=Number(t.cacheSavedUsd)||0;
    return "priced at 0.1&times; input"
      +(saved>0?'<span class="d-note">saved &asymp; '+esc(fmtUsd(saved))+" vs uncached</span>":"");
  }
  var CACHE_TIP="Share of this window's tokens that were cache reads. Higher is cheaper, so a rise "
    +"is the good direction.\nsaved ≈ prices the same cache-read tokens as fresh input and takes the "
    +"gap, at each day's own rate.\nThe trend is that share recomputed per day. A day that billed no "
    +"tokens has no share to compute, so the line breaks across it rather than carrying a neighbour's "
    +"value forward.";
  // Engaged time is the ONE hero trend drawn from a different day set. Said on
  // the tile, because the tiles otherwise look directly comparable and are not.
  var ENGAGED_TREND_NOTE="\ntrend covers days you worked; the other tiles' trends cover billed days.";

  function renderScoreHero(d){
    var t=d.totals||{},p=(d.previous&&d.previous.totals)||{};
    var rows=dayRows(d);
    var cacheShare=pct(t.cacheRead,t.tokens),prevCacheShare=pct(p.cacheRead,p.tokens);
    function spark(pick){return sparklineSvg(rows.map(pick),{});}
    document.getElementById("u-hero").innerHTML=
      kpi("sessions",fmtNum(t.sessions),esc(fmtNum(t.responses))+" assistant turns"
        +kpiFoot(deltaChip(t.sessions,p.sessions,{}),
          spark(function(x){return fld(x.v,"sessions");})),"")
      +kpi("api-equivalent",fmtUsd(t.cost),"list price &middot; not plan billing"
        +kpiFoot(deltaChip(t.cost,p.cost,{downIsGood:true}),
          spark(function(x){return fld(x.v,"cost");})),"accent")
      +kpi("tokens",fmtTok(t.tokens),esc(fmtTok(t.output))+" out &middot; "+esc(fmtTok(t.cacheRead))+" cached"
        +kpiFoot(deltaChip(t.tokens,p.tokens,{neutral:true}),
          spark(function(x){return fld(x.v,"tokens");})),"")
      +kpi("engaged time",fmtHours(t.engagedSeconds),
        esc(fmtMins(t.spanMinutes))+" summed"
        +'<span class="d-note">sessions overlap</span>'
        +kpiFoot(deltaChip(t.engagedSeconds,p.engagedSeconds,{}),
          sparklineSvg(mapRows(d.engagedByDay).map(function(x){return Number(x.v)||0;}),{})),
        "",ladder(t)+ENGAGED_TREND_NOTE)
      // Cache share is up-good, unlike the cost tile beside it: cache reads
      // bill at 0.1× input, so a bigger share of them is a cheaper window.
      // The delta is in percentage POINTS — a percent-of-a-percent would be
      // read as a share change and is not what moved.
      // A day that billed no tokens has no share to compute. It keeps its slot
      // in the series as a null, which sparklineSvg draws as a BREAK — never a
      // carried-forward value, which would state a figure for a day that has
      // none, and never a dropped point, which would squeeze the time axis.
      +kpi("cache read",cacheShare.toFixed(1)+"%",cacheSubtitle(t)
        +kpiFoot(deltaChip(cacheShare,prevCacheShare,{unit:" pp"}),
          spark(function(x){
            var tok=fld(x.v,"tokens");
            return tok?pct(fld(x.v,"cacheRead"),tok):null;
          })),"warnv",CACHE_TIP);
    document.getElementById("u-asof").textContent=d.pricesAsOf?("rates as of "+d.pricesAsOf):"";

  }

  // ── second KPI row: cadence, autonomy, unit economics ─────────────────────
  var TIP_PER_DAY="Sessions ÷ active days.\nAn ACTIVE day is one this window actually billed tokens "
    +"on — that is byDay's own contract, so a day worked but never billed is not counted and breaks "
    +"the streak.\nStreak counts consecutive active days ending at the most recent one.\n"
    +"Sessions INCLUDES delegated subagent sessions, which the harness dispatches rather than you — "
    +"the how-you-run panel carries the main/subagent split.";
  var TIP_AUTONOMY="Assistant responses ÷ prompts you typed — how far each prompt travels.\n"
    +"Prompts are MAIN-THREAD only: a subagent's prompts are written by the harness, not by you, so "
    +"counting them would inflate the denominator with work nobody asked for by hand.\nTouch rate is "
    +"those same prompts per engaged hour.";
  var TIP_PER_SESSION="Median api-equivalent cost of one session, and the 90th percentile of the same "
    +"set.\nSessions with NO token evidence at all are excluded: they are structurally $0 (a Codex "
    +"subagent rollout whose tokens were stripped as a double-count, say), not cheap, and folding "
    +"them in would drag the median toward zero for a reason that is not about spend.\n<$0.01 means "
    +"a real, positive figure smaller than a cent — not zero.";
  var TIP_PER_HOUR="Api-equivalent cost ÷ engaged hours.\nEngaged time unions active sub-intervals "
    +"split at 15-minute silences — not wall clock, and not the sum of session spans, which "
    +"double-counts overlap.\n— when no engaged time was measured.";

  function dayBefore(day){
    var t=Date.parse(String(day)+"T00:00:00Z");
    if(!isFinite(t))return null;
    return new Date(t-86400000).toISOString().slice(0,10);
  }
  function activeStreak(days){
    if(!days.length)return 0;
    var n=1;
    for(var i=days.length-1;i>0;i--){
      if(dayBefore(days[i])!==days[i-1])break;
      n++;
    }
    return n;
  }
  function cadenceCells(t,active,streak){
    var perDay=active?(Number(t.sessions)||0)/active:null;
    var auto=t.responsesPerPrompt,touch=t.humanPromptsPerHour;
    var med=t.costPerSessionMedian,p90=t.costPerSessionP90,perHour=t.costPerEngagedHour;
    return kpi("sessions / active day",fmtRatio(perDay),
      esc(fmtNum(active))+" active day"+(active===1?"":"s")
      +'<span class="d-note">streak '+esc(String(streak))+" day"+(streak===1?"":"s")+"</span>","",TIP_PER_DAY)
      +kpi("autonomy",auto==null?"—":fmtRatio(auto)+"×",
        auto==null?"no prompts you typed in window"
          :(touch==null?"touch rate not recorded"
            :esc(fmtRatio(touch))+" prompts / engaged hour"),"",TIP_AUTONOMY)
      +kpi("cost / session",med==null?"—":fmtUsdMin(med),
        med==null?"no priced sessions in window"
          :"median &middot; excludes $0-by-construction"
            +'<span class="d-note">P90 '+esc(p90==null?"—":fmtUsdMin(p90))+"</span>","",TIP_PER_SESSION)
      +kpi("cost / engaged hour",perHour==null?"—":fmtUsd(perHour),
        perHour==null?"no engaged time measured":"engaged time, not wall clock","",TIP_PER_HOUR);
  }
  function renderScoreCadence(d){
    var body=ensureBlock("u-cadence",'<div class="hero hero-2" id="u-cadence"></div>',"u-hero");
    if(!body)return;
    var days=dayRows(d).map(function(x){return x.day;});
    body.innerHTML=cadenceCells(d.totals||{},days.length,activeStreak(days));
  }

  // ── rhythm: how long sessions run, how long replies take ──────────────────
  // The edges are restated from usage-aggregate.mjs's exported
  // LAT_BUCKET_EDGES/LEN_BUCKET_EDGES: the payload ships the COUNTS, never the
  // edges they were binned on, and this file is read as text into a browser
  // bundle that cannot import that module. A test pins the copies equal, so a
  // change to either goes red instead of silently re-labelling every bucket.
  var LAT_EDGES=[2,5,10,30,60];
  var LAT_LABELS=["≤2s","≤5s","≤10s","≤30s","≤60s",">60s"];
  var LEN_EDGES=[300,900,2700,7200];
  var LEN_LABELS=["≤5m","≤15m","≤45m","≤2h",">2h"];
  var LAT_TIP="Wall-clock gap between a prompt and the response that answered it.\n"
    +"codex host-measured · claude/opencode derived from event gaps — not streaming TTFT.\n"
    +"The last bucket has no upper edge, so a percentile landing in it reports that bucket's "
    +"floor: printed with ≥, read as \"at least this\".\n"
    +"INCLUDES delegated subagent responses — the how-you-run panel carries the split.";
  var LEN_TIP="Engaged length of one session — the union of its active sub-intervals, split at "
    +"15-minute silences, not its first-to-last span.\nThe last bucket has no upper edge, so a "
    +"percentile landing in it is printed with ≥.\n"
    +"INCLUDES delegated subagent sessions — the how-you-run panel carries the split.";

  function histMarker(value,edges,label){
    var at=bucketPositionPct(edges,value);
    return at==null?null:{atPct:at,label:label};
  }
  function histCard(o){
    var counts=Array.isArray(o.counts)?o.counts:[];
    var total=counts.reduce(function(a,n){return a+(Number(n)||0);},0);
    return '<div class="rcard" title="'+esc(o.tip)+'">'
      +'<div class="rcard-h"><span class="rcard-t">'+esc(o.title)+"</span>"
      +'<span class="rcard-n mono">'+esc(total?o.note:"not measured")+"</span></div>"
      +(total?histogram({counts:counts,labels:o.labels,
        markers:(o.markers||[]).filter(Boolean)})
        :'<div class="empty">'+esc(o.emptyText)+"</div>")+"</div>";
  }
  function lengthCard(r){
    var med=r.lenMedianSeconds,p90=r.lenP90Seconds;
    var medTxt=fmtAtLeast(med,7200,fmtSecs),p90Txt=fmtAtLeast(p90,7200,fmtSecs);
    return histCard({title:"session length",counts:r.lenHist,labels:LEN_LABELS,
      markers:[histMarker(med,LEN_EDGES,"median "+medTxt),histMarker(p90,LEN_EDGES,"P90 "+p90Txt)],
      note:"median "+medTxt+" · P90 "+p90Txt,tip:LEN_TIP,
      emptyText:"no session lengths in window."});
  }
  function latencyCard(r){
    var p50=r.latP50,p95=r.latP95,n=Number(r.latCount)||0;
    var p50Txt=fmtAtLeast(p50,60,fmtSecs),p95Txt=fmtAtLeast(p95,60,fmtSecs);
    return histCard({title:"response latency",counts:r.latHist,labels:LAT_LABELS,
      markers:[histMarker(p50,LAT_EDGES,"p50 "+p50Txt),histMarker(p95,LAT_EDGES,"p95 "+p95Txt)],
      note:"p50 "+p50Txt+" · p95 "+p95Txt+" · n "+fmtNum(n),tip:LAT_TIP,
      emptyText:"no response latency measured in window."});
  }
  function renderScoreRhythm(d){
    var body=ensureBlock("u-rhythm",
      stripHtml("u-rhythm","Your rhythm","session length · response latency"),"u-daybars");
    if(!body)return;
    var r=d.rhythm||{};
    body.innerHTML='<div class="rhythm-grid">'+lengthCard(r)+latencyCard(r)+"</div>";
  }

  // ── how you run: posture, who drove, who served ───────────────────────────
  // ADR-0038's closed posture vocabulary, ordered least to most permissive so
  // the stack reads bottom-up as "how much rope was given", with the
  // unobserved bucket at the base. Every color is a token AND is named in the
  // legend beside the chart — the hue is a hint, never the only way to read it.
  // 'not-recorded' is forced to the de-emphasis ink by the primitive itself,
  // so it deliberately has no palette entry here.
  var MODE_ORDER=["not-recorded","plan","guarded","auto-edit","unrestricted"];
  var MODE_COLOR={plan:"var(--purple)",guarded:"var(--ok)","auto-edit":"var(--accent)",
    unrestricted:"var(--fail)"};

  function modeChart(d){
    var byMode=d.byMode||{};
    var present=MODE_ORDER.filter(function(k){
      return Object.prototype.hasOwnProperty.call(byMode,k);
    });
    if(!present.length)return '<div class="hr-t">posture, by day</div>'
      +'<div class="empty">no permission posture recorded in window.</div>';
    var days=dayRows(d).map(function(x){return {day:x.day,parts:(x.v&&x.v.byMode)||{}};});
    // Legend order is the stack read TOP-down, which is the reverse of the
    // bottom-up paint order — so the entry your eye reaches first names the
    // band your eye reaches first.
    var legend=present.slice().reverse().map(function(k){
      return {color:k==="not-recorded"?"var(--ink-dim)":(MODE_COLOR[k]||"var(--ink-dim)"),
        label:k,value:fmtUsd(fld(byMode[k],"cost"))};
    });
    return '<div class="hr-t">posture, by day</div>'
      +stackedDays({days:days,order:present,palette:MODE_COLOR})
      +chartLegend(legend)
      +'<p class="hr-note">Api-equivalent cost, stacked by the permission posture the transcript '
      +'recorded. <b>not-recorded</b> is spend from a session that carried no posture evidence — '
      +"held apart rather than folded into a real posture.</p>";
  }
  function sourceDonut(d){
    var src=d.bySource||{};
    var main=fld(src.main,"cost"),sub=fld(src.subagent,"cost"),total=main+sub;
    return '<div class="hr-block"><div class="hr-t">main vs subagent</div>'
      +(total?donut2({aValue:main,bValue:sub,aText:fmtUsd(main),bText:fmtUsd(sub),
        aLabel:"main thread",bLabel:"subagent",centerLabel:Math.round(main/total*100)+"%"})
        :'<div class="empty">no priced work in window.</div>')
      +'<p class="hr-note">Share of api-equivalent cost; the ring reads main-thread. Subagent work '
      +"is Claude's sidechain flag or Codex's ledger-backed thread source — either way, not a "
      +"session a human was driving.</p></div>";
  }
  function renderScoreHowRun(d){
    var body=ensureBlock("u-howrun",
      stripHtml("u-howrun","How you run","permission posture · who drove"),"u-rhythm");
    if(!body)return;
    body.innerHTML='<div class="howrun"><div class="hr-block hr-chart">'+modeChart(d)+"</div>"
      +'<div class="hr-side">'+sourceDonut(d)+"</div></div>";
  }

  function renderScoreDayBars(d){
    // cost per day
    var days=dayRows(d);
    var maxDay=0;
    for(var i=0;i<days.length;i++)maxDay=Math.max(maxDay,fld(days[i].v,"cost"));
    document.getElementById("u-days-note").textContent="api-equivalent · "+usageDays+"-day window";
    document.getElementById("u-daybars").innerHTML=days.length?days.map(function(x){
      var c=fld(x.v,"cost"), h=maxDay?Math.max(2,c/maxDay*100):2;
      var tip=x.day+" · "+fmtUsd(c)+" · "+fmtTok(fld(x.v,"tokens"))+" tok · "+fmtNum(fld(x.v,"sessions"))+" started";
      if(x.v&&x.v.sessionsActive!==undefined) tip+=" · "+fmtNum(fld(x.v,"sessionsActive"))+" active";
      return '<div class="daybar" title="'+esc(tip)+'"><div class="db-fill" style="height:'+h.toFixed(1)+'%"></div>'
        +'<span class="db-lab">'+esc(x.day.slice(8))+"</span></div>";
    }).join(""):'<div class="empty">no days in window.</div>';
  }

  function renderScoreHosts(d){
    var k;
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
      // hasOwnProperty, not a bare lookup: `name` comes from byHost's keys,
      // which the loop above deliberately widens beyond the three known
      // hosts, so `constructor`/`__proto__` would otherwise reach a
      // prototype value and land unescaped inside a class attribute.
      var dot=Object.prototype.hasOwnProperty.call(PDOT_CLASS,name)?PDOT_CLASS[name]:"c";
      return '<div class="pcard'+(idle?" idle":"")+'"><div class="ph"><span class="pdot '
        +esc(dot)+'"></span>'+esc(name)+"</div>"
        +'<div class="pv mono">'+esc(fmtUsd(cost))+"</div>"
        +'<div class="pl">'+(idle?"no sessions in window":esc(fmtNum(sess))+" sessions &middot; "+esc(fmtTok(tok))+" tokens")+"</div></div>";
    }).join("");
    var hostsNoteEl=document.getElementById("u-hosts-note");
    if(hostsNoteEl)hostsNoteEl.textContent=activeHosts+" active of "+order.length;

  }

  function renderScoreTokBar(d){
    var t=d.totals||{};
    var segs=[["cache read",t.cacheRead,"var(--warn)"],["cache write",t.cacheWrite,"var(--purple)"],
      ["output",t.output,"var(--accent)"],["input",t.input,"var(--ok)"]];
    document.getElementById("u-tokbar").innerHTML=segs.map(function(sg){
      return '<i style="width:'+pct(sg[1],t.tokens).toFixed(2)+"%;background:"+sg[2]+'"></i>';
    }).join("");
    document.getElementById("u-toklegend").innerHTML=segs.map(function(sg){
      return '<span class="lg"><i style="background:'+sg[2]+'"></i>'+esc(sg[0])+" <b>"+esc(fmtTok(sg[1]))+"</b></span>";
    }).join("");

  }

  function renderScorePunchcard(d){
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
    var PUNCH_NOTE="Counts responses, not elapsed time, and INCLUDES delegated subagent responses "
      +"— a long agentic run dispatching subagents fills these cells even when nobody was typing. "
      +"The how-you-run panel carries the main/subagent split.";
    document.getElementById("u-punch").innerHTML=pcMax
      ?pcHtml+'<p class="hr-note">'+esc(PUNCH_NOTE)+"</p>"
      :'<div class="empty">no responses in window.</div>';

  }

  // ── tool mix and model mix over time ──────────────────────────────────────
  var TOOL_TOP=8;
  function toolRows(d){
    var map=d.byTool||{},list=[],k;
    for(k in map)list.push({name:k,n:Number(map[k])||0});
    list.sort(function(a,b){return b.n-a.n;});
    if(!list.length)return '<div class="empty">no tool calls recorded in window.</div>';
    var top=list.slice(0,TOOL_TOP),tail=list.slice(TOOL_TOP);
    var other=tail.reduce(function(s,x){return s+x.n;},0),max=top[0].n;
    var rows=top.map(function(x){
      return {label:x.name,value:fmtNum(x.n),share:pct(x.n,max),dim:false};
    });
    // The tail is FOLDED, never dropped: those calls happened, and a top-8
    // list that quietly loses the rest misstates the total every share above
    // it is read against. Dim, because Other is a residue, not a tool.
    if(other>0)rows.push({label:"Other ("+tail.length+" tool"+(tail.length===1?"":"s")+")",
      value:fmtNum(other),share:pct(other,max),dim:true});
    return rankedRows(rows);
  }

  // Four series is the most a stacked day column can carry and still be read
  // apart at this size; the rest fold into one de-emphasised band. Colors are
  // assigned BY RANK, so the palette is deterministic rather than dependent on
  // key order, and every band is named in the legend beside the chart.
  var FAMILY_PALETTE=["var(--accent)","var(--purple)","var(--ok)","var(--warn)"];
  var FAMILY_TOP=4;
  function familyTotals(rows){
    var tot={},i,k;
    for(i=0;i<rows.length;i++){
      var parts=(rows[i].v&&rows[i].v.byModelFamily)||{};
      for(k in parts)tot[k]=(tot[k]||0)+(Number(parts[k])||0);
    }
    return tot;
  }
  function topFamilies(tot){
    var list=[],k;
    // modelFamily()'s own 'other' catch-all never competes for a top slot — it
    // is the residue bucket, so it belongs in the fold no matter how big it is.
    for(k in tot)if(k!=="other")list.push({name:k,cost:tot[k]});
    list.sort(function(a,b){return b.cost-a.cost;});
    return list.slice(0,FAMILY_TOP).map(function(x){return x.name;});
  }
  function foldFamilies(parts,keep){
    var out={other:0},k;
    for(k in parts){
      var v=Number(parts[k])||0;
      if(keep.indexOf(k)>=0)out[k]=(out[k]||0)+v; else out.other+=v;
    }
    return out;
  }
  function modelMix(d){
    var rows=dayRows(d),tot=familyTotals(rows),keep=topFamilies(tot);
    if(!keep.length&&!(tot.other>0))return '<div class="empty">no model spend in window.</div>';
    var palette={};
    keep.forEach(function(name,i){palette[name]=FAMILY_PALETTE[i%FAMILY_PALETTE.length];});
    var days=rows.map(function(x){
      return {day:x.day,parts:foldFamilies((x.v&&x.v.byModelFamily)||{},keep)};
    });
    var otherTotal=days.reduce(function(s,x){return s+(x.parts.other||0);},0);
    var legend=keep.map(function(name){
      return {color:palette[name],label:name,value:fmtUsd(tot[name])};
    });
    if(otherTotal>0)legend.push({color:"var(--ink-dim)",label:"other",value:fmtUsd(otherTotal)});
    // Bottom-up: the fold sits at the base and the biggest family paints on
    // top, so the legend read top-down is the stack read top-down.
    return stackedDays({days:days,order:["other"].concat(keep.slice().reverse()),palette:palette})
      +chartLegend(legend)
      +'<p class="hr-note">Model ids are folded to a coarse family (<b>opus</b>, <b>gpt-5</b>, …). '
      +"An id the fold does not recognise lands in <b>other</b> — never a guessed family, and never "
      +"dropped, because its spend still has to land somewhere.</p>";
  }
  function renderScoreMix(d){
    var pair=ensureBlock("u-toolmix",'<div class="two">'
      +stripHtml("u-toolmix","Tool mix","invocations · top 8, tail folded")
      +stripHtml("u-modelmix","Model mix over time","api-equivalent cost by model family")
      +"</div>","u-punch");
    if(!pair)return;
    pair.innerHTML=toolRows(d)
      +'<p class="hr-note">Invocations as each host recorded them, under each host\'s own tool '
      +"names — nothing is renamed to make two hosts line up. A host that records no tool calls "
      +"contributes nothing here rather than a zero, so these totals are not a cross-host "
      +"comparison of how much tooling each one did.</p>";
    var mix=document.getElementById("u-modelmix");
    if(mix)mix.innerHTML=modelMix(d);
  }

  // ── reliability ───────────────────────────────────────────────────────────
  var REL_TIP="Turns that never resolved to a model — a dropped connection, a rate-limit rejection, "
    +"an auth failure. They are excluded from the model list (there is no model to attribute them "
    +"to) and surfaced here instead of vanishing.\nRate is exceptions ÷ responses × 1000.";
  var ABORT_TIP="Turns the transcript recorded as interrupted — the answer was stopped mid-flight. "
    +"Counted apart from exceptions: an abort is a choice, not a failure.\n"
    +"CODEX ONLY. Only codex rollouts carry an interrupt signal (turn_aborted); claude and "
    +"opencode transcripts record nothing when you stop a turn. So the count and its rate are "
    +"over codex responses alone, and a window with no codex sessions shows — (not 0), because "
    +"nothing in it could have recorded an interrupt.";
  // The per-day series rides the SAME first-billed-day attribution the session
  // count uses, which is not the moment a turn dropped: a session that spans
  // midnight lands all of its exceptions on one day. Said on the panel, because
  // a reader will otherwise take a peak as "something broke that afternoon".
  var REL_TREND_NOTE="Attributed to the day each session first billed — not the moment a turn "
    +"dropped, so a session spanning midnight lands all of its exceptions on one day. A session that "
    +"never billed has no day to attribute to and appears in neither this line nor the counts above.";

  function relRate(t){
    var r=Number(t&&t.responses)||0;
    return r?(Number(t.exceptions)||0)/r*1000:null;
  }
  // Direction is stated in WORDS and in a glyph as well as in color — a
  // reader who cannot separate the warn and ok tokens still gets the finding.
  function relFlag(cur,prev){
    if(cur==null||prev==null)return "";
    if(cur>prev)return '<span class="rel-flag" data-sev="warn"><i aria-hidden="true">▲</i>'
      +"higher than the previous window</span>";
    if(cur<prev)return '<span class="rel-flag" data-sev="ok"><i aria-hidden="true">▼</i>'
      +"lower than the previous window</span>";
    return '<span class="rel-flag" data-sev="flat"><i aria-hidden="true">•</i>'
      +"unchanged from the previous window</span>";
  }
  function relStat(o){
    return '<div class="rel-stat" title="'+esc(o.tip)+'">'
      +'<span class="rel-k">'+esc(o.label)+"</span>"
      +'<span class="rel-v tnum">'+esc(o.value)+"</span>"
      +'<span class="rel-sub">'+esc(o.sub)+"</span>"+(o.flag||"")+"</div>";
  }
  // The single worst day, named. "Worst" is a fact the counts already carry —
  // no threshold is invented to decide what counts as a spike, because any
  // constant this file picked would be a judgement the data never made.
  function relWorstDay(rows){
    var worst=null;
    for(var i=0;i<rows.length;i++){
      var n=fld(rows[i].v,"exceptions");
      if(n>0&&(!worst||n>worst.n))worst={day:rows[i].day,n:n};
    }
    return worst;
  }
  function relTrend(d){
    var rows=dayRows(d),series=rows.map(function(x){return fld(x.v,"exceptions");});
    var total=series.reduce(function(a,n){return a+n;},0);
    if(!total)return '<div class="rel-trend"><div class="hr-t">exceptions by day</div>'
      +'<div class="empty">no exceptions on any day in this window.</div></div>';
    var worst=relWorstDay(rows);
    // Icon, words and color together — the day is named in text, so the flag
    // survives a reader who cannot separate the status tokens.
    var flag=worst?'<span class="rel-flag" data-sev="warn"><i aria-hidden="true">▲</i>worst day '
      +esc(worst.day.slice(5))+" &middot; "+esc(fmtNum(worst.n))+" of "+esc(fmtNum(total))+"</span>":"";
    return '<div class="rel-trend"><div class="hr-t">exceptions by day</div>'
      +sparklineSvg(series,{w:640,h:44})+flag+"</div>";
  }
  function renderScoreReliability(d){
    var body=ensureBlock("u-reliability",
      stripHtml("u-reliability","Reliability","turns that never landed"),"u-models");
    if(!body)return;
    var t=d.totals||{},p=(d.previous&&d.previous.totals)||null;
    var cur=relRate(t),exc=Number(t.exceptions)||0,ab=Number(t.aborts)||0,resp=Number(t.responses)||0;
    // aborts is CODEX-ONLY evidence: turn_aborted is the only interrupt signal
    // any host writes, so a claude-or-opencode window renders "—", not a 0 that
    // reads as "you never interrupted a turn". The rate's denominator is codex
    // responses for the same reason — dividing codex aborts by every host's
    // responses dilutes it by an arbitrary amount that depends on host mix.
    var cx=(d.byHost&&d.byHost.codex)||null;
    var cxSess=Number(cx&&cx.sessions)||0,cxResp=Number(cx&&cx.responses)||0;
    body.innerHTML='<div class="rel">'
      +relStat({label:"exceptions / 1k responses",value:cur==null?"—":cur.toFixed(1),
        sub:fmtNum(exc)+" of "+fmtNum(resp)+" responses",tip:REL_TIP,
        flag:relFlag(cur,p?relRate(p):null)})
      +relStat({label:"aborted turns",value:cxSess?fmtNum(ab):"—",
        sub:cxSess
          ?(cxResp?fmtRatio(ab/cxResp*1000)+" per 1k codex responses":"no codex responses in window")
          :"no codex sessions — no other host records interrupts",
        tip:ABORT_TIP})
      +"</div>"+relTrend(d)+'<p class="hr-note">'+esc(REL_TREND_NOTE)+"</p>";
  }

  function renderScoreModels(d){
    var t=d.totals||{};
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

  }

  function renderScoreOpenRouter(d){
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

  }

  function renderScoreProjects(d){
    var projects=entries(d.byProject), pMax=projects.length?projects[0].cost:0;
    var shown=projects.slice(0,8);
    document.getElementById("u-projects-note").textContent=
      projects.length>8?("top 8 of "+projects.length):(projects.length+" project"+(projects.length===1?"":"s"));
    document.getElementById("u-projects").innerHTML=shown.length?shown.map(function(pr){
      return bar(esc(pr.name),fmtUsd(pr.cost),fmtNum(fld(pr.v,"sessions"))+" sess · "+fmtMins(fld(pr.v,"minutes")),
        pct(pr.cost,pMax),true);
    }).join(""):'<div class="empty">no projects in window.</div>';

  }

  function renderScoreCategories(d){
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

  export function renderScore(d){
    renderScoreHero(d);
    renderScoreCadence(d);
    renderScoreDayBars(d);
    // Order is load-bearing here and nowhere else in this list: how-you-run
    // anchors its container to the rhythm strip, which renderScoreRhythm has
    // to have inserted first.
    renderScoreRhythm(d);
    renderScoreHowRun(d);
    renderScoreHosts(d);
    renderScoreTokBar(d);
    renderScorePunchcard(d);
    renderScoreMix(d);
    renderScoreModels(d);
    renderScoreReliability(d);
    renderScoreOpenRouter(d);
    renderScoreProjects(d);
    renderScoreCategories(d);
  }

  // ══ Limits view (ADR-0010) ═════════════════════════════════════════════════
  export var LIMITS=null, limitsBusy=false;

  export function loadLimits(){
    if(limitsBusy)return Promise.resolve();
    limitsBusy=true;
    return fetch("/api/limits?days="+usageDays,{cache:"no-store",headers:authHeaders()})
      .then(function(r){return r.json();})
      .then(function(d){LIMITS=d&&!d.error?d:{error:(d&&d.error)||"limits unavailable"};})
      .catch(function(){LIMITS={error:"limits unavailable"};})
      .then(function(){limitsBusy=false; renderLimits();if(usageView==="models")renderModelLifecycle();});
  }

  // "as of 3m ago" — an epoch-ms fetchedAt against the browser clock. Stale is
  // LABELLED, never hidden: a yesterday's-number bar with no timestamp is a lie
  // of omission.
  export function limAge(ms){
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
  // Where this window's own CLOCK is, as a share of its duration — the mark a
  // straight-line burn would be sitting on right now, which is what turns a
  // level into "ahead of pace" or "behind". Both halves come from the limits
  // payload the meter already reads: `resetsAt` (epoch seconds) says when the
  // window ends, `windowMinutes` how long it runs, so elapsed = duration −
  // remaining. Nothing is fetched and nothing is assumed about window length.
  //
  // null — not a clamp — whenever the arithmetic falls outside [0, duration]:
  // the snapshot is then older than its own window (it has already reset) or
  // the browser clock disagrees with the vendor's, and a tick pinned to 0% or
  // 100% would state a position instead of admitting it cannot compute one.
  function paceShare(resetSec,windowMinutes){
    var mins=Number(windowMinutes);
    if(!resetSec||!isFinite(resetSec)||!isFinite(mins)||mins<=0)return null;
    var total=mins*60000,elapsed=total-(resetSec*1000-Date.now());
    if(!isFinite(elapsed)||elapsed<0||elapsed>total)return null;
    return elapsed/total*100;
  }
  function paceTick(resetSec,windowMinutes){
    var at=paceShare(resetSec,windowMinutes);
    if(at==null)return "";
    return '<i class="pace" style="left:'+at.toFixed(1)+'%" title="'
      +esc(at.toFixed(0)+"% of this window's time has elapsed — a steady burn would sit here")
      +'"></i>';
  }
  // Rendered only when at least one row actually carries a tick, so the key
  // never explains a mark that is not on screen.
  var PACE_LEGEND='<div class="legend" style="margin-top:11px"><span class="lg">'
    +'<i class="pace-key"></i>tick = share of the window&rsquo;s time elapsed &middot; '
    +"fill past it is ahead of a steady burn</span></div>";

  // One utilization row on the shared .mrow grid; fill color says how close to
  // the cap this window is (ok <70, warn ≥70, fail ≥90).
  function limRow(label,usedPercent,resetSec,sub,windowMinutes){
    var p=Math.max(0,Math.min(100,Number(usedPercent)||0));
    var col=p>=90?"var(--fail)":(p>=70?"var(--warn)":"var(--ok)");
    return '<div class="mrow"><span class="mname" title="'+esc(label)+'">'+esc(label)+"</span>"
      +'<span class="mbar"><i style="width:'+p.toFixed(1)+"%;background:"+col+'"></i>'
      +paceTick(resetSec,windowMinutes)+"</span>"
      +'<span class="mval mono">'+p.toFixed(0)+"%</span>"
      +'<span class="msub mono">'+esc(sub||resetTxt(resetSec))+"</span></div>";
  }

  // renderLimits was one CC-28 function mixing the Claude window, the Codex
  // lane, and the insights panel. Split by region; each keeps its original
  // logic verbatim, so the rendered DOM is unchanged.
  function renderLimitsClaude(){
    var claudeEl=document.getElementById("u-lim-claude");
    var c=LIMITS.claude;
    var cn=document.getElementById("u-lim-claude-note");
    if(c&&c.windows&&c.windows.length){
      // Claude's tee is push-only: FRESH means a session wrote it in the last
      // 10 minutes; anything older gets the stale badge rather than silence.
      if(cn)cn.textContent="statusline tee · "+limAge(c.fetchedAt)+(limStale(c.fetchedAt,600000)?" · stale":"");
      var paced=false;
      claudeEl.innerHTML=c.windows.map(function(w){
        if(paceShare(w.resetsAt,w.windowMinutes)!=null)paced=true;
        return limRow("claude · "+(w.label||w.id),w.usedPercent,w.resetsAt,null,w.windowMinutes);
      }).join("")+(paced?PACE_LEGEND:"");
    }else{
      if(cn)cn.textContent="no data";
      claudeEl.innerHTML='<div class="empty">no Claude limit data yet &mdash; it arrives while a Claude Code session runs '
        +"with the kit's managed statusline (Pro/Max plans only). Run one session, then revisit.</div>";
    }

  }

  function renderLimitsCodex(){
    var codexEl=document.getElementById("u-lim-codex");
    var x=LIMITS.codex;
    var xn=document.getElementById("u-lim-codex-note");
    if(x&&x.lanes&&x.lanes.length){
      if(xn)xn.textContent=(x.planType?("plan "+x.planType+" · "):"")+"app-server · "+limAge(x.fetchedAt);
      var html="",paced=false;
      for(var i=0;i<x.lanes.length;i++){
        var lane=x.lanes[i];
        for(var j=0;j<(lane.windows||[]).length;j++){
          var w=lane.windows[j];
          if(paceShare(w.resetsAt,w.windowMinutes)!=null)paced=true;
          html+=limRow(lane.name+" · "+(w.label||""),w.usedPercent,w.resetsAt,null,w.windowMinutes);
        }
        if(!(lane.windows||[]).length)html+=limRow(lane.name,0,null,"no window reported");
      }
      if(paced)html+=PACE_LEGEND;
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

  }

  function renderLimitsInsights(){
    var ins=Array.isArray(LIMITS.insights)?LIMITS.insights:[];
    document.getElementById("u-lim-insights").innerHTML=ins.length
      ?ins.map(insightCard).join("")
      :'<div class="empty">no limit findings &mdash; nothing is ahead of pace and no arbitrage is open.</div>';
  }

  function renderLimits(){
    var claudeEl=document.getElementById("u-lim-claude");
    var codexEl=document.getElementById("u-lim-codex");
    if(!claudeEl||!codexEl)return;
    if(!LIMITS){claudeEl.innerHTML='<div class="empty">loading&hellip;</div>'; codexEl.innerHTML='<div class="empty">loading&hellip;</div>'; return;}
    if(LIMITS.error){claudeEl.innerHTML='<div class="empty">'+esc(LIMITS.error)+"</div>"; codexEl.innerHTML=""; return;}

    renderLimitsClaude();
    renderLimitsCodex();
    renderLimitsInsights();
  }

  // ══ Prompts view (METRICS.md §21) ══════════════════════════════════════════
  // Panels are built by usage-prompts.mjs (pure string builders); this function
  // owns only the DOM writes and the captions, which name the window every
  // figure was computed over — a figure whose window is not stated is a figure
  // a reader will attach to the wrong span.
  export function renderPrompts(d){
    var p=d&&d.prompts;
    var kpis=document.getElementById("u-pr-kpis");
    if(!kpis)return;
    if(!p){
      kpis.innerHTML='<div class="empty">this window carries no prompt-fingerprint layer &mdash; '
        +'the sessions in it were parsed before prompt fingerprints shipped. Re-scan to populate it.</div>';
      var coachEl=document.getElementById("u-pr-coaching");
      if(coachEl)coachEl.innerHTML='<div class="empty">coaching needs the prompt-fingerprint layer, '
        +'same as the rest of this view &mdash; nothing to show until a re-scan populates it.</div>';
      return;
    }
    var win=windowLabel();
    kpis.innerHTML=promptKpis(p);
    setText("u-pr-prov-note",win+" · every fingerprinted user-role turn");
    document.getElementById("u-pr-provenance").innerHTML=provenancePanel(p);
    setText("u-pr-steer-note",win+" · typed prompts only");
    document.getElementById("u-pr-steer").innerHTML=steerPanel(p);
    document.getElementById("u-pr-taps").innerHTML=tapLengthPanel(p);
    document.getElementById("u-pr-taxonomy").innerHTML=taxonomyPlaceholder();
    setText("u-pr-hosts-note",win+" · per host, unequal histories");
    document.getElementById("u-pr-hosts").innerHTML=hostInterplay(p);
    setText("u-pr-patterns-note",patternsNote(p,win));
    document.getElementById("u-pr-reasks").innerHTML=reAskPanel(p);
    document.getElementById("u-pr-patterns").innerHTML=patternsTable(p);
    document.getElementById("u-pr-coaching").innerHTML=coachingPanel(p);
  }
  function setText(id,txt){var el=document.getElementById(id);if(el)el.textContent=txt;}
  function windowLabel(){return usageDays>=365?"all history":"last "+usageDays+"d";}
  // The projection ships EVERY recurring cluster; the table draws a slice and
  // says so in its own overflow line. This caption reports the true total, so
  // the header and the table can never tell two different stories about how
  // much repetition was found.
  function patternsNote(p,win){
    var pat=p.patterns;
    if(!pat)return win;
    var n=(pat.clusters||[]).length;
    return win+" · "+n+" recurring cluster"+(n===1?"":"s")
      +" · no prompt text on this surface";
  }

  export function renderFindings(d){
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
          return "<li><a href=\""+esc(sc.url)+"\" target=\"_blank\" rel=\"noreferrer noopener\">"+esc(sc.label)+"</a></li>";
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

  // ── per-session chips ─────────────────────────────────────────────────────
  // Evidence the row already carries, shown only where the transcript
  // established it. An ABSENT chip is itself the signal that the fact was
  // never recorded — a chip that appeared with a guessed value would be
  // indistinguishable from one that was measured.
  var LAT_CHIP_TIP="This session's median response latency, interpolated from its own latency "
    +"histogram — the same bucket math the window's rhythm panel uses.\ncodex host-measured · "
    +"claude/opencode derived from event gaps — not streaming TTFT.\nA value in the last bucket "
    +"has no upper edge and is printed with ≥.";
  function sessionP50(sx){
    return Array.isArray(sx.latHist)?bucketPercentile(sx.latHist,LAT_EDGES,0.5):null;
  }
  // The posture the transcript recorded, and NOTHING when it recorded none: an
  // unobserved or unmapped raw value is not a posture, and a badge that guessed
  // one would read exactly like an observed one. `modeRaw` is the host's own
  // spelling, projected onto the session row by v11Projection, and rides in
  // this badge's tooltip; the row's detail strip is where an unmapped raw
  // value is surfaced, since there is no classified name to put on a badge.
  function modeBadge(sx){
    var mode=reportedIdentity(sx.mode);
    if(!mode)return "";
    var raw=reportedIdentity(sx.modeRaw);
    return '<span class="s-chip s-mode" data-mode="'+esc(mode)+'" title="'
      +esc("permission posture: "+mode
        +(raw?" · recorded by the host as \""+raw+"\"":" · the host's own spelling was not recorded"))
      +'">'+esc(mode)+"</span>";
  }
  // Context fill, and only when BOTH halves were observed: the last turn's
  // context tokens AND that model's window. Codex records a window; claude and
  // opencode do not, and this page carries no published-window table to fall
  // back on — so the chip is omitted rather than divided by a guessed
  // denominator, which would be a fabricated percentage.
  function ctxChip(sx){
    var used=Number(sx.ctxLastTokens),win=Number(sx.ctxWindow);
    if(!isFinite(used)||!isFinite(win)||used<=0||win<=0)return "";
    return '<span class="s-chip" title="'
      +esc("context at the last turn: "+fmtTok(used)+" of "+fmtTok(win)
        +" tokens — both recorded by the transcript")
      +'">ctx '+esc(Math.min(100,used/win*100).toFixed(0))+"%</span>";
  }
  function sessionChips(sx){
    var out="",len=Number(sx.lenSeconds)||0,p50=sessionP50(sx);
    if(len>0)out+='<span class="s-chip" title="'
      +esc("engaged length — this session's active sub-intervals unioned, split at 15-minute "
        +"silences; not its first-to-last span, which the duration column shows")
      +'">'+esc(fmtSecs(len))+"</span>";
    if(p50!=null)out+='<span class="s-chip" title="'+esc(LAT_CHIP_TIP)+'">p50 '
      +esc(fmtAtLeast(p50,60,fmtSecs))+"</span>";
    return out+modeBadge(sx)+ctxChip(sx);
  }

  // THREE states, not two. A transcript that recorded a posture the taxonomy
  // does not map still recorded a posture: printing "no posture evidence in
  // this transcript" over a modeRaw sitting on the same row is a fabrication
  // in the opposite direction from the usual one — denying data that exists.
  // The host's own spelling is shown instead, labelled unrecognized so it is
  // never mistaken for a classified posture.
  function postureLine(sx){
    var modeRaw=reportedIdentity(sx.modeRaw),modeName=reportedIdentity(sx.mode);
    if(modeName)return esc(modeName)+" <span class='sd-conf'>("
      +esc(modeRaw?"recorded by the host as \""+modeRaw+"\"":"host spelling not recorded")+")</span>";
    return modeRaw
      ? "Unrecognized <span class='sd-conf'>(host recorded \""+esc(modeRaw)+"\" — not in this taxonomy)</span>"
      : "Not recorded <span class='sd-conf'>(no posture evidence in this transcript)</span>";
  }

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
    // Posture and rhythm are the row's own v11 evidence, spelled out here
    // where the chips only had room for a badge. Both follow this strip's
    // never-omit-a-line rule: a fact that was measured and found absent reads
    // "Not recorded"/"—", not silence, which would teach the reader the field
    // does not exist (ADR-0009 §5).
    var posture=postureLine(sx);
    var p50=sessionP50(sx);
    var rhythm="engaged "+((Number(sx.lenSeconds)||0)>0?fmtSecs(sx.lenSeconds):"—")
      +" · p50 "+(p50==null?"—":fmtAtLeast(p50,60,fmtSecs))
      +" · latency samples "+fmtNum(Number(sx.latCount)||0)
      // Same capability rule as the reliability panel, applied per row: only a
      // codex transcript can record an interrupt, so a claude/opencode row
      // reads "not recorded" rather than a measured-looking 0.
      +" · aborts "+(sx.host==="codex"?fmtNum(Number(sx.aborts)||0):"not recorded for this host");
    var rows=[["execution host",esc(identityName(sx.host))],["inference provider",esc(provider)+" <span class='sd-conf'>("+esc(providerContext)+")</span>"],["models",esc(models)],["posture",posture],["rhythm",esc(rhythm)],["basis",esc(basis)+conf],["tokens",esc(toks)],
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
  export function sessionRow(sx){
    var host=reportedIdentity(sx.host)||"unknown";
    var provider=reportedIdentity(sx.provider);
    var modelList=(Array.isArray(sx.models)?sx.models:[]).filter(function(model){return reportedIdentity(model);});
    var identityTip="Execution host: "+identityName(host)+" · Inference provider: "+identityName(provider)+" · Model: "+(modelList.length?modelList.join(", "):"Not recorded");
    var cat=sx.category||"Unclassified";
    var uncl=(cat==="Unclassified");
    var weak=(typeof sx.confidence==="number"&&sx.confidence<0.6)?"0":"1";
    var when=sx.start?new Date(sx.start):null;
    var whenTxt=when&&!isNaN(when)?when.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"—";
    // Ids are derived from raw filesystem names (usage-index.mjs listClaude /
    // listClaudeSubagents), NOT validated at index time — parseSessionId is a
    // request-path validator that never runs here — and a namespaced subagent
    // id contains '/', which the charset once claimed for them does not.
    // POSIX filenames permit '"', '<' and '>', so esc() is LOAD-BEARING, not
    // belt-and-braces: every render of sx.id must keep it, or a project
    // directory named with a quote breaks out of these attributes and, under
    // this page's script-src 'unsafe-inline', executes.
    var sid=esc(sx.id);
    var wt=sx.worktree!=null?'<span class="s-wt" title="git worktree — the repo is the project">⑂'+esc(sx.worktree)+"</span>":"";
    return '<div class="srow" data-id="'+sid+'" title="open transcript">'
      +'<button class="s-exp" type="button" aria-expanded="false" aria-controls="sd-'+sid+'"'
        +' title="show identity, model, usage, and classification details" aria-label="show identity, model, usage, and classification details">&rsaquo;</button>'
      +'<span class="s-host s-'+esc(host)+'" title="'+esc(identityTip)+'" aria-label="Execution host: '+esc(identityName(host))+'">'+esc(identityName(host))+"</span>"
      +'<span class="s-title">'+esc(sx.title||"(untitled)")+wt+"</span>"
      +'<span class="cat'+(uncl?" uncl":"")+'" data-w="'+weak+'">'+esc(cat)+"</span>"
      +'<span class="s-chips">'+sessionChips(sx)+"</span>"
      +'<span class="s-when mono">'+esc(whenTxt)+"</span>"
      +'<span class="s-dur mono">'+esc(fmtMins(sx.minutes))+"</span>"
      +'<span class="s-turns mono">'+esc((sx.prompts||0)+"/"+(sx.responses||0))+"</span>"
      +'<span class="s-tok mono">'+esc(fmtTok(sx.tokens))+"</span>"
      +'<span class="s-cost mono">'+esc(fmtUsd(sx.cost))+"</span>"
      +'<button class="s-tx" type="button" data-tx="'+sid+'" title="open transcript" aria-label="open transcript">&#9707;</button>'
    +"</div>"+sdetail(sx);
  }

  export function renderSessions(d){
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
  // The masker emits "<prefix>…redacted" (sk-…redacted, Bearer …redacted).
  // This used to hunt for ***, ••• or [REDACTED] — sentinels nothing ever
  // produced — so no .masked span was ever created and the styling below was
  // dead code. There is deliberately NO click-to-reveal: masking happens
  // server-side and the original never reaches the browser, so there is nothing
  // here to reveal. Marking it is the whole feature.
  function markRedactions(text){
    return esc(text).replace(/([A-Za-z_.-]*…redacted)/g,function(m){
      return '<span class="masked" title="masked server-side — the original was never sent to this page">'+m+"</span>";
    });
  }

  // Harness sentinel markup — the XML wrappers Claude Code writes into
  // transcript text (<command-name>, <system-reminder>, <local-command-*>) —
  // rendered as styled structure instead of literal angle-bracket soup.
  // PRESENTATION ONLY: the wrapped content is kept verbatim (ADR-0009 §8's
  // no-silent-alteration rule); only the wrapper tags become styling. Runs on
  // ESCAPED html (after markRedactions), so patterns match &lt;tag&gt;. An
  // unmatched tag (e.g. cut mid-sentinel by turn truncation) is left raw.
  var H_TAGS={"system-reminder":"system reminder","local-command-caveat":"caveat",
    "local-command-stdout":"command output","local-command-stderr":"command stderr",
    "bash-stdout":"bash output","bash-stderr":"bash stderr","task-notification":"task notification"};
  function fmtHarness(html){
    return html
      .replace(/&lt;command-name&gt;([\s\S]*?)&lt;\/command-name&gt;\s*(?:&lt;command-message&gt;([\s\S]*?)&lt;\/command-message&gt;\s*)?(?:&lt;command-args&gt;([\s\S]*?)&lt;\/command-args&gt;)?/g,
        function(_,name,msg,args){
          var n=name.trim(), a=(args||"").trim(), m=(msg||"").trim();
          return '<span class="h-cmd"'+(m&&m!==n.replace(/^\//,"")?' title="'+m+'"':"")
            +'>'+n+(a?" "+a:"")+"</span>";
        })
      // bash-input is the person's own "! command" — a chip, prefixed so it
      // reads as the shell invocation it was, not as prose.
      .replace(/&lt;bash-input&gt;([\s\S]*?)&lt;\/bash-input&gt;/g,
        function(_,cmd){return '<span class="h-cmd" title="shell command run with the ! prefix">! '+cmd.trim()+"</span>";})
      .replace(/&lt;(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification)&gt;\s*([\s\S]*?)\s*&lt;\/\1&gt;/g,
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
  var TRUNC_MARK="\n…[truncated]";
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

  export function renderTranscript(){
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

