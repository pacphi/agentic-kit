// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 Maintenance workspace shell: shared state, the v2 fetch helpers,
// hash routing across the four third-level destinations (Inventory | Guidance
// | Discovery | Activity), the destination tab strip, and the user-facing
// label vocabulary copied verbatim from
// src/lib/maintenance/management/model.mjs (the browser bundle cannot import
// a node module — tests/kit/maintenance-dashboard-client-labels.test.mjs
// asserts these literal maps stay byte-identical to that contract).
import { authHeaders, esc } from './bootstrap.mjs';
import { mntCheckProviders, mntRemeasureMachine, mntWireOperation } from './maintenance-operation.mjs';
import { ago } from './intelligence.mjs';

  // ── Label vocabulary (copied from src/lib/maintenance/management/model.mjs) ─
  export var MNT_SCOPE_LABELS={system:"System",machine:"Machine",user:"User",project:"Projects",across:"Across scopes"};
  export var MNT_RESOURCE_KIND_LABELS={
    "skill":"Skill","mcp-registration":"MCP registration","plugin":"Plugin","hook":"Hook",
    "instruction-context-file":"Instruction file","agent":"Agent","command-prompt":"Command",
    "host-adapter":"Host adapter","executable":"Executable","runtime":"Runtime","model":"Model",
    "provider-configuration":"Provider configuration","cache":"Cache","credential-readiness":"Credential",
    "related-storage":"Storage"
  };
  export var MNT_GUIDANCE_LANE_LABELS={
    apply:"Can apply here",steps:"Steps available",decision:"Decisions to make",
    update:"Updates available",recovery:"Recovery to finish"
  };
  export var MNT_INVENTORY_GROUP_LABELS={
    apply:"Can apply here",steps:"Steps available",decision:"Decisions to make",
    update:"Updates available",recovery:"Recovery to finish",
    "evidence-only":"Inventory evidence only","healthy":"Healthy resources"
  };
  export var MNT_CURATED_VIEW_LABELS={
    "all":"All resources","can-apply":"Can apply here","steps":"Steps available","decisions":"Decisions to make",
    "updates":"Updates available","dependencies":"Dependencies","conflicts":"Conflicts and overlaps",
    "duplicates":"Duplicated placements","disabled":"Disabled resources",
    "credentials-providers":"Credentials and providers","models-runtimes":"Models and runtimes",
    "storage-caches":"Storage and caches","recently-changed":"Recently changed",
    "evidence-only":"Inventory evidence only"
  };
  export var MNT_CONFLICT_EXPLANATIONS={
    "duplicate-placement":{label:"Duplicate placement",proves:"Separate placements have equivalent verified definitions.",doesNotProve:"Equality does not prove one is disposable."},
    "shadowed-override":{label:"Shadowed override",proves:"A narrower scope takes precedence over a broader placement for a verified host.",doesNotProve:"Precedence does not prove the broader placement is unused elsewhere."},
    "same-name-different-definition":{label:"Same name, different definition",proves:"Names match but bounded definitions differ.",doesNotProve:"The intended source cannot be inferred."},
    "equivalent-transport-registration":{label:"Equivalent MCP transport",proves:"Registrations resolve to the same verified transport.",doesNotProve:"Equal transport does not prove equal scope or health."},
    "version-requirement-divergence":{label:"Version requirement divergence",proves:"Verified consumers require incompatible version ranges.",doesNotProve:"Divergence does not prove which consumer should change."},
    "dependency-resolution-collision":{label:"Dependency resolution collision",proves:"The resolved dependency differs from the placement's verified declaration.",doesNotProve:"A collision does not prove the resolved dependency is wrong."},
    "shared-artifact":{label:"Shared artifact",proves:"Several consumers intentionally use one physical artifact.",doesNotProve:"This is not a duplicate and grants no removal authority."}
  };
  export var MNT_CREDENTIAL_READINESS_LABELS={
    "not-configured":"Not configured","configured-not-checked":"Configured but not checked",
    "ready":"Ready","check-failed":"Check failed","expired-renewal-needed":"Expired or renewal needed"
  };
  export var MNT_SOURCE_COVERAGE_LABELS={
    "not-scanned":"Not scanned yet","complete":"Complete","scanning":"Scanning",
    "paused":"Paused","stopped":"Stopped","failed":"Failed"
  };
  export var MNT_AUDIT_RESULT_LABELS={
    "no-action-started":"No action started",
    "matches-recorded-before-state":"Matches recorded before state",
    "matches-verified-after-state":"Matches verified after state",
    "differs-from-both-recorded-states":"Differs from both recorded states",
    "matching-inspection-provider-not-present":"Matching inspection provider is not present",
    "receipt-integrity-check-failed":"Receipt integrity check failed",
    "affected-catalog-refresh-did-not-complete":"Affected catalog refresh did not complete"
  };
  export var MNT_RECONCILE_OUTCOME_LABELS={
    "record-no-change":"Record no change","record-completed":"Record completed","record-restored":"Record restored"
  };
  export var MNT_AUDIT_ACTION_LABEL="Audit interruption";
  export var MNT_NO_ACTION_REQUESTED_DETAIL="No action is requested. Agentic Kit does not have a "
    +"verified operation, procedure, or bounded decision to offer for this condition in the current "
    +"environment.";
  export var MNT_NO_CORRECTIVE_ACTION="No corrective action is offered.";
  export var MNT_SOURCE_SCAN_INCOMPLETE="Source scan incomplete";

  // ── Destinations ────────────────────────────────────────────────────────────
  export var MNT_DESTINATIONS=["inventory","guidance","discovery","activity"];
  var MNT_DEST_LABEL={inventory:"Inventory",guidance:"Guidance",discovery:"Discovery",activity:"Activity"};

  // ── Shared, single-owner workspace state. Every OTHER maintenance-*.mjs
  // module reads this object's properties freely, but only mutates it through
  // the exported functions below — the same single-writer discipline the rest
  // of this bundle uses for SYSTEM/MAINTENANCE. ──
  export var MNT={
    ready:false,wired:false,destination:"inventory",
    scope:"across",view:"all",sort:"guidance-first",search:"",facets:{},
    cursor:null,limit:50,plc:null,originKey:null,
    query:null,guidance:null,discovery:null,activity:null,inspector:null,
    preferences:null,preferencesLoaded:false,
    providersBusy:false,
    remeasureBusy:false,
    buildSettled:false,
    announceTimer:null,searchTimer:null,seq:0
  };

  export function mntBusy(value){
    var root=document.getElementById("sys-maintenance");
    if(root)root.setAttribute("aria-busy",value?"true":"false");
  }

  function mntBody(response){
    return response.text().then(function(text){
      var body={};try{body=text?JSON.parse(text):{};}catch(e){body={};}
      return {ok:response.ok,status:response.status,body:body};
    });
  }
  function mntRequestError(result){
    var error=new Error("maintenance request failed");
    error.status=result.status;
    error.code=String((result.body&&(result.body.code||(result.body.error&&result.body.error.code)))||"");
    error.payload=result.body;
    return error;
  }
  export function mntGet(url){
    return fetch(url,{cache:"no-store",headers:authHeaders()}).then(mntBody).then(function(result){
      if(!result.ok)throw mntRequestError(result);
      return result.body;
    });
  }
  export function mntPost(url,payload){
    var headers=authHeaders();headers["content-type"]="application/json";
    return fetch(url,{method:"POST",cache:"no-store",headers:headers,body:JSON.stringify(payload||{})})
      .then(mntBody).then(function(result){
        if(!result.ok)throw mntRequestError(result);
        return result.body;
      });
  }

  // ── Formatting helpers shared by every destination module ──────────────────
  export function mntText(value){return typeof value==="string"||typeof value==="number"?String(value):"";}
  export function mntAge(iso){
    var at=Date.parse(mntText(iso));
    return Number.isFinite(at)?ago(Math.max(0,Math.round((Date.now()-at)/1000))):"";
  }
  export function mntHumanize(value){
    var text=mntText(value);
    if(!text)return "";
    return text.replace(/[-_]+/g," ").replace(/^./,function(c){return c.toUpperCase();});
  }
  export function mntKindLabel(kind){return MNT_RESOURCE_KIND_LABELS[kind]||mntHumanize(kind);}
  function mntList(value){
    if(!Array.isArray(value))return [];
    return value.map(mntText).filter(Boolean);
  }
  /** Renders a confirmation-payload value the same permissive way the v1
   *  dialog did: a string/number as-is, an array joined, or an object's
   *  label/summary/status/value — never `[object Object]`. */
  export function mntValue(value){
    if(Array.isArray(value))return mntList(value).join(", ");
    if(value&&typeof value==="object"){
      var described=mntText(value.label)||mntText(value.summary)||mntText(value.status)||mntText(value.value);
      if(described)return described;
      return "";
    }
    return mntText(value);
  }
  export function mntFact(label,value){
    value=mntValue(value);
    return value?"<div><dt>"+esc(label)+"</dt><dd>"+esc(value)+"</dd></div>":"";
  }
  export function mntDebounce(fn,ms){
    var timer=null;
    return function(){
      var args=arguments;
      if(timer)clearTimeout(timer);
      timer=setTimeout(function(){timer=null;fn.apply(null,args);},ms);
    };
  }
  export function mntAnnounce(text){
    var el=document.getElementById("mnt-status");
    if(el)el.textContent=text;
  }
  // Shared Inventory/Guidance empty state for an unbuilt inventory. A facade
  // `lastRefresh:{status,at,code?,message?}` on the envelope distinguishes an
  // inventory that has simply never run from one whose last build attempt
  // failed; `code` is never rendered as a label — only the sanitized
  // `message` — and the Check providers control stays available either way.
  export function mntScanRequiredHtml(lastRefresh){
    if(lastRefresh&&lastRefresh.status==="failed"){
      var detail=lastRefresh.message?" "+esc(lastRefresh.message):"";
      return '<div class="mnt-empty">The last inventory build did not complete.'+detail+"</div>";
    }
    if(lastRefresh&&lastRefresh.status==="running"){
      return '<div class="mnt-empty" aria-busy="true">Building the inventory…</div>';
    }
    return '<div class="mnt-empty">No inventory has been built yet. Use Refresh evidence, above, to build it.</div>';
  }
  export function mntScanRequiredAnnouncement(lastRefresh){
    if(lastRefresh&&lastRefresh.status==="failed"){
      return "The last inventory build did not complete."+(lastRefresh.message?" "+lastRefresh.message:"");
    }
    if(lastRefresh&&lastRefresh.status==="running")return "Building the inventory.";
    return null;
  }
  // ── Hash routing: #system/maintenance/<destination>?scope&view&sort&facet.<n>=v&plc ─
  // Never a human-readable path — only opaque ids and enum values (MNT-PRV-004).
  function mntParamsFromState(){
    var params=new URLSearchParams();
    if(MNT.scope&&MNT.scope!=="across")params.set("scope",MNT.scope);
    if(MNT.view&&MNT.view!=="all")params.set("view",MNT.view);
    if(MNT.sort&&MNT.sort!=="guidance-first")params.set("sort",MNT.sort);
    Object.keys(MNT.facets||{}).sort().forEach(function(facet){
      (MNT.facets[facet]||[]).forEach(function(value){params.append("facet."+facet,value);});
    });
    if(MNT.plc)params.set("plc",MNT.plc);
    return params;
  }
  export function mntHash(){
    var params=mntParamsFromState();
    var query=params.toString();
    return "#system/maintenance/"+MNT.destination+(query?"?"+query:"");
  }
  /** Parse the `system/maintenance/...` hash segments (already split on "/",
   *  with `parts[0]==="system"` and `parts[1]==="maintenance"`). Returns the
   *  destination and query-derived state WITHOUT touching MNT — the caller
   *  decides whether URL state should override remembered preferences. */
  export function mntParseHashParts(parts){
    var rest=mntText(parts[2]);
    var qIndex=rest.indexOf("?");
    var destination=qIndex>=0?rest.slice(0,qIndex):rest;
    if(MNT_DESTINATIONS.indexOf(destination)<0)destination="inventory";
    var params=new URLSearchParams(qIndex>=0?rest.slice(qIndex+1):"");
    var facets={};
    params.forEach(function(value,key){
      if(key.indexOf("facet.")===0){
        var name=key.slice(6);
        facets[name]=(facets[name]||[]).concat([value]);
      }
    });
    return {
      destination:destination,
      scope:params.get("scope")||"across",
      view:params.get("view")||"all",
      sort:params.get("sort")||"guidance-first",
      facets:facets,
      plc:params.get("plc")||null,
      hasState:qIndex>=0||!!rest
    };
  }

  export function mntSyncHash(){
    try{if(history.replaceState)history.replaceState(null,"",mntHash());}catch(e){}
  }

  // ── Preferences (owner-private; URL state overrides it on load, MNT-PRV-006) ─
  export function mntLoadPreferences(){
    return mntGet("/api/maintenance/v2/preferences").then(function(data){
      MNT.preferences=data&&typeof data==="object"?data:{};
      MNT.preferencesLoaded=true;
      return MNT.preferences;
    }).catch(function(){MNT.preferences={};MNT.preferencesLoaded=true;return MNT.preferences;});
  }
  export function mntSavePreferences(patch){
    return mntPost("/api/maintenance/v2/preferences",patch||{}).catch(function(){});
  }

  // ── Destination switching ───────────────────────────────────────────────────
  var mntDestLoaders={};
  /** Each destination module registers its own (load, render) pair here at
   *  bundle-load time, avoiding a hard import cycle back into this file. */
  export function mntRegisterDestination(id,load,render){
    mntDestLoaders[id]={load:load,render:render};
  }

  function mntPaintTabs(){
    for(var i=0;i<MNT_DESTINATIONS.length;i++){
      var id=MNT_DESTINATIONS[i],on=id===MNT.destination;
      var tab=document.getElementById("mnt-tab-"+id);
      var panel=document.getElementById("mnt-panel-"+id);
      if(tab){tab.setAttribute("aria-selected",on?"true":"false");tab.tabIndex=on?0:-1;}
      if(panel)panel.hidden=!on;
    }
  }

  export function mntSetDestination(id,options){
    options=options||{};
    if(MNT_DESTINATIONS.indexOf(id)<0)id="inventory";
    var changed=MNT.destination!==id;
    MNT.destination=id;
    mntRememberDestination(id);
    mntPaintTabs();
    if(!options.skipHash)mntSyncHash();
    var entry=mntDestLoaders[id];
    if(entry&&(changed||options.force))entry.load(options.force===true);
    else if(entry)entry.render();
    if(!options.skipFocus&&options.focus){
      var tab=document.getElementById("mnt-tab-"+id);
      if(tab)tab.focus();
    }
  }

  export function mntCurrentDestinationLabel(){return MNT_DEST_LABEL[MNT.destination]||MNT.destination;}

  /** Re-run whichever destination is currently visible after a write commits
   *  (apply/undo/reconcile), so the workspace never shows stale evidence
   *  beside a just-recorded receipt. */
  export function mntRefreshActiveDestination(){
    var entry=mntDestLoaders[MNT.destination];
    if(entry)entry.load(true);
  }

  export function mntWireTabs(){
    var tabs=document.getElementById("mnt-tabs");
    if(!tabs||tabs.dataset.wired)return;
    tabs.dataset.wired="1";
    tabs.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-mnt-dest]"):null;
      if(button)mntSetDestination(button.getAttribute("data-mnt-dest"));
    });
    tabs.addEventListener("keydown",function(event){
      if(!/^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key))return;
      var i=MNT_DESTINATIONS.indexOf(MNT.destination);
      i=event.key==="Home"?0:event.key==="End"?MNT_DESTINATIONS.length-1
        :(i+(event.key==="ArrowRight"?1:MNT_DESTINATIONS.length-1))%MNT_DESTINATIONS.length;
      mntSetDestination(MNT_DESTINATIONS[i],{focus:true});
      event.preventDefault();
    });
  }

  // ── Escape-to-close registry: the most recently opened closable surface
  // (inspector, sheet, dialog) gets first refusal on Escape, so nested
  // overlays close one layer at a time and always restore focus. ──
  var mntEscapeStack=[];
  export function mntPushEscapable(close){mntEscapeStack.push(close);}
  export function mntPopEscapable(close){
    var at=mntEscapeStack.lastIndexOf(close);
    if(at>=0)mntEscapeStack.splice(at,1);
  }
  export function mntHandleEscape(event){
    if(event.key!=="Escape"||!mntEscapeStack.length)return;
    var close=mntEscapeStack[mntEscapeStack.length-1];
    close();
  }

  // ── Boot entry points (wired from boot.mjs / bootstrap.mjs) ─────────────────
  var mntBootstrapped=false;
  function mntApplyHashState(){
    var parts=location.hash.slice(1).split("/");
    if(parts[0]!=="system")return null;
    if(parts[1]==="catalog")return {destination:"inventory",fromCatalogRedirect:true};
    if(parts[1]!=="maintenance")return null;
    return mntParseHashParts(parts);
  }
  function mntApplyState(state){
    MNT.destination=state.destination;
    mntRememberDestination(state.destination);
    if(state.scope)MNT.scope=state.scope;
    if(state.view)MNT.view=state.view;
    if(state.sort)MNT.sort=state.sort;
    if(state.facets)MNT.facets=state.facets;
    if(state.plc)MNT.plc=state.plc;
  }
  // The owner-private /v2/preferences body is { lastView?: {scope,view,sort,
  // facets,search}, preferredShellByEnvironment?, retention? } — it has no
  // destination field, so the destination itself is remembered the same way
  // every other tab/view in this dashboard is (localStorage; see
  // bootstrap.mjs's LS_TAB/LS_SYSTEM), never sent to the server.
  var MNT_LS_DESTINATION="ak-dash-mnt-destination";
  function mntRememberDestination(id){
    try{localStorage.setItem(MNT_LS_DESTINATION,id);}catch(e){}
  }
  function mntRememberedDestination(){
    try{
      var stored=localStorage.getItem(MNT_LS_DESTINATION);
      return MNT_DESTINATIONS.indexOf(stored)>=0?stored:null;
    }catch(e){return null;}
  }
  function mntApplyPreferredState(preferences){
    var lastView=preferences&&preferences.lastView;
    if(lastView){
      if(lastView.scope)MNT.scope=lastView.scope;
      if(lastView.view)MNT.view=lastView.view;
      if(lastView.sort)MNT.sort=lastView.sort;
      if(lastView.facets)MNT.facets=lastView.facets;
      if(lastView.search)MNT.search=lastView.search;
    }
    var rememberedDestination=mntRememberedDestination();
    if(rememberedDestination)MNT.destination=rememberedDestination;
  }
  export function loadMaintenanceWorkspace(force){
    mntWireTabs();
    var urlState=mntApplyHashState();
    var boot=mntBootstrapped?Promise.resolve(MNT.preferences):mntLoadPreferences();
    mntBootstrapped=true;
    return boot.then(function(preferences){
      // A valid URL state overrides remembered preferences; otherwise restore
      // the last destination/scope/view/sort/facets (MNT-PRV-006).
      if(urlState&&(urlState.hasState||urlState.fromCatalogRedirect))mntApplyState(urlState);
      else mntApplyPreferredState(preferences);
      mntPaintTabs();
      var entry=mntDestLoaders[MNT.destination];
      if(entry)return entry.load(force===true);
      return null;
    }).then(function(){
      mntSyncHash();
      mntSavePreferences({
        lastView:{scope:MNT.scope,view:MNT.view,sort:MNT.sort,facets:MNT.facets,search:MNT.search},
      });
    });
  }
  export function wireMaintenanceWorkspace(){
    if(MNT.wired)return;
    MNT.wired=true;
    mntWireTabs();mntWireOperation();
    document.addEventListener("keydown",mntHandleEscape);
    var checkProviders=document.getElementById("mnt-check-providers");
    if(checkProviders)checkProviders.addEventListener("click",mntCheckProviders);
    var remeasure=document.getElementById("mnt-remeasure");
    if(remeasure)remeasure.addEventListener("click",mntRemeasureMachine);
  }
