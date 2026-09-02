// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { VIEWS, authHeaders, esc, setTab } from './bootstrap.mjs';
import { mliDetail, mliRouteRows, renderModelFacets, renderModelRouteSort, renderModelSort } from './model-lifecycle.mjs';
import { MODEL_PAGE, USAGE, fmtNum, loadLimits, loadModelInventory, loadModelLifecycle, loadUsage, modelRows, renderFindings, renderScore, renderSessions, renderSourceHealth, renderTranscript, sessionRow, setUsageView } from './usage.mjs';

  export function renderUsage(){
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

  export function wireUsage(){
    var seg=document.getElementById("usage-seg");
    if(seg)seg.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-view]"):null;
      if(b)setUsageView(b.getAttribute("data-view"));
    });
    if(seg)seg.addEventListener("keydown",function(e){if(!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key))return;var i=VIEWS.indexOf(usageView);i=e.key==="Home"?0:e.key==="End"?VIEWS.length-1:(i+(e.key==="ArrowRight"?1:VIEWS.length-1))%VIEWS.length;setUsageView(VIEWS[i]);var b=seg.querySelector('[data-view="'+VIEWS[i]+'"]');if(b)b.focus();e.preventDefault();});
    var summary=document.getElementById("mli-summary");
    if(summary)summary.addEventListener("click",function(e){e.preventDefault();setTab("usage");setUsageView("models");});
    function resetModelPage(){
      var region=document.querySelector(".mli-ledger .mli-table-wrap");if(region){region.scrollTop=0;region.scrollLeft=0;}
      loadModelInventory(0,false,false);
    }
    var modelForm=document.getElementById("mli-filters");
    if(modelForm){
      modelForm.addEventListener("submit",function(e){e.preventDefault();if(modelSearchTimer)clearTimeout(modelSearchTimer);resetModelPage();});
      modelForm.addEventListener("input",function(e){
        if(!e.target||e.target.id!=="mli-search")return;
        if(modelSearchTimer)clearTimeout(modelSearchTimer);
        modelSearchTimer=setTimeout(resetModelPage,250);
      });
      modelForm.addEventListener("change",function(e){
        if(!e.target||e.target.id==="mli-search")return;
        if(e.target.id==="mli-evidence-field"){
          renderModelFacets();
        }
        resetModelPage();
      });
      modelForm.addEventListener("reset",function(){
        if(modelSearchTimer)clearTimeout(modelSearchTimer);
        setTimeout(function(){
          modelSort="lifecycle";modelDirection="asc";
          var evidenceValue=document.getElementById("mli-evidence-value");if(evidenceValue)evidenceValue.disabled=true;
          resetModelPage();var search=document.getElementById("mli-search");if(search)search.focus();
        },0);
      });
    }
    var modelTable=document.querySelector(".mli-ledger .mli-table");
    if(modelTable)modelTable.addEventListener("click",function(e){
      var button=e.target.closest?e.target.closest("[data-mli-sort]"):null;if(!button)return;
      var next=button.getAttribute("data-mli-sort");
      if(modelSort===next)modelDirection=modelDirection==="asc"?"desc":"asc";
      else{modelSort=next;modelDirection="asc";}
      renderModelSort();resetModelPage();
    });
    var routesTable=document.querySelector(".mli-routes-table");
    if(routesTable)routesTable.addEventListener("click",function(e){
      var button=e.target.closest?e.target.closest("[data-mli-route-sort]"):null;if(!button)return;
      var next=button.getAttribute("data-mli-route-sort");
      if(modelRouteSort===next)modelRouteDirection=modelRouteDirection==="asc"?"desc":"asc";
      else{modelRouteSort=next;modelRouteDirection="asc";}
      var body=document.getElementById("mli-routes"),bindings=MODELS&&MODELS.snapshot&&MODELS.snapshot.bindings||[];
      if(body)body.innerHTML=mliRouteRows(bindings);
      renderModelRouteSort();
    });
    if(modelTable)modelTable.addEventListener('click',function(e){
      var button=e.target.closest?e.target.closest('[data-mli-detail]'):null;if(!button)return;
      var identity=button.getAttribute('data-mli-detail'),model=modelRows.find(function(row){return row.identity===identity;});
      mliDetail(model);
    });
    var detailClose=document.getElementById('mli-detail-close');
    if(detailClose)detailClose.addEventListener('click',function(){var detail=document.getElementById('mli-detail');if(detail&&typeof detail.close==='function')detail.close();else if(detail)detail.removeAttribute('open');});
    var modelMore=document.getElementById("mli-load-more");
    if(modelMore)modelMore.addEventListener("click",function(){
      var next=MODEL_PAGE&&MODEL_PAGE.nextOffset;
      loadModelInventory(next==null?modelRows.length:Number(next),true,true);
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
      if(usageView==="models"){MODELS=null;modelSnapshotId=null;loadModelLifecycle(true,false,false);}
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
