// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 Inventory destination (MNT-UX-001/002/005/007/011, MNT-INV-*,
// MNT-DSC-016 partial disclosure). Renders the scope lens, curated views,
// multiselect facets with removable chips, guidance-first sorted groups of
// exact placements, and paging against GET /api/maintenance/v2/inventory.
import { esc } from './bootstrap.mjs';
import {
  MNT,
  MNT_INVENTORY_GROUP_LABELS, MNT_SCOPE_LABELS, mntAnnounce, mntDebounce,
  mntGet, mntRegisterDestination, mntScanRequiredAnnouncement,
  mntScanRequiredHtml, mntSyncHash,
} from './maintenance-workspace.mjs';
import { renderMntViews, renderMntFacets, renderMntChips, mntWireFilterPresentation, mntResetFacetSearch, mntFacetValueLabel } from './maintenance-filters.mjs';
import { renderMntGroups, mntRememberGroupExpanded, mntIcon, mntProjectDesignation } from './maintenance-cards.mjs';
import { mntOpenInspector } from './maintenance-inspector.mjs';

  var MNT_SCOPES=["across","system","machine","user","project"];
  var mntInventoryWired=false,mntInventoryBusy=false,mntInventoryError=null,mntFocusPlacement=null;

  // ── Query params + fetch ─────────────────────────────────────────────────
  function mntMergeGroups(existing,incoming){
    var merged=new Map();
    existing.concat(incoming).forEach(function(group){
      var key=group.presentationKey||group.resourceId,prior=merged.get(key);
      if(!prior){merged.set(key,Object.assign({},group,{placements:group.placements.slice()}));return;}
      var ids=new Set(prior.placements.map(function(row){return row.placementId;}));
      group.placements.forEach(function(row){if(!ids.has(row.placementId)){prior.placements.push(row);ids.add(row.placementId);}});
      prior.placementCount=prior.placements.length;
    });
    return Array.from(merged.values());
  }
  function mntInventoryUrl(cursor){
    var params=new URLSearchParams();
    params.set("scope",MNT.scope);params.set("view",MNT.view);params.set("sort",MNT.sort);
    if(MNT.search)params.set("search",MNT.search);
    if(cursor)params.set("cursor",cursor);
    Object.keys(MNT.facets||{}).forEach(function(facet){
      (MNT.facets[facet]||[]).forEach(function(value){params.append("facet."+facet,value);});
    });
    return "/api/maintenance/v2/inventory?"+params.toString();
  }

  export function mntRunInventoryQuery(append){
    var seq=++MNT.seq;
    mntInventoryBusy=true;mntInventoryError=null;renderMntInventory();
    return mntGet(mntInventoryUrl(append?MNT.query&&MNT.query.nextCursor:null)).then(function(page){
      if(seq!==MNT.seq)return;
      if(append&&MNT.query){
        page.groups=mntMergeGroups(MNT.query.groups||[],page.groups||[]);
      }
      MNT.query=page;
      mntInventoryBusy=false;
      renderMntInventory();
      // A build that just settled is a discrete event, not filter churn:
      // announce its result count at once instead of through the debounce.
      if(MNT.buildSettled){MNT.buildSettled=false;mntAnnounceSettledNow(page);}
      else mntAnnounceSettled(page);
    }).catch(function(error){
      if(seq!==MNT.seq)return;
      // A cursor bound to a superseded inventory generation is never shown as
      // a failure — silently drop it and reload page 1 of the current one.
      if(append&&error&&error.code==="INVENTORY_GENERATION_MISMATCH"){
        mntInventoryBusy=false;
        mntRunInventoryQuery(false);
        return;
      }
      mntInventoryBusy=false;
      mntInventoryError=error;
      renderMntInventory();
    });
  }

  function mntAnnounceSettledNow(page){
    var failure=page&&page.scanRequired?mntScanRequiredAnnouncement(page.lastRefresh):null;
    if(failure){mntAnnounce(failure);return;}
    var total=page&&Number.isFinite(page.total)?page.total:0;
    mntAnnounce(total+" result"+(total===1?"":"s")+".");
  }
  var mntAnnounceSettled=mntDebounce(mntAnnounceSettledNow,300);

  export function loadMntInventory(force){
    if(mntInventoryBusy&&!force)return Promise.resolve();
    return mntRunInventoryQuery(false);
  }
  export function reloadMntInventory(){mntSyncHash();return mntRunInventoryQuery(false);}

  // ── Scope lens ───────────────────────────────────────────────────────────

  function renderMntScope(){
    var el=document.getElementById("mnt-scope");if(!el)return;
    el.innerHTML=MNT_SCOPES.map(function(scope){
      var on=MNT.scope===scope;
      return '<button type="button" class="chipf'+(on?" on":"")+'" data-mnt-scope="'+esc(scope)
        +'" aria-pressed="'+(on?"true":"false")+'">'+mntIcon(scope)+esc(MNT_SCOPE_LABELS[scope])+"</button>";
    }).join("");
  }

  // ── Partial-source disclosure (MNT-DSC-015/016) ─────────────────────────
  // query.mjs's partialSources() returns a structured summary, not a flat
  // list: ONE factual sentence (`narrative`, already stating the exact
  // limiting reason — never a raw "N of M" total) plus at most one
  // recommended `action`. Per-source visited counts live under `entries[]`
  // for the inspector's own "What proves this?" section, not this banner.
  function renderMntPartial(){
    var el=document.getElementById("mnt-partial");if(!el)return;
    var partial=MNT.query&&MNT.query.partialSources;
    el.hidden=!partial||!partial.total;
    el.innerHTML=el.hidden?"":mntIcon("info")+'<span>'+esc(partial.narrative||"")+' See Discovery for coverage details.</span>';
  }

  // ── Group legend (a sort, not a severity ladder — MNT-UX-001) ───────────
  function renderMntLegend(){
    var el=document.getElementById("mnt-legend");if(!el)return;
    var groups=(MNT.query&&MNT.query.sortGroups)||[];
    if(!groups.length){el.innerHTML="";return;}
    el.innerHTML='<ul class="mnt-legend-list">'+groups.map(function(entry){
      return "<li>"+esc(MNT_INVENTORY_GROUP_LABELS[entry.bucket]||entry.label)+' <span class="mono">'+esc(entry.count)+"</span></li>";
    }).join("")+"</ul>";
  }

  function renderMntResults(){
    var el=document.getElementById("mnt-results");if(!el)return;
    if(mntInventoryError){
      el.innerHTML='<div class="mnt-empty">Inventory could not be read. <button type="button" class="mt-action" id="mnt-retry">Retry</button></div>';
      return;
    }
    if(MNT.query&&MNT.query.scanRequired){
      el.innerHTML=mntScanRequiredHtml(MNT.query.lastRefresh);
      return;
    }
    var groups=(MNT.query&&MNT.query.groups)||[];
    if(!groups.length){
      el.innerHTML='<div class="mnt-empty">No resources match the current scope, view, search, and facets.</div>';
      return;
    }
    var rowIndexRef={value:0};
    el.innerHTML='<ul class="mnt-groups">'+renderMntGroups(groups,rowIndexRef)+"</ul>";
    if(mntFocusPlacement){
      var target=el.querySelector('[data-mnt-plc="'+mntFocusPlacement+'"]');
      if(target)target.focus();
      mntFocusPlacement=null;
    }
  }
  function renderMntPaging(){
    var el=document.getElementById("mnt-paging");if(!el)return;
    var total=(MNT.query&&MNT.query.total)||0;
    var shown=((MNT.query&&MNT.query.groups)||[]).reduce(function(sum,g){return sum+g.placements.length;},0);
    var more=MNT.query&&MNT.query.nextCursor;
    el.innerHTML='<span class="mnt-paging-count">'+esc(shown)+" of "+esc(total)+" placements</span>"
      +(more?'<button type="button" class="mt-action" id="mnt-load-more">Load more</button>':"");
  }

  export function renderMntInventory(){
    var focused=document.activeElement,focusKey=null;
    var focusRoot=focused&&focused.closest&&focused.closest("#mnt-facets-sheet")?"mnt-facets-sheet":"mnt-panel-inventory";
    ['data-mnt-facet','data-mnt-scope','data-mnt-view'].some(function(attr){
      if(focused&&focused.hasAttribute&&focused.hasAttribute(attr)){focusKey={attr:attr,key:focused.getAttribute(attr),value:focused.value};return true;}return false;
    });
    renderMntScope();renderMntViews();renderMntFacets();renderMntChips();
    var context=[MNT_SCOPE_LABELS[MNT.scope]];
    ['project','adapter','consumer','kind'].forEach(function(facet){
      var values=MNT.facets[facet]||[];
      if(values.length===1)context.push(mntFacetValueLabel(facet,values[0]));
    });
    var heading=document.getElementById('mnt-context-heading');if(heading)heading.innerHTML=esc(context.join(' / '))+((MNT.facets.project||[]).length===1?' '+mntProjectDesignation(MNT.facets.project[0]):'');
    var count=document.getElementById('mnt-result-count');if(count)count.textContent=((MNT.query&&MNT.query.total)||0).toLocaleString()+' installations';
    var sort=document.getElementById('mnt-sort');if(sort)sort.value=MNT.sort;
    renderMntPartial();renderMntLegend();renderMntResults();renderMntPaging();
    if(focusKey){
      var root=document.getElementById(focusRoot);
      if(root)[].slice.call(root.querySelectorAll('['+focusKey.attr+']')).some(function(el){
        if(el.getAttribute(focusKey.attr)===focusKey.key&&(!focusKey.value||el.value===focusKey.value)){el.focus();return true;}return false;
      });
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  var mntSearchDebounced=mntDebounce(function(value){
    var input=document.getElementById("mnt-search");if(input&&input.value!==value)return;
    MNT.search=value;mntSyncHash();mntRunInventoryQuery(false);
  },300);

  function mntToggleFacet(facet,value,checked){
    var current=MNT.facets[facet]||[];
    if(checked){if(current.indexOf(value)<0)current=current.concat([value]);}
    else{current=current.filter(function(v){return v!==value;});}
    if(current.length)MNT.facets[facet]=current;else delete MNT.facets[facet];
    mntSyncHash();mntRunInventoryQuery(false);
  }

  function mntOpenFacetsSheet(){
    var sheet=document.getElementById("mnt-facets-sheet");
    if(sheet&&typeof sheet.showModal==="function"&&!sheet.open)sheet.showModal();
  }
  function mntCloseFacetsSheet(){
    var sheet=document.getElementById("mnt-facets-sheet");
    if(sheet&&sheet.open&&typeof sheet.close==="function")sheet.close();
  }

  function mntWireInventoryControls(panel){
    mntWireFilterPresentation();
    var scope=document.getElementById("mnt-scope");
    if(scope)scope.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-mnt-scope]"):null;if(!button)return;
      MNT.scope=button.getAttribute("data-mnt-scope");mntSyncHash();mntRunInventoryQuery(false);
    });
    var viewClick=function(event){
      var button=event.target.closest?event.target.closest("[data-mnt-view]"):null;if(!button)return;
      MNT.view=button.getAttribute("data-mnt-view");mntSyncHash();mntRunInventoryQuery(false);
    };
    ['mnt-views','mnt-facets-sheet-body'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('click',viewClick);});
    panel.addEventListener('click',function(event){
      if(event.target.closest&&event.target.closest('[data-mnt-reset]')){
        MNT.facets={};MNT.view='all';MNT.search='';mntResetFacetSearch();
        var input=document.getElementById('mnt-search');if(input)input.value='';
        mntSyncHash();mntRunInventoryQuery(false);
      }
    });
    var sort=document.getElementById('mnt-sort');if(sort)sort.addEventListener('change',function(){MNT.sort=sort.value;mntSyncHash();mntRunInventoryQuery(false);});
    var facetChange=function(event){
      var input=event.target;if(!input||!input.matches||!input.matches("[data-mnt-facet]"))return;
      mntToggleFacet(input.getAttribute("data-mnt-facet"),input.value,input.checked);
    };
    var facets=document.getElementById("mnt-facets");if(facets)facets.addEventListener("change",facetChange);
    var sheetBody=document.getElementById("mnt-facets-sheet-body");if(sheetBody)sheetBody.addEventListener("change",facetChange);
    var chips=document.getElementById("mnt-chips");
    if(chips)chips.addEventListener("click",function(event){
      var clear=event.target.closest?event.target.closest("#mnt-clear-all"):null;
      if(clear){MNT.facets={};mntSyncHash();mntRunInventoryQuery(false);return;}
      var remove=event.target.closest?event.target.closest("[data-mnt-chip-facet]"):null;
      if(remove)mntToggleFacet(remove.getAttribute("data-mnt-chip-facet"),remove.getAttribute("data-mnt-chip-value"),false);
    });
    var search=document.getElementById("mnt-search");
    if(search)search.addEventListener("input",function(){mntSearchDebounced(String(search.value||""));});
    var filtersToggle=document.getElementById("mnt-filters-toggle");
    if(filtersToggle)filtersToggle.addEventListener("click",mntOpenFacetsSheet);
    var sheetClose=document.getElementById("mnt-facets-sheet-close");
    if(sheetClose)sheetClose.addEventListener("click",mntCloseFacetsSheet);
    var results=document.getElementById("mnt-results");
    if(results){
      results.addEventListener("click",function(event){
        var family=event.target.closest?event.target.closest("[data-mnt-family]"):null;
        if(family){MNT.facets={family:[family.getAttribute("data-mnt-family")]};MNT.view="all";MNT.scope="across";MNT.search="";mntSyncHash();mntRunInventoryQuery(false);return;}
        var retry=event.target.closest?event.target.closest("#mnt-retry"):null;
        if(retry){mntRunInventoryQuery(false);return;}
        var groupToggle=event.target.closest?event.target.closest("[data-mnt-group-toggle]"):null;
        if(groupToggle){
          var resourceId=groupToggle.getAttribute("data-mnt-group-toggle");
          var next=groupToggle.getAttribute("aria-expanded")!=="true";
          mntRememberGroupExpanded(resourceId,next);
          renderMntResults();
          var restored=results.querySelector('[data-mnt-group-toggle="'+resourceId+'"]');
          if(restored)restored.focus();
          return;
        }
        var row=event.target.closest?event.target.closest("[data-mnt-plc]"):null;
        if(row)mntOpenInspector(row.getAttribute("data-mnt-plc"),row);
      });
      // Roving tab stop (MNT-UX-007): Tab enters the list once, at whichever
      // row currently holds tabindex="0"; arrow keys move focus and that
      // tabindex among rows without adding the whole list to the Tab order.
      results.addEventListener("keydown",function(event){
        if(!/^(ArrowDown|ArrowUp|Home|End)$/.test(event.key))return;
        var rows=[].slice.call(results.querySelectorAll("[data-mnt-plc]"));
        if(!rows.length)return;
        var current=rows.indexOf(document.activeElement);
        var next=event.key==="Home"?0:event.key==="End"?rows.length-1
          :current<0?0:(current+(event.key==="ArrowDown"?1:rows.length-1))%rows.length;
        rows.forEach(function(row,index){row.tabIndex=index===next?0:-1;});
        rows[next].focus();
        event.preventDefault();
      });
    }
    var paging=document.getElementById("mnt-paging");
    if(paging)paging.addEventListener("click",function(event){
      var more=event.target.closest?event.target.closest("#mnt-load-more"):null;
      if(more)mntRunInventoryQuery(true);
    });
    panel.dataset.wired="1";
  }

  export function wireMntInventory(){
    if(mntInventoryWired)return;mntInventoryWired=true;
    var panel=document.getElementById("mnt-panel-inventory");
    if(panel)mntWireInventoryControls(panel);
  }

  // Registered at bundle-load time (not gated behind wireMntInventory) so a
  // returning user's persisted `#system/maintenance/...` hash or system-view
  // preference can lazily call loadMaintenanceWorkspace() before boot.mjs's
  // explicit wireMaintenance() call runs (see boot.mjs's own call order note).
  mntRegisterDestination("inventory",loadMntInventory,renderMntInventory);
