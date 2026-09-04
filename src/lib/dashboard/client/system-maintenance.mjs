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
  var maintenanceWired=false,maintBucket="all",maintKind="",maintHost="",maintRelation="",maintQuery="",maintSelected=null;
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
  var MAINT_RELATION_LABEL={
    "redundant-project-override":"Identical project copies",
    "same-name-different-definition":"Different definitions",
    "tracked-source-copy":"Tracked project copies",
    "legacy-equivalent-transport":"Legacy transports"
  };

  export function maintText(value){
    return typeof value==="string"||typeof value==="number"?String(value):"";
  }
  function maintDerivedCount(field){
    var findings=MAINTENANCE&&Array.isArray(MAINTENANCE.findings)?MAINTENANCE.findings:[];
    if(field==="total")return findings.length;
    if(field==="recentChanges")return MAINTENANCE&&Array.isArray(MAINTENANCE.receipts)?MAINTENANCE.receipts.length:0;
    if(field==="actionable")return findings.filter(function(finding){var action=finding&&(finding.action||finding.nextAction);return action&&action.executable===true;}).length;
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
    var executable=maintCanPreview(finding);
    var fallback=executable?"Ready to apply":bucket==="updates-ready"?"Update available"
      :bucket==="safe-cleanup"?"Cleanup candidate":bucket==="blocked"?"Cannot safely automate":"Review required";
    var label=maintText(finding&&finding.statusLabel)||fallback;
    var tone=executable?"ready":bucket==="blocked"?"blocked":"review";
    if(/incomplete|unknown|partial/i.test(label))tone="incomplete";
    return {bucket:bucket,label:label,tone:tone};
  }
  export function maintAge(value){
    var at=Date.parse(maintText(value));
    return Number.isFinite(at)?ago(Math.max(0,Math.round((Date.now()-at)/1000))):"time unknown";
  }
  var MAINT_RECEIPT_STATE={
    prepared:{label:"Prepared action interrupted",tone:"blocked",timeLabel:"Updated",summary:"The action was prepared, but the journal has not been reconciled. Recover this receipt before another change."},
    applying:{label:"Apply interrupted",tone:"blocked",timeLabel:"Updated",summary:"A provider action may have started. Recover this receipt before another maintenance change."},
    verifying:{label:"Verification interrupted",tone:"blocked",timeLabel:"Updated",summary:"A provider action was recorded, but native verification did not finish. Recovery is required."},
    "refreshing-catalog":{label:"Catalog refresh interrupted",tone:"blocked",timeLabel:"Updated",summary:"The native outcome was recorded, but the Catalog refresh did not finish. Recovery is required."},
    undoing:{label:"Undo interrupted",tone:"blocked",timeLabel:"Updated",summary:"Undo started, but the restored state was not proven. Recover this receipt before another change."},
    committed:{label:"Change recorded",tone:"ready",timeLabel:"Recorded",summary:"The maintenance change completed and was verified."},
    applied:{label:"Change recorded",tone:"ready",timeLabel:"Recorded",summary:"The maintenance change completed and was verified."},
    "rolled-back":{label:"Change rolled back",tone:"ready",timeLabel:"Recorded",summary:"The recorded pre-change state was restored and verified."},
    undone:{label:"Undo recorded",tone:"ready",timeLabel:"Recorded",summary:"The maintenance change was restored and verified."},
    "already-rolled-back":{label:"Already rolled back",tone:"ready",timeLabel:"Recorded",summary:"The recorded maintenance change had already been restored."},
    "aborted-no-change":{label:"No change made",tone:"ready",timeLabel:"Recorded",summary:"The journal proves that no provider action started."},
    "recovered-no-change":{label:"No change observed",tone:"ready",timeLabel:"Recorded",summary:"Recovery inspected the provider and confirmed the recorded pre-change state."},
    "already-reconciled":{label:"Already reconciled",tone:"ready",timeLabel:"Recorded",summary:"This receipt had already been reconciled against current provider state."}
  };
  var MAINT_RECOVERY_STATE={label:"Recovery required",tone:"blocked",timeLabel:"Updated",summary:"Maintenance could not prove a complete outcome. Inspect or recover this receipt before another change."};
  export function maintReceiptPresentation(receipt){
    receipt=receipt&&typeof receipt==="object"?receipt:{};
    var status=maintText(receipt.status).toLowerCase();
    var state=MAINT_RECEIPT_STATE[status]||MAINT_RECOVERY_STATE;
    return {
      status:status,label:state.label,tone:state.tone,
      summary:maintText(receipt.summary)||state.summary,timeLabel:state.timeLabel,
      at:receipt.completedAt||receipt.updatedAt||receipt.createdAt||receipt.at
    };
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
    var undo=receipt&&receipt.undo,status=maintText(receipt&&receipt.status).toLowerCase();
    return maintCapabilities().undo===true&&!!receipt&&(status==="committed"||status==="applied")&&(receipt.undoEligible===true
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
    if(MAINTENANCE&&typeof MAINTENANCE==="object"){
      var current=Array.isArray(MAINTENANCE.receipts)?MAINTENANCE.receipts:[];
      MAINTENANCE.receipts=[receipt].concat(current.filter(function(item){return !id||maintReceiptId(item)!==id;}));
    }
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
      if(maintRelation&&maintText(finding&&finding.relationship&&finding.relationship.kind)!==maintRelation)return false;
      if(maintQuery){
        var members=finding.relationship&&Array.isArray(finding.relationship.members)?finding.relationship.members:[];
        var hay=[finding.headline,finding.explanation,resource.name,resource.kind,resource.host,resource.providerRef,finding.owner,
          maintSuggestedAction(finding)].concat(members.map(function(member){return [member.label,member.projectLabel,member.providerRef].join(" ");}))
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
      banner.innerHTML='<b>Reading current copies and provider evidence…</b><span>Actions stay unavailable until the scan finishes.</span>';
      return;
    }
    if(!MAINTENANCE||MAINTENANCE.error){
      banner.className="mt-banner unavailable";
      banner.innerHTML='<b>Maintenance reporting unavailable</b><span>'
        +esc(MAINTENANCE&&MAINTENANCE.error||"No maintenance read model has been loaded.")
        +' No actions are available.</span><button type="button" class="mt-action" data-maint-retry>Retry report</button>';
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
    var kinds={},hosts={},relations={};
    for(var i=0;i<findings.length;i++){
      var resource=findings[i].resource||{},kind=maintText(resource.kind),host=maintText(resource.host);
      if(kind)kinds[kind]=true;if(host)hosts[host]=true;
      var relation=maintText(findings[i].relationship&&findings[i].relationship.kind);if(relation)relations[relation]=true;
    }
    var kindEl=document.getElementById("sys-maint-kind"),hostEl=document.getElementById("sys-maint-host"),relationEl=document.getElementById("sys-maint-relation");
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
    if(relationEl){
      var relationHtml='<option value="">All relationships</option>';
      Object.keys(relations).sort().forEach(function(relation){relationHtml+='<option value="'+esc(relation)+'">'+esc(MAINT_RELATION_LABEL[relation]||relation)+"</option>";});
      relationEl.innerHTML=relationHtml;if(relations[maintRelation])relationEl.value=maintRelation;else maintRelation="";
      relationEl.hidden=Object.keys(relations).length===0;
    }
  }

  function maintSuggestedAction(finding){
    var next=finding&&finding.nextAction,action=finding&&(finding.action||finding.nextAction)||{};
    if(typeof next==="string")return next;
    return maintText(next&&next.label)||maintText(next&&next.recommendation)||maintText(next&&next.guidance)
      ||maintText(next&&next.summary)||maintText(action&&action.summary)
      ||"Run a deep System rescan before changing this resource.";
  }
  function maintActionReason(finding){
    var next=finding&&finding.nextAction;if(!next||typeof next!=="object")return "";
    var label=maintText(next.label),reason=maintText(next.recommendation);
    return reason&&reason!==label?reason:"";
  }

  function maintFindingRow(record){
    var finding=record.value,resource=finding.resource||{},state=maintState(finding),selected=record.key===maintSelected;
    var name=maintText(resource.name)||"Unnamed resource";
    var owner=maintText(finding.owner)||maintText(resource.providerRef)||"owner unknown";
    var change=maintText(finding.headline)||maintText(finding.explanation)||"Review the available evidence";
    var suggestion=maintSuggestedAction(finding);
    return '<li><button type="button" class="mt-row" data-maint-key="'+esc(record.key)+'" data-tone="'+state.tone+'"'
      +' aria-controls="sys-maint-detail" aria-expanded="'+(selected?"true":"false")+'"'+(selected?' aria-current="true"':"")+">"
      +'<span class="mt-state">'+esc(state.label)+"</span>"
      +'<span class="mt-identity"><b>'+esc(name)+'</b><small>'+esc(maintOptionLabel(resource.kind||"resource"))+"</small></span>"
      +'<span class="mt-change"><span>'+esc(change)+'</span><small>Action: '+esc(suggestion)+"</small></span>"
      +'<span class="mt-owner">'+esc(owner)+"</span>"
      +"</button></li>";
  }

  function maintReceiptRow(record){
    var receipt=record.value||{},selected=record.key===maintSelected;
    var state=maintReceiptPresentation(receipt);
    var name=maintText(receipt.headline)||maintText(receipt.label)||"Maintenance change";
    return '<li><button type="button" class="mt-row receipt" data-maint-key="'+esc(record.key)+'" data-tone="'+state.tone+'"'
      +' aria-controls="sys-maint-detail" aria-expanded="'+(selected?"true":"false")+'"'+(selected?' aria-current="true"':"")+">"
      +'<span class="mt-state">'+esc(state.label)+"</span>"
      +'<span class="mt-identity"><b>'+esc(name)+"</b><small>Receipt</small></span>"
      +'<span class="mt-change">'+esc(state.summary)+"</span>"
      +'<span class="mt-owner">'+esc(state.timeLabel+" "+maintAge(state.at))+"</span>"
      +"</button></li>";
  }

  function renderMaintList(records){
    var el=document.getElementById("sys-maint-list"),status=document.getElementById("sys-maint-results");
    if(!el)return;
    if(status)status.textContent="Showing "+records.length+(maintBucket==="recent-changes"?" recent change":" finding")+(records.length===1?"":"s")+".";
    if(!records.length){
      var text=maintBucket==="recent-changes"?"No maintenance changes have receipts yet."
        :MAINTENANCE&&MAINTENANCE.error?"Maintenance reporting is unavailable. No actions are available."
          :maintQuery||maintKind||maintHost||maintRelation||maintBucket!=="all"?"No findings match these filters."
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
  function maintImpactHtml(impact,finding){
    impact=impact&&typeof impact==="object"?impact:{};
    var summary=maintText(impact.summary),facts="";
    facts+=maintFact("Capabilities",impact.capabilities);
    facts+=maintFact("Projects",impact.projects);
    if(!summary&&!facts)return "";
    return '<section class="mt-detail-section"><h4>'+(maintCanPreview(finding)?"Effect":"Potential effect")+'</h4>'+(summary?"<p>"+esc(summary)+"</p>":"")
      +(facts?'<dl class="mt-facts compact">'+facts+"</dl>":"")+"</section>";
  }
  function maintPreviewLabel(finding){
    var action=finding&&(finding.action||finding.nextAction)||{};
    return {update:"Preview update",remove:"Preview uninstall",disable:"Preview disable",clean:"Preview cleanup",
      archive:"Preview archive",terminate:"Preview termination"}[maintText(action.operation)]||"Preview action";
  }
  function maintFindingActionHtml(finding){
    if(!maintCanPreview(finding))return "";
    return '<div class="mt-action-bar"><button type="button" class="mt-action primary" data-maint-action="preview">'+esc(maintPreviewLabel(finding))+"</button>"
      +'<small>Nothing changes until you review and confirm this exact action.</small></div>';
  }
  function maintNextHtml(finding){
    var next=finding&&finding.nextAction,action=finding&&(finding.action||finding.nextAction)||{};
    var text=maintSuggestedAction(finding),reason=maintActionReason(finding),steps=maintList(next&&next.steps),preserved=maintList(next&&next.preserved);
    var blockedReason=maintText(next&&next.blockedReason)||maintText(action.reason);
    var command=maintText(next&&next.command)||maintText(action.command);
    var facts="";
    if(maintCanPreview(finding)){
      facts+=maintFact("Restart",action.restartRequired===true?"Required":action.restartRequired===false?"Not required":action.restart);
      facts+=maintFact("Undo",action.rollback==="reversible"?"Available after apply":action.rollback);
    }
    return '<section class="mt-detail-section mt-next"><h4>Recommended action</h4>'+(text?'<p class="mt-action-title">'+esc(text)+"</p>":"")
      +(reason?'<p class="mt-action-reason">'+esc(reason)+"</p>":"")
      +(steps.length?'<details class="mt-procedure"><summary>How to resolve</summary><ol class="mt-steps">'+steps.map(function(step){return "<li>"+esc(step)+"</li>";}).join("")+"</ol></details>":"")
      +(preserved.length?'<p class="mt-preserved"><b>Preserved:</b> '+esc(preserved.join(", "))+".</p>":"")
      +(!maintCanPreview(finding)&&blockedReason?'<p class="mt-blocked-reason"><b>Not available here:</b> '+esc(blockedReason)+"</p>":"")
      +(facts?'<dl class="mt-facts compact">'+facts+"</dl>":"")
      +(command?'<code>'+esc(command)+"</code>":"")
      +maintFindingActionHtml(finding)+"</section>";
  }

  function maintRelationshipHtml(relationship){
    if(!relationship||!Array.isArray(relationship.members)||!relationship.members.length)return "";
    var rows=relationship.members.map(function(member){
      var source=maintText(member.projectLabel)||maintText(member.providerRef)||maintText(member.scope)||"Source not reported";
      var evidence=[maintText(member.scope),maintText(member.ownership),maintText(member.tracking),maintText(member.workingTree)]
        .filter(Boolean).join(" · ");
      return "<tr><th scope=\"row\">"+esc(member.label||member.role||"Observed copy")+"</th><td>"+esc(source)+"</td><td>"+esc(evidence)+"</td></tr>";
    }).join("");
    var note=relationship.truncated?'<p class="mt-table-note">Showing '+esc(relationship.members.length)+" of "+esc(relationship.memberCount)+" observed copies.</p>":"";
    return '<section class="mt-detail-section"><h4>Observed copies</h4><div class="mt-copy-scroll" tabindex="0"><table class="mt-copy-table">'
      +'<caption class="sr-only">Observed project and shared resource copies</caption><thead><tr><th>Copy</th><th>Source</th><th>Evidence</th></tr></thead><tbody>'
      +rows+"</tbody></table></div>"+note+"</section>";
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
      +maintRelationshipHtml(finding.relationship)
      +(versionFacts?'<section class="mt-detail-section"><h4>Versions and source</h4><dl class="mt-facts compact">'+versionFacts+"</dl></section>":"")
      +maintImpactHtml(finding.impact,finding)+maintNextHtml(finding)
      +'<details class="mt-technical"><summary>Technical evidence</summary><dl class="mt-facts compact">'
      +maintFact("Source",evidence.source)+maintFact("Authority",evidence.authority)+maintFact("Health",evidence.health)
      +maintFact("Provider reference",resource.providerRef)+"</dl></details>";
  }

  function maintReceiptDetail(receipt){
    var title=maintText(receipt.headline)||maintText(receipt.label)||"Maintenance change";
    var state=maintReceiptPresentation(receipt);
    var undo=receipt&&receipt.undo,undoStatus=maintText(receipt.undoStatus)
      ||maintText(undo&&typeof undo==="object"&&(undo.status||undo.label||undo.summary))
      ||maintText(typeof undo==="string"?undo:"");
    var undoAction=maintCanUndo(receipt)
      ?'<div class="mt-action-bar"><button type="button" class="mt-action" data-maint-action="undo">Preview undo</button>'
        +'<small>The server marked this receipt eligible. Undo is previewed and confirmed separately.</small></div>'
      :'<p class="mt-report-only">No eligible undo is available for this receipt.</p>';
    return '<div class="mt-detail-head"><span class="mt-state" data-tone="'+state.tone+'">'
      +esc(state.label)+'</span><h3 id="sys-maint-detail-title" tabindex="-1">'
      +esc(title)+"</h3></div>"+'<p class="mt-explanation">'+esc(state.summary)+"</p>"
      +'<dl class="mt-facts">'+maintFact("Receipt",maintReceiptId(receipt))+maintFact(state.timeLabel,maintAge(state.at))
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
    var relation=document.getElementById("sys-maint-relation");
    if(relation)relation.addEventListener("change",function(){maintRelation=relation.value||"";maintSelected=null;renderMaintenance();});
    var banner=document.getElementById("sys-maint-banner");
    if(banner)banner.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-maint-retry]"):null;if(button)loadMaintenance(true);
    });
    var list=document.getElementById("sys-maint-list");
    if(list)list.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-maint-key]"):null;if(!button)return;
      maintSelected=button.getAttribute("data-maint-key");var records=maintRecords();renderMaintList(records);renderMaintDetail(records);
    });
    wireMaintActions(document.getElementById("sys-maintenance"));
  }
