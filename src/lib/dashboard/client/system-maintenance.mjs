// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { authHeaders, esc } from './bootstrap.mjs';
import { ago } from './intelligence.mjs';
import { maintActionActive, maintActionBusy, wireMaintActions } from './system-maintenance-actions.mjs';

  // Maintenance is a separate evidence-bound workflow. System owns the
  // observation; a provider-issued capability, preview, explicit confirmation,
  // and durable receipt are all required before this client can request a
  // change. Capabilities remain only in this closure's memory.
  export var MAINTENANCE=null,maintenanceBusy=false;
  var maintenanceWired=false,maintBucket="all",maintKind="",maintHost="",maintQuery="",maintSelected=null;
  var maintTransientReceipts=[];

  var MAINT_BUCKETS=[
    {id:"all",label:"All",field:"total"},
    {id:"updates-ready",label:"Updates ready",field:"updatesReady"},
    {id:"safe-cleanup",label:"Safe cleanup",field:"safeCleanup"},
    {id:"needs-review",label:"Needs review",field:"needsReview"},
    {id:"blocked",label:"Cannot automate",field:"blocked"},
    {id:"recent-changes",label:"Recent changes",field:"recentChanges"}
  ];
  var MAINT_KIND_LABEL={plugin:"Plugins",skill:"Skills",mcp:"MCP servers","mcp-server":"MCP servers",storage:"Storage",runtime:"Runtime"};

  export function maintText(value){
    return typeof value==="string"||typeof value==="number"?String(value):"";
  }
  function maintDerivedCount(field){
    var findings=MAINTENANCE&&Array.isArray(MAINTENANCE.findings)?MAINTENANCE.findings:[];
    if(field==="total")return findings.length;
    if(field==="recentChanges")return MAINTENANCE&&Array.isArray(MAINTENANCE.receipts)?MAINTENANCE.receipts.length:0;
    if(field==="actionable")return findings.filter(function(finding){return finding&&finding.action&&finding.action.executable===true;}).length;
    if(field==="incompleteSources"){
      var sources={};findings.forEach(function(finding){
        var evidence=finding&&finding.evidence||{};
        if(maintText(evidence.completeness).toLowerCase()!=="complete")sources[maintText(evidence.source)||maintText(finding&&finding.id)||"unknown"]=true;
      });
      return Object.keys(sources).length;
    }
    var bucket={updatesReady:"updates-ready",safeCleanup:"safe-cleanup",needsReview:"needs-review",blocked:"blocked"}[field];
    return bucket?findings.filter(function(finding){return maintBucketOf(finding&&finding.bucket)===bucket;}).length:0;
  }
  function maintSummaryCount(summary,field){
    var value=summary&&summary[field],number=Number(value);
    return Number.isFinite(number)&&number>=0?Math.round(number):maintDerivedCount(field);
  }
  function maintBucketOf(value){
    var key=maintText(value).toLowerCase().replace(/[_ ]+/g,"-");
    if(key==="updatesready"||key==="updateready"||key==="update-ready"||key==="update-available")return "updates-ready";
    if(key==="safecleanup"||key==="safe-automatic"||key==="cleanup")return "safe-cleanup";
    if(key==="needsreview"||key==="review"||key==="ambiguous"||key==="modified")return "needs-review";
    if(key==="unsupportedorblocked"||key==="unsupported"||key==="cannot-automate"||key==="never-automatic"||key==="upstream-required")return "blocked";
    if(key==="recentchanges")return "recent-changes";
    return MAINT_BUCKETS.some(function(x){return x.id===key;})?key:"needs-review";
  }
  function maintState(finding){
    var bucket=maintBucketOf(finding&&finding.bucket);
    var fallback=bucket==="updates-ready"||bucket==="safe-cleanup"?"Ready to apply"
      :bucket==="blocked"?"Cannot safely automate":"Review required";
    var label=maintText(finding&&finding.statusLabel)||fallback;
    var tone=bucket==="updates-ready"||bucket==="safe-cleanup"?"ready":bucket==="blocked"?"blocked":"review";
    if(/incomplete|unknown|partial/i.test(label))tone="incomplete";
    return {bucket:bucket,label:label,tone:tone};
  }
  function maintAge(value){
    var at=Date.parse(maintText(value));
    return Number.isFinite(at)?ago(Math.max(0,Math.round((Date.now()-at)/1000))):"time unknown";
  }
  function maintOptionLabel(kind){
    var key=maintText(kind).toLowerCase();
    return MAINT_KIND_LABEL[key]||key.replace(/-/g," ").replace(/^./,function(c){return c.toUpperCase();});
  }
  function maintList(value){
    if(!Array.isArray(value))return [];
    return value.map(maintText).filter(Boolean);
  }
  export function maintValue(value){
    if(Array.isArray(value))return maintList(value).join(", ");
    if(value&&typeof value==="object"){
      var described=maintText(value.label)||maintText(value.summary)||maintText(value.status)||maintText(value.value);
      if(described)return described;
      if(value.nativeStateVerified===true&&(value.affectedCatalogRefreshed===true||value.affectedCatalogRescanned===true))
        return "Native state verified; catalog refreshed";
      if(value.nativeStateVerified===true)return "Native state verified";
      return "";
    }
    return maintText(value);
  }
  function maintFindingKey(finding,index){return "finding:"+(maintText(finding&&finding.id)||index);}
  export function maintReceiptId(receipt){return maintText(receipt&&receipt.id)||maintText(receipt&&receipt.receiptId);}
  function maintReceiptKey(receipt,index){return "receipt:"+(maintReceiptId(receipt)||index);}
  function maintCapabilities(){
    return MAINTENANCE&&MAINTENANCE.capabilities&&typeof MAINTENANCE.capabilities==="object"?MAINTENANCE.capabilities:{};
  }
  export function maintCanPreview(finding){
    var caps=maintCapabilities(),action=finding&&(finding.action||finding.nextAction);
    return caps.plan===true&&caps.apply===true&&action&&action.executable===true;
  }
  export function maintCanUndo(receipt){
    var undo=receipt&&receipt.undo;
    return maintCapabilities().undo===true&&!!receipt&&(receipt.undoEligible===true
      ||(undo&&typeof undo==="object"&&undo.eligible===true));
  }
  function maintMergeReceipts(data){
    if(!data||typeof data!=="object")return data;
    var seen={},merged=[];
    (Array.isArray(data.receipts)?data.receipts:[]).concat(maintTransientReceipts).forEach(function(receipt){
      var id=maintReceiptId(receipt),key=id||"anonymous:"+merged.length;
      if(seen[key])return;seen[key]=true;merged.push(receipt);
    });
    data.receipts=merged;
    if(data.summary&&typeof data.summary==="object")data.summary.recentChanges=merged.length;
    return data;
  }
  export function maintRememberReceipt(receipt){
    if(!receipt||typeof receipt!=="object")return null;
    var id=maintReceiptId(receipt);
    maintTransientReceipts=maintTransientReceipts.filter(function(item){return !id||maintReceiptId(item)!==id;});
    maintTransientReceipts.unshift(receipt);
    maintMergeReceipts(MAINTENANCE);
    return maintReceiptKey(receipt,0);
  }

  export function maintRecords(){
    if(!MAINTENANCE||MAINTENANCE.error)return [];
    if(maintBucket==="recent-changes")return (Array.isArray(MAINTENANCE.receipts)?MAINTENANCE.receipts:[]).map(function(receipt,index){
      return {key:maintReceiptKey(receipt,index),kind:"receipt",value:receipt};
    });
    return (Array.isArray(MAINTENANCE.findings)?MAINTENANCE.findings:[]).map(function(finding,index){
      return {key:maintFindingKey(finding,index),kind:"finding",value:finding};
    }).filter(function(record){
      var finding=record.value,resource=finding.resource||{};
      if(maintBucket!=="all"&&maintState(finding).bucket!==maintBucket)return false;
      if(maintKind&&maintText(resource.kind)!==maintKind)return false;
      if(maintHost&&maintText(resource.host)!==maintHost)return false;
      if(maintQuery){
        var hay=[finding.headline,finding.explanation,resource.name,resource.kind,resource.host,resource.providerRef,finding.owner]
          .map(maintText).join(" ").toLowerCase();
        if(hay.indexOf(maintQuery)<0)return false;
      }
      return true;
    });
  }
  export function maintCurrentRecord(kind){
    return maintRecords().find(function(item){return item.kind===kind&&item.key===maintSelected;});
  }
  export function maintShowReceipt(key){
    maintBucket="recent-changes";maintSelected=key;
  }

  function maintSummary(){
    if(!MAINTENANCE||MAINTENANCE.error)return [["\u2014","findings"],["\u2014","provider-actionable"],["\u2014","incomplete sources"],["unknown","evidence age"]]
      .map(function(item){return '<div><dd>'+esc(item[0])+'</dd><dt>'+esc(item[1])+"</dt></div>";}).join("");
    var summary=MAINTENANCE&&MAINTENANCE.summary||{},asOf=MAINTENANCE&&MAINTENANCE.asOf;
    var values=[
      [maintSummaryCount(summary,"total"),"findings"],
      [maintSummaryCount(summary,"actionable"),"provider-actionable"],
      [maintSummaryCount(summary,"incompleteSources"),"incomplete sources"],
      [maintAge(asOf),"evidence age"]
    ];
    return values.map(function(item){return '<div><dd>'+esc(item[0])+'</dd><dt>'+esc(item[1])+"</dt></div>";}).join("");
  }

  function renderMaintHeader(){
    var banner=document.getElementById("sys-maint-banner"),summary=document.getElementById("sys-maint-summary");
    if(summary)summary.innerHTML=maintSummary();
    if(!banner)return;
    if(maintenanceBusy&&!MAINTENANCE){
      banner.className="mt-banner readonly";
      banner.innerHTML='<b>Reading maintenance findings</b><span>Current evidence is loading. No actions are available.</span>';
      return;
    }
    if(!MAINTENANCE||MAINTENANCE.error){
      banner.className="mt-banner unavailable";
      banner.innerHTML='<b>Maintenance reporting unavailable</b><span>'
        +esc(MAINTENANCE&&MAINTENANCE.error||"No maintenance read model has been loaded.")+" No actions are available.</span>";
      return;
    }
    var caps=maintCapabilities(),hasExecutable=(MAINTENANCE.findings||[]).some(maintCanPreview);
    var hasUndo=(MAINTENANCE.receipts||[]).some(maintCanUndo);
    if(hasExecutable||hasUndo){
      banner.className="mt-banner enabled";
      banner.innerHTML='<b>Preview before changing</b><span>Each provider-owned change is reviewed and confirmed alone. '
        +"Authorization expires and stays only in this tab.</span>";
      return;
    }
    banner.className="mt-banner readonly";
    banner.innerHTML='<b>Actions are not enabled</b><span>This dashboard can inspect maintenance findings, but no '
      +(caps.apply===true?"finding has an executable provider action.":"change capability is available.")+"</span>";
  }

  function renderMaintBuckets(){
    var el=document.getElementById("sys-maint-buckets"),summary=MAINTENANCE&&MAINTENANCE.summary||{};
    if(!el)return;
    for(var i=0;i<MAINT_BUCKETS.length;i++){
      var spec=MAINT_BUCKETS[i],button=el.querySelector('[data-maint-bucket="'+spec.id+'"]');
      if(!button)continue;
      var count=maintSummaryCount(summary,spec.field);
      button.setAttribute("aria-pressed",maintBucket===spec.id?"true":"false");
      button.classList.toggle("on",maintBucket===spec.id);
      button.innerHTML=esc(spec.label)+' <span class="mono">'+esc(count)+"</span>";
    }
  }

  function renderMaintSelects(){
    var findings=MAINTENANCE&&Array.isArray(MAINTENANCE.findings)?MAINTENANCE.findings:[];
    var kinds={},hosts={};
    for(var i=0;i<findings.length;i++){
      var resource=findings[i].resource||{},kind=maintText(resource.kind),host=maintText(resource.host);
      if(kind)kinds[kind]=true;if(host)hosts[host]=true;
    }
    var kindEl=document.getElementById("sys-maint-kind"),hostEl=document.getElementById("sys-maint-host");
    if(kindEl){
      var kindHtml='<option value="">All resources</option>';
      Object.keys(kinds).sort().forEach(function(kind){kindHtml+='<option value="'+esc(kind)+'">'+esc(maintOptionLabel(kind))+"</option>";});
      kindEl.innerHTML=kindHtml;if(kinds[maintKind])kindEl.value=maintKind;else maintKind="";
    }
    if(hostEl){
      var hostHtml='<option value="">All hosts</option>';
      Object.keys(hosts).sort().forEach(function(host){hostHtml+='<option value="'+esc(host)+'">'+esc(host)+"</option>";});
      hostEl.innerHTML=hostHtml;if(hosts[maintHost])hostEl.value=maintHost;else maintHost="";
    }
  }

  function maintFindingRow(record){
    var finding=record.value,resource=finding.resource||{},state=maintState(finding),selected=record.key===maintSelected;
    var name=maintText(resource.name)||"Unnamed resource";
    var owner=maintText(finding.owner)||maintText(resource.providerRef)||"owner unknown";
    var change=maintText(finding.headline)||maintText(finding.explanation)||"Review the available evidence";
    return '<li><button type="button" class="mt-row" data-maint-key="'+esc(record.key)+'" data-tone="'+state.tone+'"'
      +' aria-controls="sys-maint-detail" aria-expanded="'+(selected?"true":"false")+'"'+(selected?' aria-current="true"':"")+">"
      +'<span class="mt-state">'+esc(state.label)+"</span>"
      +'<span class="mt-identity"><b>'+esc(name)+'</b><small>'+esc(maintOptionLabel(resource.kind||"resource"))+"</small></span>"
      +'<span class="mt-change">'+esc(change)+"</span>"
      +'<span class="mt-owner">'+esc(owner)+"</span>"
      +"</button></li>";
  }

  function maintReceiptRow(record){
    var receipt=record.value||{},selected=record.key===maintSelected;
    var name=maintText(receipt.headline)||maintText(receipt.label)||"Maintenance change";
    var status=maintText(receipt.statusLabel)||maintText(receipt.status)||"Receipt retained";
    return '<li><button type="button" class="mt-row receipt" data-maint-key="'+esc(record.key)+'" data-tone="ready"'
      +' aria-controls="sys-maint-detail" aria-expanded="'+(selected?"true":"false")+'"'+(selected?' aria-current="true"':"")+">"
      +'<span class="mt-state">'+esc(status)+"</span>"
      +'<span class="mt-identity"><b>'+esc(name)+"</b><small>Receipt</small></span>"
      +'<span class="mt-change">'+esc(maintText(receipt.summary)||"Recorded maintenance outcome")+"</span>"
      +'<span class="mt-owner">'+esc(maintAge(receipt.completedAt||receipt.at))+"</span>"
      +"</button></li>";
  }

  function renderMaintList(records){
    var el=document.getElementById("sys-maint-list"),status=document.getElementById("sys-maint-results");
    if(!el)return;
    if(status)status.textContent="Showing "+records.length+(maintBucket==="recent-changes"?" recent change":" finding")+(records.length===1?"":"s")+".";
    if(!records.length){
      var text=maintBucket==="recent-changes"?"No maintenance changes have receipts yet."
        :MAINTENANCE&&MAINTENANCE.error?"Maintenance reporting is unavailable. No actions are available."
          :maintQuery||maintKind||maintHost||maintBucket!=="all"?"No findings match these filters."
            :maintSummaryCount(MAINTENANCE&&MAINTENANCE.summary||{},"incompleteSources")>0
              ?"No recommendations yet. Some resources could not be fully evaluated."
              :"Nothing needs attention in this scan.";
      el.innerHTML='<div class="mt-empty">'+esc(text)+"</div>";return;
    }
    el.innerHTML='<ul>'+records.map(function(record,index){return record.kind==="receipt"?maintReceiptRow(record):maintFindingRow(record,index);}).join("")+"</ul>";
  }

  export function maintFact(label,value){
    value=maintValue(value);return value?'<div><dt>'+esc(label)+'</dt><dd>'+esc(value)+"</dd></div>":"";
  }
  function maintNamedValues(value,names){
    if(!value||typeof value!=="object"||Array.isArray(value))return "";
    var out="";
    Object.keys(names).forEach(function(key){if(value[key]!=null)out+=maintFact(names[key],value[key]);});
    return out;
  }
  function maintImpactHtml(impact){
    impact=impact&&typeof impact==="object"?impact:{};
    var summary=maintText(impact.summary),facts="";
    facts+=maintFact("Capabilities",impact.capabilities);
    facts+=maintFact("Projects",impact.projects);
    facts+=maintFact("Preserved",impact.preserved);
    if(!summary&&!facts)return "";
    return '<section class="mt-detail-section"><h4>What changes</h4>'+(summary?"<p>"+esc(summary)+"</p>":"")
      +(facts?'<dl class="mt-facts compact">'+facts+"</dl>":"")+"</section>";
  }
  function maintFindingActionHtml(finding){
    if(!maintCanPreview(finding))return '<small>Reporting only. No action runs from this view.</small>';
    return '<div class="mt-action-bar"><button type="button" class="mt-action primary" data-maint-action="preview">Preview change</button>'
      +'<small>Reviews this one provider-owned change. Nothing runs until you confirm.</small></div>';
  }
  function maintNextHtml(finding){
    var next=finding&&finding.nextAction,action=finding&&(finding.action||finding.nextAction)||{};
    var text=maintText(next)||maintText(next&&next.label)||maintText(next&&next.summary)||maintText(next&&next.guidance)
      ||maintText(action.summary)||maintText(action.reason);
    var command=maintText(next&&next.command)||maintText(action.command);
    var facts="";
    facts+=maintFact("Safety",action.safetyClass);
    facts+=maintFact("Restart",action.restartRequired===true?"Required":action.restartRequired===false?"Not reported as required":action.restart);
    facts+=maintFact("Rollback",action.rollback);
    if(!text&&!command&&!facts&&!maintCanPreview(finding))return "";
    return '<section class="mt-detail-section mt-next"><h4>Next step</h4>'+(text?"<p>"+esc(text)+"</p>":"")
      +(facts?'<dl class="mt-facts compact">'+facts+"</dl>":"")
      +(command?'<code>'+esc(command)+"</code>":"")
      +maintFindingActionHtml(finding)+"</section>";
  }

  function maintFindingDetail(finding){
    var resource=finding.resource||{},evidence=finding.evidence||{},versions=finding.versions||{},state=maintState(finding);
    var title=maintText(resource.name)||"Unnamed resource",reasons=maintList(evidence.reasons);
    var facts="";
    facts+=maintFact("Owner",finding.owner||resource.providerRef||"Owner unknown");
    facts+=maintFact("Resource",maintOptionLabel(resource.kind||"resource"));
    facts+=maintFact("Host",resource.host);
    facts+=maintFact("Scope",resource.scope);
    facts+=maintFact("Evidence",evidence.completeness||"Completeness unknown");
    facts+=maintFact("Captured",evidence.asOf?maintAge(evidence.asOf):MAINTENANCE&&MAINTENANCE.asOf?maintAge(MAINTENANCE.asOf):"");
    var versionFacts=maintNamedValues(versions,{
      installed:"Installed",installedVersion:"Installed",effective:"Effective",effectiveVersion:"Effective",
      recommended:"Recommended compatible",recommendedVersion:"Recommended compatible",
      producer:"Producer",producerVersion:"Producer",marketplaceRevision:"Marketplace revision",
      sourceRevision:"Source revision",cacheGeneration:"Cache generation",contentDigest:"Content digest"
    });
    return '<div class="mt-detail-head"><span class="mt-state" data-tone="'+state.tone+'">'+esc(state.label)+'</span>'
      +'<h3 id="sys-maint-detail-title" tabindex="-1">'+esc(title)+"</h3></div>"
      +(maintText(finding.explanation)?'<p class="mt-explanation">'+esc(maintText(finding.explanation))+"</p>":"")
      +'<dl class="mt-facts">'+facts+"</dl>"
      +(reasons.length?'<div class="mt-evidence-gap"><b>Evidence needs attention</b><ul>'+reasons.map(function(reason){return "<li>"+esc(reason)+"</li>";}).join("")+"</ul></div>":"")
      +(versionFacts?'<section class="mt-detail-section"><h4>Versions and source</h4><dl class="mt-facts compact">'+versionFacts+"</dl></section>":"")
      +maintImpactHtml(finding.impact)+maintNextHtml(finding)
      +'<details class="mt-technical"><summary>Technical evidence</summary><dl class="mt-facts compact">'
      +maintFact("Source",evidence.source)+maintFact("Authority",evidence.authority)+maintFact("Health",evidence.health)
      +maintFact("Provider reference",resource.providerRef)+"</dl></details>";
  }

  function maintReceiptDetail(receipt){
    var title=maintText(receipt.headline)||maintText(receipt.label)||"Maintenance change";
    var undo=receipt&&receipt.undo,undoStatus=maintText(receipt.undoStatus)
      ||maintText(undo&&typeof undo==="object"&&(undo.status||undo.label||undo.summary))
      ||maintText(typeof undo==="string"?undo:"");
    var undoAction=maintCanUndo(receipt)
      ?'<div class="mt-action-bar"><button type="button" class="mt-action" data-maint-action="undo">Preview undo</button>'
        +'<small>The server marked this receipt eligible. Undo is previewed and confirmed separately.</small></div>'
      :'<p class="mt-report-only">No eligible undo is available for this receipt.</p>';
    return '<div class="mt-detail-head"><span class="mt-state" data-tone="ready">'
      +esc(maintText(receipt.statusLabel)||maintText(receipt.status)||"Receipt retained")+'</span><h3 id="sys-maint-detail-title" tabindex="-1">'
      +esc(title)+"</h3></div>"+(maintText(receipt.summary)?'<p class="mt-explanation">'+esc(maintText(receipt.summary))+"</p>":"")
      +'<dl class="mt-facts">'+maintFact("Receipt",maintReceiptId(receipt))+maintFact("Completed",receipt.completedAt||receipt.at)
      +maintFact("Verification",receipt.verification)+maintFact("Undo",undoStatus)+"</dl>"+undoAction;
  }

  function renderMaintDetail(records){
    var el=document.getElementById("sys-maint-detail");if(!el)return;
    var record=records.find(function(item){return item.key===maintSelected;});
    if(!record){el.innerHTML='<div class="mt-detail-empty"><b>Select a finding</b><span>Its ownership, impact, evidence, and next step will appear here.</span></div>';return;}
    el.innerHTML=record.kind==="receipt"?maintReceiptDetail(record.value):maintFindingDetail(record.value);
  }

  export function renderMaintenance(){
    renderMaintHeader();renderMaintBuckets();renderMaintSelects();
    var records=maintRecords();
    if(!records.some(function(record){return record.key===maintSelected;}))maintSelected=records.length?records[0].key:null;
    renderMaintList(records);renderMaintDetail(records);
    var root=document.getElementById("sys-maintenance");if(root)root.setAttribute("aria-busy",maintenanceBusy||maintActionBusy?"true":"false");
  }

  export function loadMaintenance(force){
    if(maintenanceBusy||maintActionBusy||maintActionActive())return Promise.resolve();
    if(MAINTENANCE&&!force){renderMaintenance();return Promise.resolve();}
    maintenanceBusy=true;renderMaintenance();
    return fetch("/api/maintenance",{cache:"no-store",headers:authHeaders()}).then(function(response){
      if(!response.ok)throw Error(response.status===404?"Maintenance reporting is not available in this build.":"Maintenance findings could not be read.");
      return response.json();
    }).then(function(data){MAINTENANCE=data&&typeof data==="object"?maintMergeReceipts(data):{error:"The maintenance response was empty."};})
      .catch(function(error){MAINTENANCE={error:error&&error.message||"Maintenance findings could not be read."};})
      .then(function(){maintenanceBusy=false;renderMaintenance();});
  }

  export function wireMaintenance(){
    if(maintenanceWired)return;maintenanceWired=true;
    var buckets=document.getElementById("sys-maint-buckets");
    if(buckets)buckets.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-maint-bucket]"):null;if(!button)return;
      maintBucket=button.getAttribute("data-maint-bucket")||"all";maintSelected=null;renderMaintenance();
    });
    var search=document.getElementById("sys-maint-search");
    if(search)search.addEventListener("input",function(){maintQuery=String(search.value||"").trim().toLowerCase();maintSelected=null;renderMaintenance();});
    var kind=document.getElementById("sys-maint-kind");
    if(kind)kind.addEventListener("change",function(){maintKind=kind.value||"";maintSelected=null;renderMaintenance();});
    var host=document.getElementById("sys-maint-host");
    if(host)host.addEventListener("change",function(){maintHost=host.value||"";maintSelected=null;renderMaintenance();});
    var list=document.getElementById("sys-maint-list");
    if(list)list.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-maint-key]"):null;if(!button)return;
      maintSelected=button.getAttribute("data-maint-key");var records=maintRecords();renderMaintList(records);renderMaintDetail(records);
    });
    wireMaintActions(document.getElementById("sys-maintenance"));
  }
