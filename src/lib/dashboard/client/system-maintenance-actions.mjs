// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 one-finding preview/confirm dialog (kept from the v1 Maintenance
// build; MNT-UX-012). Reused for THREE write flows that share one shape —
// preview → typed confirmation → one receipt: applying an exact placement's
// guidance (POST /v2/plans → /v2/apply), undoing an eligible receipt
// (POST /v2/undo, same body as v1), and reconciling an interrupted receipt's
// audited outcome (POST /v2/reconcile/preview → /v2/reconcile). Authorization
// is intentionally closure-local and short-lived — never add a persistence
// adapter, data attribute, query parameter, or debug renderer for it.
import { formatLocalDateTimeLong } from './datetime.mjs';
import { mntWritesBlocked } from './maintenance-operation.mjs';
import { authHeaders, esc } from './bootstrap.mjs';
import { mntAge, mntFact, mntRefreshActiveDestination, mntText, mntValue } from './maintenance-workspace.mjs';

  export var maintActionBusy=false;
  var maintOperation=null,maintCapability=null,maintReturnFocus=null;
  export function maintActionActive(){return !!maintOperation;}

  var MAINT_KIND_URL={
    apply:{preview:"/api/maintenance/v2/plans",commit:"/api/maintenance/v2/apply"},
    undo:{preview:"/api/maintenance/v2/undo",commit:"/api/maintenance/v2/undo"},
    reconcile:{preview:"/api/maintenance/v2/reconcile/preview",commit:"/api/maintenance/v2/reconcile"},
  };

  function maintPost(url,payload){
    var headers=authHeaders();headers["content-type"]="application/json";
    return fetch(url,{method:"POST",cache:"no-store",headers:headers,body:JSON.stringify(payload)}).then(function(response){
      return response.text().then(function(text){
        var body={};try{body=text?JSON.parse(text):{};}catch(error){body={};}
        if(response.ok&&(!body||body.ok!==false))return body;
        var requestError=new Error("maintenance request failed");
        requestError.code=mntText(body&&body.code)||mntText(body&&body.error&&body.error.code);
        requestError.status=response.status;requestError.effect=mntText(body&&body.effect);
        requestError.payload=body;throw requestError;
      });
    });
  }

  function maintDialogElements(){
    return {
      dialog:document.getElementById("sys-maint-confirm"),title:document.getElementById("sys-maint-confirm-title"),
      body:document.getElementById("sys-maint-confirm-body"),status:document.getElementById("sys-maint-confirm-status"),
      close:document.getElementById("sys-maint-confirm-close"),cancel:document.getElementById("sys-maint-confirm-cancel"),
      confirm:document.getElementById("sys-maint-confirm-apply"),
    };
  }
  function maintConfirmationItems(value){
    var values=Array.isArray(value)?value:value==null?[]:[value];
    return values.map(mntValue).filter(Boolean);
  }
  function maintConfirmationList(label,value,tone){
    var items=maintConfirmationItems(value);if(!items.length)return "";
    return '<section class="mt-confirm-list '+esc(tone||"")+'"><h3>'+esc(label)+"</h3><ul>"
      +items.map(function(item){return "<li>"+esc(item)+"</li>";}).join("")+"</ul></section>";
  }
  function maintExpiryText(plan){
    var raw=mntText(plan&&plan.expiresAt),at=Date.parse(raw);
    if(!Number.isFinite(at))return "This preview expires. Reopen it before confirming if its evidence changes.";
    return "Valid until "+(formatLocalDateTimeLong(at)||"time unknown")+". Reopen the preview if it expires or the evidence changes.";
  }
  function maintConfirmationHtml(operation){
    var confirmation=operation.confirmation&&typeof operation.confirmation==="object"?operation.confirmation:{};
    var phrase=mntText(confirmation.typedPhrase),restart=confirmation.restart;
    var facts="";
    facts+=mntFact("Restart",restart===true?"Required":restart===false?"Not required":restart);
    facts+=mntFact("Rollback",confirmation.rollback);
    return (mntText(confirmation.summary)?'<p class="mt-confirm-summary">'+esc(confirmation.summary)+"</p>":"")
      +maintConfirmationList("Will change",confirmation.willChange,"change")
      +maintConfirmationList("Will preserve",confirmation.preserved,"preserve")
      +(facts?'<dl class="mt-facts compact mt-confirm-facts">'+facts+"</dl>":"")
      +(operation.kind==="apply"?'<p class="mt-expiry">'+esc(maintExpiryText(operation.plan))+"</p>":"")
      +(phrase?'<label class="mt-typed" for="sys-maint-typed"><span>Type this phrase to continue</span><code>'
        +esc(phrase)+'</code><input id="sys-maint-typed" autocomplete="off" spellcheck="false" data-maint-typed></label>':"");
  }
  function maintReceiptResultHtml(operation){
    var receipt=operation.receipt||{};
    return '<p class="mt-confirm-summary">'+esc(mntText(receipt.summary)||"The change was recorded.")+"</p>"
      +'<dl class="mt-facts compact mt-confirm-facts">'+mntFact("Receipt",mntText(receipt.receiptId||receipt.id))
      +mntFact("Status",receipt.status)+mntFact("Updated",receipt.updatedAt?mntAge(receipt.updatedAt):"")
      +mntFact("Verification",receipt.verification)+"</dl>"
      +'<p class="mt-expiry">This receipt remains available under Activity.</p>';
  }
  function maintRecoveryCopy(effect){
    if(effect==="rolled-back")return {
      title:"Change rolled back",
      message:"The provider attempted this change, and Agentic Kit reports that the recorded pre-change state was restored. Review the retained receipt before trying again.",
    };
    return {
      title:"Recovery required",
      message:"The provider may have changed this resource, but completion or recovery was not verified. Inspect the retained receipt before trying another change.",
    };
  }
  function maintActionErrorCopy(error,operation){
    var code=mntText(error&&error.code).toUpperCase(),status=Number(error&&error.status);
    var effect=mntText(error&&error.effect);
    if(code==="MAINTENANCE_SCAN_IN_PROGRESS"||code==="SYSTEM_SCAN_IN_PROGRESS")return {
      title:code==="SYSTEM_SCAN_IN_PROGRESS"?"Full scan in progress":"Provider check in progress",
      message:"The server did not start this change. Wait for current evidence to finish, then preview this row again.",
      status:"The server verified that no mutation started.",
    };
    if(operation&&operation.state==="loading"){
      if(/DRIFT|STALE|MISMATCH/.test(code))return {
        title:"Evidence changed",message:"The current evidence changed while the preview was being prepared. No change was requested. Close this sheet and preview current evidence again.",
        status:"The preview did not authorize a change.",
      };
      return {
        title:"Preview unavailable",message:"The preview could not be prepared. No change was requested. Close this sheet and try again.",
        status:"The preview did not authorize a change.",
      };
    }
    if(effect==="not-requested")return {
      title:"Preview expired",message:"This preview expired before a maintenance request was sent. No change was requested. Close this sheet and preview again.",
      status:"The expired preview was not submitted.",
    };
    if(effect==="not-started"){
      if(status===410||/EXPIRED/.test(code))return {
        title:"Preview expired",message:"The server refused this request before starting a maintenance change. Nothing changed. Close this sheet and preview again.",
        status:"The server verified that no mutation started.",
      };
      if(/DRIFT|STALE|MISMATCH/.test(code))return {
        title:"Evidence changed",message:"The server refused this request before starting a maintenance change because the evidence changed. Nothing changed. Preview current evidence again.",
        status:"The server verified that no mutation started.",
      };
      return {
        title:"Change refused",message:"The server refused this request before starting a maintenance change. Nothing changed. Close this sheet and preview again.",
        status:"The server verified that no mutation started.",
      };
    }
    return {
      title:"Outcome needs verification",
      message:"The request did not complete with a verified outcome. Do not assume the resource is unchanged. Refresh Activity and inspect its receipt before trying again.",
      status:"The outcome is not verified.",
    };
  }
  function maintRecoveryHtml(operation){
    var receipt=operation.receipt||{};
    return '<div class="mt-confirm-error" role="alert">'+esc(operation.error.message)+"</div>"
      +'<dl class="mt-facts compact mt-confirm-facts">'+mntFact("Receipt",mntText(receipt.receiptId||receipt.id))
      +mntFact("Status",receipt.status)+mntFact("Verification",receipt.verification)+"</dl>"
      +'<p class="mt-expiry">This receipt remains available under Activity.</p>';
  }
  function updateMaintConfirmEnabled(){
    var elements=maintDialogElements(),operation=maintOperation;if(!elements.confirm||!operation)return;
    if(operation.state!=="confirm"){elements.confirm.disabled=maintActionBusy;return;}
    var phrase=mntText(operation.confirmation&&operation.confirmation.typedPhrase);
    var input=document.getElementById("sys-maint-typed");
    elements.confirm.disabled=maintActionBusy||!!phrase&&(!input||input.value!==phrase);
  }
  var MAINT_TITLE_BY_KIND={apply:"Confirm maintenance change",undo:"Confirm undo",reconcile:"Confirm reconciliation"};
  var MAINT_LABEL_BY_KIND={apply:"Apply change",undo:"Undo change",reconcile:"Record outcome"};
  function renderMaintDialog(){
    var elements=maintDialogElements(),operation=maintOperation;
    if(!elements.dialog||!operation)return;
    elements.dialog.setAttribute("aria-busy",maintActionBusy?"true":"false");
    elements.close.disabled=maintActionBusy;
    if(operation.state==="loading"){
      elements.title.textContent="Preparing preview";
      elements.body.innerHTML='<p class="mt-confirm-summary">Checking current evidence and requesting short-lived authorization.</p>';
      elements.status.textContent="Preparing preview. No change has run.";
      elements.cancel.hidden=false;elements.cancel.disabled=maintActionBusy;elements.confirm.hidden=true;
    }else if(operation.state==="confirm"){
      var confirmation=operation.confirmation||{};
      elements.title.textContent=mntText(confirmation.title)||MAINT_TITLE_BY_KIND[operation.kind]||"Confirm change";
      elements.body.innerHTML=maintConfirmationHtml(operation);
      elements.status.textContent=maintActionBusy?"Applying change. Keep this window open.":"Preview ready. Review what changes and what remains.";
      elements.cancel.hidden=false;elements.cancel.disabled=maintActionBusy;elements.confirm.hidden=false;
      elements.confirm.textContent=mntText(confirmation.actionLabel)||MAINT_LABEL_BY_KIND[operation.kind]||"Confirm";
    }else if(operation.state==="receipt"){
      elements.title.textContent="Change recorded";
      elements.body.innerHTML=maintReceiptResultHtml(operation);
      elements.status.textContent="The operation completed and its receipt was retained.";
      elements.cancel.hidden=true;elements.confirm.hidden=false;elements.confirm.textContent="Done";
    }else if(operation.state==="recovery"){
      elements.title.textContent=operation.error.title;
      elements.body.innerHTML=maintRecoveryHtml(operation);
      elements.status.textContent="The operation did not complete safely. Its receipt was retained under Activity.";
      elements.cancel.hidden=true;elements.confirm.hidden=false;elements.confirm.textContent="Review receipt";
    }else{
      elements.title.textContent=operation.error.title;
      elements.body.innerHTML='<div class="mt-confirm-error" role="alert">'+esc(operation.error.message)+"</div>";
      elements.status.textContent=operation.error.status||"The outcome is not verified.";
      elements.cancel.hidden=true;elements.confirm.hidden=false;elements.confirm.textContent="Close";
    }
    updateMaintConfirmEnabled();
  }
  function openMaintDialog(trigger,operation){
    var elements=maintDialogElements();if(!elements.dialog)return;
    maintReturnFocus=trigger||document.activeElement;maintOperation=operation;maintCapability=null;
    renderMaintDialog();
    if(!elements.dialog.open){
      if(typeof elements.dialog.showModal==="function")elements.dialog.showModal();else elements.dialog.setAttribute("open","");
    }
  }
  function closeMaintDialog(){
    var dialog=maintDialogElements().dialog;if(!dialog||maintActionBusy)return;
    if(typeof dialog.close==="function"&&dialog.open)dialog.close();else{dialog.removeAttribute("open");maintDialogClosed();}
  }
  function maintDialogClosed(){
    maintCapability=null;maintOperation=null;
    var target=maintReturnFocus&&maintReturnFocus.isConnected?maintReturnFocus
      :document.querySelector('[data-mnt-dest="inventory"]');
    maintReturnFocus=null;if(target)setTimeout(function(){target.focus();},0);
  }
  function setMaintRootBusy(value){
    var root=document.getElementById("sys-maintenance");if(root)root.setAttribute("aria-busy",value?"true":"false");
  }
  function maintActionFailed(error){
    var previous=maintOperation||{},payload=error&&error.payload&&typeof error.payload==="object"?error.payload:{};
    var returned=payload.receipt&&typeof payload.receipt==="object"?payload.receipt:null;
    var effect=mntText(error&&error.effect),copy=returned?maintRecoveryCopy(effect):maintActionErrorCopy(error,previous);
    maintActionBusy=false;maintCapability=null;
    if(returned){
      var receipt=Object.assign({},returned);
      if(!mntText(receipt.status))receipt.status=mntText(payload.status)||"recovery-required";
      maintOperation={state:"recovery",kind:previous.kind,receipt:receipt,error:copy};
      mntRefreshActiveDestination();
    }else maintOperation={state:"error",error:copy};
    setMaintRootBusy(false);renderMaintDialog();
  }
  function maintPlanBody(target){return {placementId:target.placementId,guidanceId:target.guidanceId};}
  function maintUndoPreviewBody(target){return {receiptId:target.receiptId,preview:true};}
  function maintReconcilePreviewBody(target){return {receiptId:target.receiptId,outcome:target.outcome};}
  var MAINT_PREVIEW_BODY={apply:maintPlanBody,undo:maintUndoPreviewBody,reconcile:maintReconcilePreviewBody};

  /** Shared preview entry point for all three kinds. `target` carries the
   *  exact identifiers the preview route needs (never a batch — ONE
   *  placement, ONE receipt). */
  function beginMaintOperation(kind,trigger,target){
    // MNT-DSC-010: an executable provider check disables every write while
    // it runs, the same way an in-progress apply/undo already refuses a
    // second concurrent one.
    if(maintActionBusy||mntWritesBlocked())return;
    maintActionBusy=true;
    openMaintDialog(trigger,Object.assign({state:"loading",kind:kind},target));
    setMaintRootBusy(true);
    maintPost(MAINT_KIND_URL[kind].preview,MAINT_PREVIEW_BODY[kind](target)).then(function(response){
      if(!maintOperation||maintOperation.kind!==kind)return;
      if(response.capability==null||!response.confirmation)throw new Error("invalid preview");
      maintCapability=response.capability;maintActionBusy=false;
      maintOperation=Object.assign({state:"confirm",kind:kind},target,{plan:response.plan,confirmation:response.confirmation});
      setMaintRootBusy(false);renderMaintDialog();
      var input=document.getElementById("sys-maint-typed");if(input)input.focus();else maintDialogElements().confirm.focus();
    }).catch(maintActionFailed);
  }

  export function beginMaintPreview(trigger,target){beginMaintOperation("apply",trigger,target);}
  export function beginMaintUndo(trigger,target){beginMaintOperation("undo",trigger,target);}
  export function beginMaintReconcile(trigger,target){beginMaintOperation("reconcile",trigger,target);}

  function finishMaintAction(response){
    var receipt=response&&response.receipt;
    if(!response||response.ok!==true||!receipt||typeof receipt!=="object")throw new Error("invalid maintenance receipt");
    maintCapability=null;maintActionBusy=false;
    maintOperation={state:"receipt",kind:maintOperation.kind,receipt:receipt};
    mntRefreshActiveDestination();renderMaintDialog();maintDialogElements().confirm.focus();
  }
  function submitMaintAction(){
    var operation=maintOperation;if(maintActionBusy||!operation)return;
    if(operation.state==="receipt"||operation.state==="recovery"||operation.state==="error"){closeMaintDialog();return;}
    if(operation.state!=="confirm"||maintCapability==null)return;
    var phrase=mntText(operation.confirmation&&operation.confirmation.typedPhrase);
    var input=document.getElementById("sys-maint-typed");
    if(phrase&&(!input||input.value!==phrase)){updateMaintConfirmEnabled();return;}
    if(operation.kind==="apply"&&Number.isFinite(Date.parse(mntText(operation.plan&&operation.plan.expiresAt)))
      &&Date.parse(operation.plan.expiresAt)<=Date.now()){
      maintActionFailed({code:"PLAN_EXPIRED",status:410,effect:"not-requested"});return;
    }
    var capability=maintCapability;
    maintActionBusy=true;renderMaintDialog();setMaintRootBusy(true);
    var payload={capability:capability,confirm:true};if(phrase)payload.typedPhrase=phrase;
    maintPost(MAINT_KIND_URL[operation.kind].commit,payload).then(finishMaintAction).catch(maintActionFailed);
  }

  export function wireMaintActions(){
    var elements=maintDialogElements();
    if(elements.close)elements.close.addEventListener("click",closeMaintDialog);
    if(elements.cancel)elements.cancel.addEventListener("click",closeMaintDialog);
    if(elements.confirm)elements.confirm.addEventListener("click",submitMaintAction);
    if(elements.dialog){
      elements.dialog.addEventListener("input",function(event){if(event.target&&event.target.matches("[data-maint-typed]"))updateMaintConfirmEnabled();});
      elements.dialog.addEventListener("cancel",function(event){if(maintActionBusy)event.preventDefault();});
      elements.dialog.addEventListener("close",maintDialogClosed);
    }
  }
