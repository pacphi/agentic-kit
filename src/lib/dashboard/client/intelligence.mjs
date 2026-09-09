// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { renderAbout } from './about.mjs';
import { DASH_TOKEN, activeTab, esc, overviewView, positionThumb } from './bootstrap.mjs';
import { renderModelSummary } from './model-lifecycle.mjs';
import { renderHistory, renderNotice, renderPanels, renderVerdict } from './overview.mjs';
import { POLL_COOLDOWN_MS, pollOn, pollStatus } from './poll.mjs';
import { fmtNum, kpi } from './usage.mjs';

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

  // The census explainer (ADR-0027). Two counts on two tabs are allowed to
  // differ — they answer different questions — but the user must be able to
  // find out WHICH question each answered. This is that affordance; it is the
  // reason the redundant "N projects tracked on this machine" caption could be
  // dropped rather than merely reworded.
  function renderCensus(census){
    var box=document.getElementById("mw-census");
    var body=document.getElementById("mw-census-body");
    if(!box||!body)return;
    // No census means discovery was injected — say nothing rather than invent a
    // machine-wide figure from a fixture.
    if(!census||!census.counts){box.hidden=true;body.innerHTML="";box.open=false;return;}
    var c=census.counts;
    var html='<p class="mw-census-line">This panel counts <b>'+fmtNum(c.learning)+'</b> project'
      +(c.learning===1?"":"s")+" &mdash; "+esc(census.note||"")+".</p>";
    html+='<p class="mw-census-line">Measured from <b>'+fmtNum(c.everSeen)+'</b> project'
      +(c.everSeen===1?"":"s")+" any host has ever recorded a session in. Of those, <b>"
      +fmtNum(c.onDisk)+"</b> still exist on disk and <b>"+fmtNum(c.gitRepos)
      +"</b> are git repositories. Other tabs count over their own time window, "
      +"so a smaller number there is a shorter window, not a missing project.</p>";
    html+='<p class="mw-census-line">Directories that belong to one repository &mdash; a sub-folder a '
      +"session ran in, or a throwaway agent worktree &mdash; are folded into that one project here.</p>";
    if(c.complete===false){
      html+='<p class="mw-census-caveat">At least one transcript could not be read, '
        +"so every figure above is a lower bound.</p>";
    }
    body.innerHTML=html;
    box.hidden=false;
  }

  var INTEL_SCOPE_GROUPS=[['repository','Git repositories'],['worktree','Git worktrees'],['user','User-level learning'],['unknown','Other / unclassified']];
  function intelScopeRows(rows,scope){
    return rows.filter(function(p){
      var kind=['repository','worktree','user'].includes(p.learningScope)?p.learningScope:'unknown';
      return kind===scope;
    }).sort(function(a,b){return String(a.label||'').localeCompare(String(b.label||''),undefined,{sensitivity:'base',numeric:true})
      ||String(a.key||a.path||'').localeCompare(String(b.key||b.path||''));});
  }

  function machineWideRow(p){
    var lastMs=Number(p.lastAdaptation)||0;
    var lastTxt=lastMs?ago(Math.max(0,Math.round((Date.now()-lastMs)/1000))):"—";
    var stores=Array.isArray(p.learningState)?p.learningState:[];
    var storeHtml=stores.length?'<span class="mw-stores" title="'+esc(stores.join(' · '))+'">'
      +stores.map(function(s){return '<i class="mw-store" data-store="'+esc(String(s).replace(/^[.]/,''))+'"></i>';}).join('')+'</span>':'';
    var label=p.label||'(unlabeled)';
    return '<div class="mw-row mw-data-row" role="row">'
      +'<span class="mw-name" role="cell" title="'+esc(label)+'">'+esc(label)+storeHtml+'</span>'
      +'<span class="mw-val mono" role="cell">'+esc(fmtNum(p.patternsLearned))+'</span>'
      +'<span class="mw-val mono" role="cell">'+esc(fmtNum(p.patternStoreCount))+'</span>'
      +'<span class="mw-val mono" role="cell" title="'+esc(lastTxt)+'">'+esc(lastTxt)+'</span></div>';
  }

  function machineWideGroup(group,rows){
    var id='mw-group-'+group[0];
    return '<section class="mw-group" data-learning-scope="'+group[0]+'" aria-labelledby="'+id+'">'
      +'<h3 id="'+id+'">'+esc(group[1])+'<span>'+esc(fmtNum(rows.length))+'</span></h3>'
      +'<div class="mw-group-scroll" role="region" aria-label="'+esc(group[1])+' learning rows" tabindex="0">'
      +'<div role="table" aria-labelledby="'+id+'"><div class="mw-row mw-head" role="row">'
      +'<span role="columnheader">Project</span><span class="mw-val" role="columnheader">Patterns learned</span>'
      +'<span class="mw-val" role="columnheader">Pattern store</span><span class="mw-val" role="columnheader">Last active</span></div>'
      +'<div role="rowgroup">'+rows.map(machineWideRow).join('')+'</div></div></div></section>';
  }

  function renderMachineWide(mw){
    var totals=(mw&&mw.totals)||{};
    var perProject=Array.isArray(mw&&mw.perProject)?mw.perProject.slice():[];
    var hero=document.getElementById("mw-hero");
    if(hero)hero.innerHTML=
      kpi("patterns learned",fmtNum(totals.patternsLearnedLifetime),"lifetime &middot; every tracked project","")
      +kpi("projects tracked",fmtNum(totals.projectCount),"with memory or intelligence state","")
      +kpi("most active project",totals.mostActiveProject||"—","by most recent learning adaptation","accent");
    var table=document.getElementById("mw-table");
    if(!table)return;
    if(!perProject.length){table.innerHTML='<div class="empty">no projects discovered on this machine.</div>';return;}
    var positions={};
    var active=document.activeElement,focusedScope=active&&active.classList&&active.classList.contains('mw-group-scroll')
      ?active.closest('.mw-group').getAttribute('data-learning-scope'):null;
    if(table.querySelectorAll)Array.from(table.querySelectorAll('.mw-group')).forEach(function(section){
      positions[section.getAttribute('data-learning-scope')]=section.querySelector('.mw-group-scroll').scrollTop;
    });
    table.innerHTML=INTEL_SCOPE_GROUPS.map(function(group){
      var rows=intelScopeRows(perProject,group[0]);
      return rows.length?machineWideGroup(group,rows):'';
    }).join('');
    if(table.querySelectorAll)Array.from(table.querySelectorAll('.mw-group')).forEach(function(section){
      var region=section.querySelector('.mw-group-scroll'),scope=section.getAttribute('data-learning-scope');
      region.scrollTop=positions[scope]||0;
      if(scope===focusedScope)region.focus({preventScroll:true});
    });
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
    sel.innerHTML=INTEL_SCOPE_GROUPS.map(function(group){
      var rows=intelScopeRows(intelProjects,group[0]);
      if(!rows.length)return '';
      return '<optgroup label="'+esc(group[1])+'">'+rows.map(function(p){
        return '<option value="'+esc(p.key)+'"'+(p.key===selectedProjectKey?" selected":"")+'>'+esc(p.label)+"</option>";
      }).join('')+'</optgroup>';
    }).join('');
  }

  export function wireIntelPicker(){
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
      // Two different things can be worth saying about a model, and conflating
      // them would be wrong in both directions (see RETIRED_MODELS in
      // routing.mjs). A retirement is not a choice — the id in kit.json no
      // longer answers and ak already substituted it, so the row shows what
      // will RUN and flags what it replaced. A divergence IS a choice, so it is
      // stated neutrally, with both models' cost-per-task notes on the tooltip.
      var flag="";
      if(r.retiredFrom){
        flag='<span class="r-flag" data-kind="retired" title="'
          +esc(r.retiredFrom+" "+(r.retiresOn?"retires "+r.retiresOn:"is withdrawn")
            +" — ak runs "+r.model+" instead. Run: ak sync — to rewrite it in kit.json.")
          +'">was '+esc(r.retiredFrom)+"</span>";
      }else if(r.diverged){
        var dNote=r.diverged.defaultNote?(" — default: "+r.diverged.defaultNote):"";
        var cNote=r.diverged.currentNote?(" | current: "+r.diverged.currentNote):"";
        flag='<span class="r-flag" data-kind="diverged" title="'
          +esc("the default has moved to "+r.diverged.defaultModel+dNote+cNote
            +". Neither is automatically better. Run: ak x host refresh — to adopt the default.")
          +'">default: '+esc(r.diverged.defaultModel)+"</span>";
      }
      html+='<div class="r-row">'
        +'<span class="r-act mono">'+esc(r.activity)+tag+"</span>"
        +'<span class="r-host r-host-'+esc(r.host)+'"'+primAttr+' title="'+(r.host===primary?"primary host":"alternate host")+'">'+esc(r.host)+"</span>"
        +'<span class="r-model mono">'+esc(r.model)+flag+"</span>"
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
  export var intelSource=null;
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
  export function syncIntelStream(){
    if(activeTab==="overview"&&overviewView==="intel")openIntelStream();
    else closeIntelStream();
  }

  export function render(data){
    if(!data)return;
    LAST=data;
    renderVerdict(data.overall);
    renderNotice(data.drift);
    renderAbout(data);
    renderPanels(data.rows);
    renderMachineWide(data.intel&&data.intel.machineWide);
    renderCensus(data.intel&&data.intel.census);
    renderProjectPicker(data.intel||{});
    renderHistory(buildHistoryView(data));
    renderRouting(data.routing);
    renderModels(data.routing);
    renderModelSummary(data.rows||[]);
    positionThumb(); // badges can change segment widths
  }

  export function ago(sec){
    if(sec<2)return "just now";
    if(sec<60)return sec+"s ago";
    var m=Math.floor(sec/60); if(m<60)return m+"m ago";
    var h=Math.floor(m/60); return h+"h ago";
  }
  export function tickClock(){
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
