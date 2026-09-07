// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 Guidance destination (MNT-GUD-001/003, MNT-RCV-001/008/012). Five
// outcome-first lanes with resource type as a filter; the procedure panel;
// decisions compared without a write action; updates disclosed without a
// write action (an apply-lane entry, not this lane, carries any real Update
// verb); and Recovery's single "Audit interruption" -> disclosure/result ->
// exactly one Record button, or "No corrective action is offered." + export.
import { mntWritesBlocked } from './maintenance-operation.mjs';
import { esc } from './bootstrap.mjs';
import {
  MNT, MNT_AUDIT_ACTION_LABEL, MNT_AUDIT_RESULT_LABELS, MNT_GUIDANCE_LANE_LABELS,
  MNT_NO_CORRECTIVE_ACTION, MNT_RECONCILE_OUTCOME_LABELS, mntAnnounce, mntGet, mntHumanize,
  mntKindLabel, mntPost, mntPushEscapable, mntPopEscapable, mntRefreshActiveDestination,
  mntRegisterDestination, mntScanRequiredAnnouncement, mntScanRequiredHtml,
} from './maintenance-workspace.mjs';
import { beginMaintPreview, beginMaintReconcile } from './system-maintenance-actions.mjs';

  var MNT_LANES=["apply","steps","decision","update","recovery"];
  var MNT_LANE_VIEW={apply:"can-apply",steps:"steps",decision:"decisions",update:"updates"};
  var VERB_LABEL={
    update:"Update",disable:"Disable",remove:"Remove","repair-registration":"Repair registration",
    "relink-dependency":"Relink dependency",reinstall:"Reinstall","clean-cache":"Clean cache",
    restore:"Restore",snooze:"Snooze",acknowledge:"Acknowledge",archive:"Archive",terminate:"Terminate",
    "apply-project-patch":"Apply project patch",
  };
  // Verbs whose label is already a complete, self-contained imperative — see
  // query.mjs's SELF_CONTAINED_VERBS, mirrored here so the row action inside
  // the inspector and Guidance list never appends a redundant resource noun.
  var MNT_SELF_CONTAINED_VERBS={"apply-project-patch":true};

  var mntGuidanceWired=false,mntGuidanceBusy=false,mntGuidanceError=null,mntActiveLane="apply";
  var mntPlacementIndex={};

  // ── Shared renderer: the inspector's "What can I accomplish?" section and
  // this destination's lane lists render the same GuidanceEntry shape. ──
  function mntChoiceHtml(choice){
    return "<li><b>"+esc(choice.label)+"</b><p>Changes: "+esc(choice.changes)+". Keeps: "+esc(choice.keeps)+".</p>"
      +(choice.grounded?"":"<p>"+esc(choice.reason||"")+"</p>")+"</li>";
  }
  function mntEntryOutcomeLabel(entry){
    if(entry.lane==="apply"&&entry.verb&&VERB_LABEL[entry.verb]){
      if(MNT_SELF_CONTAINED_VERBS[entry.verb])return esc(VERB_LABEL[entry.verb]);
      // GuidanceEntry carries no resourceKind of its own — the joined
      // placement row (see mntJoinPlacements below) is the only source for
      // the resource-kind noun a verb-specific row action needs.
      var row=mntPlacementRows[entry.placementId];
      var noun=row?mntKindLabel(row.kind):"";
      return esc(VERB_LABEL[entry.verb]+(noun?" "+noun.toLowerCase():""));
    }
    return esc(entry.outcome);
  }
  export function mntRenderGuidanceEntry(entry){
    var body="";
    if(entry.lane==="apply"){
      body='<button type="button" class="mt-action primary" data-mnt-plan-plc="'+esc(entry.placementId)
        +'" data-mnt-plan-gid="'+esc(entry.guidanceId)+'"'+(mntWritesBlocked()?" disabled":"")+'>'
        +mntEntryOutcomeLabel(entry)+"</button>";
    }else if(entry.lane==="steps"){
      body='<button type="button" class="mt-action" data-mnt-procedure-gid="'+esc(entry.guidanceId)+'">Open procedure</button>';
    }else if(entry.lane==="decision"&&entry.choices){
      body='<ul class="mnt-choices">'+entry.choices.map(mntChoiceHtml).join("")+"</ul>";
    }else if(entry.lane==="update"){
      body='<p>Candidate: '+esc(entry.candidateId)+"</p>"
        +(entry.recommended&&entry.recommendationAuthority?"<p>Recommended by "+esc(entry.recommendationAuthority)+"</p>":"");
    }else if(entry.lane==="recovery"){
      body='<button type="button" class="mt-action" data-mnt-audit-receipt="'+esc(entry.receiptId)
        +'" data-mnt-audit-plc="'+esc(entry.placementId)+'">'+esc(MNT_AUDIT_ACTION_LABEL)+"</button>";
    }
    var warning=entry.warning?'<p class="mnt-warning">'+esc(entry.warning.impact)+"</p>":"";
    return '<article class="mnt-guidance-entry" data-mnt-gid="'+esc(entry.guidanceId)+'">'
      +"<h5>"+esc(entry.outcome)+"</h5>"
      +(entry.impact&&entry.impact.summary?"<p>"+esc(entry.impact.summary)+"</p>":"")
      +warning+body+mntRenderDispositions(entry)+"</article>";
  }

  // ── Dispositions (MNT-GUD-009/011): Acknowledge / Snooze until… / Ignore
  // this exact candidate — every one explained before it is confirmed, and
  // every write is exactly one guidanceId, POST /v2/dispositions. ──
  function mntDispositionExplanation(kind){
    if(kind==="acknowledged")return "Acknowledging keeps this outcome visible but stops highlighting it as new.";
    if(kind==="snoozed")return "Snoozing hides this outcome from Guidance until the date you chose, or until the evidence changes.";
    return "Ignoring this exact candidate hides only this specific update; a different candidate can still surface.";
  }
  function mntRenderDispositions(entry){
    var hasCandidate=entry.candidateId!=null;
    return '<div class="mnt-dispositions" data-mnt-gid="'+esc(entry.guidanceId)+'">'
      +'<button type="button" class="mt-action" data-mnt-disposition-open="acknowledged">Acknowledge</button>'
      +'<label class="mnt-snooze-label">Snooze until <input type="date" class="mnt-snooze-date"></label>'
      +'<button type="button" class="mt-action" data-mnt-disposition-open="snoozed">Snooze</button>'
      +(hasCandidate?'<button type="button" class="mt-action" data-mnt-disposition-open="ignored-exact-candidate">Ignore this candidate</button>':"")
      +'<div class="mnt-disposition-confirm" hidden></div></div>';
  }
  function mntOpenDispositionConfirm(trigger){
    var kind=trigger.getAttribute("data-mnt-disposition-open");
    var container=trigger.closest(".mnt-dispositions");
    if(!container)return;
    var until=null;
    if(kind==="snoozed"){
      var dateInput=container.querySelector(".mnt-snooze-date");
      until=dateInput?dateInput.value:"";
      if(!until)return; // a snooze needs a chosen date before it can be confirmed
    }
    var confirmBox=container.querySelector(".mnt-disposition-confirm");
    if(!confirmBox)return;
    confirmBox.hidden=false;
    confirmBox.innerHTML="<p>"+esc(mntDispositionExplanation(kind))+"</p>"
      +'<button type="button" class="mt-action primary" data-mnt-disposition-confirm="'+esc(kind)+'"'
      +(until?' data-mnt-disposition-until="'+esc(until)+'"':"")+">Confirm</button>"
      +'<button type="button" class="mt-action" data-mnt-disposition-cancel>Cancel</button>';
  }
  function mntConfirmDisposition(trigger){
    var kind=trigger.getAttribute("data-mnt-disposition-confirm");
    var untilDate=trigger.getAttribute("data-mnt-disposition-until");
    var container=trigger.closest(".mnt-dispositions");
    var guidanceId=container&&container.getAttribute("data-mnt-gid");
    if(!guidanceId)return;
    var payload={guidanceId:guidanceId,kind:kind,confirm:true};
    if(untilDate)payload.until=new Date(untilDate+"T00:00:00.000Z").toISOString();
    return mntPost("/api/maintenance/v2/dispositions",payload).then(function(){
      mntAnnounce("Recorded.");
      mntRefreshActiveDestination();
    }).catch(function(){
      mntAnnounce("The disposition could not be recorded.");
    });
  }

  // ── Fetch + join with a placement's display data. GuidanceEntry carries
  // only a placementId — an inventory query is still the only source for a
  // displayName/scope to head a Guidance row, but the row itself now carries
  // its own `kind` (query.mjs's buildPlacementRow), so no extra unwrapping
  // is needed here beyond keying rows by placementId. ──
  function mntJoinPlacements(view){
    if(mntPlacementIndex[view])return Promise.resolve();
    return mntGet("/api/maintenance/v2/inventory?scope=across&view="+encodeURIComponent(view)+"&limit=200")
      .then(function(page){
        mntPlacementIndex[view]=true;
        (page.groups||[]).forEach(function(group){
          (group.placements||[]).forEach(function(row){
            mntPlacementRows[row.placementId]=row;
          });
        });
      }).catch(function(){mntPlacementIndex[view]=true;});
  }
  var mntPlacementRows={};

  export function loadMntGuidance(force){
    if(mntGuidanceBusy&&!force)return Promise.resolve();
    mntGuidanceBusy=true;mntGuidanceError=null;renderMntGuidance();
    return mntGet("/api/maintenance/v2/guidance").then(function(data){
      MNT.guidance=data;mntGuidanceBusy=false;
      var firstNonEmpty=MNT_LANES.find(function(lane){return (data.counts&&data.counts[lane])>0;});
      if(firstNonEmpty)mntActiveLane=firstNonEmpty;
      var view=MNT_LANE_VIEW[mntActiveLane];
      return (view?mntJoinPlacements(view):Promise.resolve()).then(renderMntGuidance);
    }).catch(function(error){
      mntGuidanceBusy=false;mntGuidanceError=error;renderMntGuidance();
    });
  }

  function renderMntLaneTabs(){
    var el=document.getElementById("mnt-lanes");if(!el)return;
    var counts=(MNT.guidance&&MNT.guidance.counts)||{};
    el.innerHTML=MNT_LANES.map(function(lane){
      var on=lane===mntActiveLane;
      var count=counts[lane]||0;
      return '<button type="button" class="seg-btn" role="tab" data-mnt-lane="'+esc(lane)
        +'" aria-selected="'+(on?"true":"false")+'"'+(on?"":' tabindex="-1"')+">"
        +esc(MNT_GUIDANCE_LANE_LABELS[lane])+' <span class="mono">'+esc(count)+"</span></button>";
    }).join("");
  }

  function mntEntriesForLane(){
    var entries=(MNT.guidance&&MNT.guidance.entries)||[];
    var kindFilter=document.getElementById("mnt-guidance-kind");
    var kind=kindFilter?kindFilter.value:"";
    return entries.filter(function(entry){
      if(entry.lane!==mntActiveLane)return false;
      if(!kind)return true;
      var row=mntPlacementRows[entry.placementId];
      return row&&row.kind===kind;
    });
  }

  function mntRowLabelFor(entry){
    var row=mntPlacementRows[entry.placementId];
    return row?esc(row.displayName)+' <span class="mnt-row-scope">'+esc(row.scope.label)+"</span>":"";
  }

  function renderMntGuidanceList(){
    var el=document.getElementById("mnt-guidance-list");if(!el)return;
    if(mntGuidanceError){el.innerHTML='<div class="mnt-empty">Guidance could not be read.</div>';return;}
    if(MNT.guidance&&MNT.guidance.scanRequired){
      el.innerHTML=mntScanRequiredHtml(MNT.guidance.lastRefresh);
      return;
    }
    var entries=mntEntriesForLane();
    if(!entries.length){el.innerHTML='<div class="mnt-empty">Nothing is in '+esc(MNT_GUIDANCE_LANE_LABELS[mntActiveLane])+" right now.</div>";return;}
    el.innerHTML='<ul class="mnt-guidance-rows">'+entries.map(function(entry){
      return "<li>"+(mntRowLabelFor(entry)||"")+mntRenderGuidanceEntry(entry)+"</li>";
    }).join("")+"</ul>";
  }

  function mntPopulateKindFilter(){
    var el=document.getElementById("mnt-guidance-kind");if(!el)return;
    var entries=(MNT.guidance&&MNT.guidance.entries)||[];
    var kinds={};
    entries.forEach(function(entry){
      var row=mntPlacementRows[entry.placementId];
      if(row)kinds[row.kind]=true;
    });
    var current=el.value;
    el.innerHTML='<option value="">All resource types</option>'+Object.keys(kinds).sort().map(function(kind){
      return '<option value="'+esc(kind)+'">'+esc(mntKindLabel(kind))+"</option>";
    }).join("");
    if(kinds[current])el.value=current;
  }

  export function renderMntGuidance(){
    renderMntLaneTabs();mntPopulateKindFilter();renderMntGuidanceList();
    var status=document.getElementById("mnt-guidance-status");
    if(status){
      var failure=MNT.guidance&&MNT.guidance.scanRequired
        ?mntScanRequiredAnnouncement(MNT.guidance.lastRefresh):null;
      var total=(MNT.guidance&&MNT.guidance.counts&&MNT.guidance.counts.total)||0;
      status.textContent=mntGuidanceBusy?"Reading guidance…"
        :(failure||total+" bounded outcome"+(total===1?"":"s")+" admitted.");
    }
    var badge=document.getElementById("mnt-guidance-badge");
    if(badge){
      var total2=(MNT.guidance&&MNT.guidance.counts&&MNT.guidance.counts.total)||0;
      badge.hidden=total2===0;badge.textContent=String(total2);
    }
  }

  function mntSetLane(lane){
    if(MNT_LANES.indexOf(lane)<0)return;
    mntActiveLane=lane;
    var view=MNT_LANE_VIEW[lane];
    // Repaint the tab strip immediately (no join needed for that), but hold
    // the entry list until the placement-display join resolves — rendering
    // early would show every apply-lane verb without its resource noun on a
    // lane never joined before.
    renderMntLaneTabs();
    (view?mntJoinPlacements(view):Promise.resolve()).then(renderMntGuidance);
  }

  // ── Procedure panel ──────────────────────────────────────────────────────
  function renderMntProcedure(procedure){
    var el=document.getElementById("mnt-procedure");if(!el)return;
    if(!procedure){el.hidden=true;el.innerHTML="";return;}
    el.hidden=false;
    var checklist=(procedure.checklist||[]).map(function(step){
      return '<li><label><input type="checkbox" data-mnt-checklist-step="'+esc(step.stepId)+'"> '+esc(step.label)+"</label></li>";
    }).join("");
    el.innerHTML='<button type="button" class="mt-action" id="mnt-procedure-close">Close</button>'
      +"<h4>"+esc(procedure.outcome)+"</h4>"
      +"<p>"+esc(procedure.source.publisher||procedure.source.authority)+" · v"+esc(procedure.source.recipeVersion)+"</p>"
      +'<label class="sr-only" for="mnt-procedure-shell">Shell</label>'
      +'<select id="mnt-procedure-shell"><option value="'+esc(procedure.command.shell)+'">'
      +esc(procedure.command.shellLabel)+"</option></select>"
      +"<pre>"+esc(procedure.command.text)+"</pre>"
      +'<button type="button" class="mt-action" id="mnt-procedure-copy">Copy command</button>'
      +"<p><b>Verify</b></p><pre>"+esc(procedure.verification.text)+"</pre>"
      +"<ul>"+checklist+"</ul>"
      +"<p>"+esc(procedure.nextStepLabel)+"</p>";
  }
  function mntOpenProcedure(guidanceId){
    return mntGet("/api/maintenance/v2/procedures/"+encodeURIComponent(guidanceId)).then(function(procedure){
      MNT.procedure={guidanceId:guidanceId,data:procedure};
      renderMntProcedure(procedure);
    }).catch(function(){});
  }

  // ── Recovery: Audit interruption → disclosure/result → Record or export ──
  var mntAuditState=null;
  function mntAuditDialogEl(){return document.getElementById("mnt-audit-dialog");}
  function mntOpenAuditDialog(trigger){
    var dialog=mntAuditDialogEl();if(!dialog)return;
    mntAuditState={trigger:trigger};
    if(typeof dialog.showModal==="function"&&!dialog.open)dialog.showModal();
    mntPushEscapable(mntCloseAuditDialog);
  }
  function mntCloseAuditDialog(){
    var dialog=mntAuditDialogEl();if(!dialog)return;
    if(dialog.open&&typeof dialog.close==="function")dialog.close();
    mntPopEscapable(mntCloseAuditDialog);
    var trigger=mntAuditState&&mntAuditState.trigger;
    mntAuditState=null;
    if(trigger&&trigger.isConnected)trigger.focus();
  }
  // Every check status the audit engine can report (interruption-audit.mjs).
  // Some, like "unsupported", are themselves prohibited user-facing words —
  // this map is the ONLY place a raw machine status becomes visible text.
  var MNT_CHECK_STATUS_LABEL={
    passed:"Passed",matched:"Matched",completed:"Completed",failed:"Did not match",
    unsupported:"Not supported by this provider","missing-or-changed":"Provider missing or changed",
    "no-dispatch-recorded":"No dispatch recorded",
  };
  function mntCheckStatusLabel(status){
    if(MNT_CHECK_STATUS_LABEL[status])return MNT_CHECK_STATUS_LABEL[status];
    var text=mntHumanize(status);
    return /^(unknown|unsupported)$/i.test(text)?"Not determined by this check":text;
  }
  function mntRenderAuditChecks(checks,disclosure){
    disclosure=disclosure||{};
    var performed=(checks||[]).map(function(check){
      return "<li>"+esc(mntHumanize(check.name))+" — "+esc(mntCheckStatusLabel(check.status))+"</li>";
    }).join("");
    return (performed?"<p><b>Checks</b></p><ul>"+performed+"</ul>":"")
      +"<p><b>Probe policy:</b> "+esc(disclosure.executableProbePolicy)+"</p>"
      +"<p><b>Network policy:</b> "+esc(disclosure.networkPolicy)+"</p>";
  }
  function mntRenderAuditResult(audit,receiptId){
    var body=document.getElementById("mnt-audit-body");
    var actions=document.getElementById("mnt-audit-actions");
    var status=document.getElementById("mnt-audit-status");
    if(!body||!actions)return;
    body.innerHTML="<p><b>Receipt</b> "+esc(receiptId)+"</p>"
      +(audit.lastDurablePhase?"<p><b>Last durable phase:</b> "+esc(audit.lastDurablePhase)+"</p>":"")
      +(audit.provider?"<p><b>Provider:</b> "+esc(audit.provider.id)+" v"+esc(audit.provider.version)+"</p>":"")
      +mntRenderAuditChecks(audit.checks,audit.disclosure)
      +"<p><b>Result:</b> "+esc(audit.resultLabel||MNT_AUDIT_RESULT_LABELS[audit.result]||audit.result)+"</p>";
    if(audit.enables){
      // The label is already a complete imperative ("Record no change",
      // "Record completed") — do not prefix another "Record " onto it.
      var enablesLabel=audit.enablesLabel||MNT_RECONCILE_OUTCOME_LABELS[audit.enables]||audit.enables;
      actions.innerHTML='<button type="button" class="mt-action primary" id="mnt-audit-record" data-mnt-reconcile-receipt="'
        +esc(receiptId)+'" data-mnt-reconcile-outcome="'+esc(audit.enables)+'">'+esc(enablesLabel)+"</button>";
    }else{
      actions.innerHTML="<p>"+esc(MNT_NO_CORRECTIVE_ACTION)+'</p><button type="button" class="mt-action" id="mnt-audit-export" data-mnt-export-receipt="'
        +esc(receiptId)+'">Export</button>';
    }
    if(status)status.textContent="Audit complete.";
  }
  export function mntBeginAudit(trigger,receiptId){
    mntOpenAuditDialog(trigger);
    var body=document.getElementById("mnt-audit-body");
    var status=document.getElementById("mnt-audit-status");
    if(body)body.innerHTML="<p>Comparing the receipt against current provider evidence…</p>";
    if(status)status.textContent="Auditing. This never retries or replays the action.";
    return mntPost("/api/maintenance/v2/audit",{receiptIds:[receiptId]}).then(function(data){
      var results=data&&(data.audits||data.results)||[];
      var audit=results[0]||{result:null,checks:[],disclosure:{}};
      mntRenderAuditResult(audit,receiptId);
    }).catch(function(){
      if(body)body.innerHTML="<p>The audit could not be completed.</p>";
    });
  }

  export function mntWireGuidanceActions(root){
    if(!root||root.dataset.mntGuidanceWired)return;
    root.dataset.mntGuidanceWired="1";
    root.addEventListener("click",function(event){
      var apply=event.target.closest?event.target.closest("[data-mnt-plan-plc]"):null;
      if(apply){
        beginMaintPreview(apply,{placementId:apply.getAttribute("data-mnt-plan-plc"),guidanceId:apply.getAttribute("data-mnt-plan-gid")});
        return;
      }
      var procedure=event.target.closest?event.target.closest("[data-mnt-procedure-gid]"):null;
      if(procedure){mntOpenProcedure(procedure.getAttribute("data-mnt-procedure-gid"));return;}
      var audit=event.target.closest?event.target.closest("[data-mnt-audit-receipt]"):null;
      if(audit){mntBeginAudit(audit,audit.getAttribute("data-mnt-audit-receipt"));return;}
      var dispositionOpen=event.target.closest?event.target.closest("[data-mnt-disposition-open]"):null;
      if(dispositionOpen){mntOpenDispositionConfirm(dispositionOpen);return;}
      var dispositionCancel=event.target.closest?event.target.closest("[data-mnt-disposition-cancel]"):null;
      if(dispositionCancel){
        var box=dispositionCancel.closest(".mnt-disposition-confirm");
        if(box){box.hidden=true;box.innerHTML="";}
        return;
      }
      var dispositionConfirm=event.target.closest?event.target.closest("[data-mnt-disposition-confirm]"):null;
      if(dispositionConfirm){mntConfirmDisposition(dispositionConfirm);return;}
    });
  }

  function mntWireGuidancePanel(){
    var lanes=document.getElementById("mnt-lanes");
    if(lanes)lanes.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-mnt-lane]"):null;
      if(button)mntSetLane(button.getAttribute("data-mnt-lane"));
    });
    var kind=document.getElementById("mnt-guidance-kind");
    if(kind)kind.addEventListener("change",renderMntGuidance);
    var list=document.getElementById("mnt-guidance-list");
    if(list)mntWireGuidanceActions(list);
    var procedure=document.getElementById("mnt-procedure");
    if(procedure)procedure.addEventListener("click",function(event){
      var close=event.target.closest?event.target.closest("#mnt-procedure-close"):null;
      if(close){procedure.hidden=true;procedure.innerHTML="";}
      var copy=event.target.closest?event.target.closest("#mnt-procedure-copy"):null;
      if(copy&&MNT.procedure&&navigator.clipboard){
        navigator.clipboard.writeText(MNT.procedure.data.command.text).then(function(){
          mntAnnounce("Command copied.");
        }).catch(function(){});
      }
      var checkbox=event.target.closest?event.target.closest("[data-mnt-checklist-step]"):null;
      if(checkbox&&MNT.procedure){
        mntPost("/api/maintenance/v2/procedures/checklist",{
          guidanceId:MNT.procedure.guidanceId,stepId:checkbox.getAttribute("data-mnt-checklist-step"),
          done:checkbox.checked,
        }).catch(function(){});
      }
    });
    var dialog=mntAuditDialogEl();
    if(dialog){
      var close=document.getElementById("mnt-audit-close");
      if(close)close.addEventListener("click",mntCloseAuditDialog);
      dialog.addEventListener("close",function(){mntAuditState=null;});
      dialog.addEventListener("click",function(event){
        var record=event.target.closest?event.target.closest("[data-mnt-reconcile-receipt]"):null;
        if(record){
          mntCloseAuditDialog();
          beginMaintReconcile(record,{
            receiptId:record.getAttribute("data-mnt-reconcile-receipt"),
            outcome:record.getAttribute("data-mnt-reconcile-outcome"),
          });
        }
      });
    }
  }

  export function wireMntGuidance(){
    if(mntGuidanceWired)return;mntGuidanceWired=true;
    mntWireGuidancePanel();
  }

  // See maintenance-inventory.mjs's matching comment: registered immediately
  // so a lazy load can fire before boot.mjs's explicit wireMaintenance() runs.
  mntRegisterDestination("guidance",loadMntGuidance,renderMntGuidance);
