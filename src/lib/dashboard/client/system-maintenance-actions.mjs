// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { authHeaders, esc } from './bootstrap.mjs';
import {
  maintAge, maintCanPreview, maintCanUndo, maintCurrentRecord, maintFact, maintReceiptId,
  maintReceiptPresentation, maintRememberReceipt, maintShowReceipt, maintText, maintValue, renderMaintenance,
} from './system-maintenance.mjs';

  // Authorization is intentionally closure-local and short-lived. Never add a
  // persistence adapter, data attribute, query parameter, or debug renderer for
  // this value: the provider capability belongs only to one confirmation flow.
  export var maintActionBusy=false;
  var maintOperation=null,maintCapability=null,maintReturnFocus=null;
  export function maintActionActive(){return !!maintOperation;}

  function maintPost(url,payload){
    var headers=authHeaders();headers["content-type"]="application/json";
    return fetch(url,{method:"POST",cache:"no-store",headers:headers,body:JSON.stringify(payload)}).then(function(response){
      return response.text().then(function(text){
        var body={};try{body=text?JSON.parse(text):{};}catch(error){body={};}
        if(response.ok&&(!body||body.ok!==false))return body;
        var requestError=new Error("maintenance request failed");
        requestError.code=maintText(body&&body.code)||maintText(body&&body.error&&body.error.code);
        requestError.status=response.status;requestError.effect=maintText(body&&body.effect);
        requestError.payload=body;throw requestError;
      });
    });
  }

  function maintDialogElements(){
    return {
      dialog:document.getElementById("sys-maint-confirm"),title:document.getElementById("sys-maint-confirm-title"),
      body:document.getElementById("sys-maint-confirm-body"),status:document.getElementById("sys-maint-confirm-status"),
      close:document.getElementById("sys-maint-confirm-close"),cancel:document.getElementById("sys-maint-confirm-cancel"),
      confirm:document.getElementById("sys-maint-confirm-apply")
    };
  }
  function maintConfirmationItems(value){
    var values=Array.isArray(value)?value:value==null?[]:[value];
    return values.map(maintValue).filter(Boolean);
  }
  function maintConfirmationList(label,value,tone){
    var items=maintConfirmationItems(value);if(!items.length)return "";
    return '<section class="mt-confirm-list '+esc(tone||"")+'"><h3>'+esc(label)+"</h3><ul>"
      +items.map(function(item){return "<li>"+esc(item)+"</li>";}).join("")+"</ul></section>";
  }
  function maintExpiryText(plan){
    var raw=maintText(plan&&plan.expiresAt),at=Date.parse(raw);
    if(!Number.isFinite(at))return "This preview expires. Reopen it before confirming if its evidence changes.";
    return "Valid until "+new Date(at).toLocaleString()+". Reopen the preview if it expires or the evidence changes.";
  }
  function maintConfirmationHtml(operation){
    var confirmation=operation.confirmation&&typeof operation.confirmation==="object"?operation.confirmation:{};
    var phrase=maintText(confirmation.typedPhrase),restart=confirmation.restart;
    var facts="";
    facts+=maintFact("Restart",restart===true?"Required":restart===false?"Not required":restart);
    facts+=maintFact("Rollback",confirmation.rollback);
    return (maintText(confirmation.summary)?'<p class="mt-confirm-summary">'+esc(confirmation.summary)+"</p>":"")
      +maintConfirmationList("Will change",confirmation.willChange,"change")
      +maintConfirmationList("Will preserve",confirmation.preserved,"preserve")
      +(facts?'<dl class="mt-facts compact mt-confirm-facts">'+facts+"</dl>":"")
      +(operation.kind==="apply"?'<p class="mt-expiry">'+esc(maintExpiryText(operation.plan))+"</p>":"")
      +(phrase?'<label class="mt-typed" for="sys-maint-typed"><span>Type this phrase to continue</span><code>'
        +esc(phrase)+'</code><input id="sys-maint-typed" autocomplete="off" spellcheck="false" data-maint-typed></label>':"");
  }
  function maintReceiptResultHtml(operation){
    var receipt=operation.receipt||{},state=maintReceiptPresentation(receipt);
    return '<p class="mt-confirm-summary">'+esc(state.summary)+"</p>"
      +'<dl class="mt-facts compact mt-confirm-facts">'+maintFact("Receipt",maintReceiptId(receipt))
      +maintFact("Status",state.label)+maintFact(state.timeLabel,maintAge(state.at))
      +maintFact("Verification",receipt.verification)+"</dl>"
      +'<p class="mt-expiry">This receipt remains available under Recent changes.</p>';
  }
  function maintRecoveryCopy(effect){
    if(effect==="rolled-back")return {
      title:"Change rolled back",
      message:"The provider attempted this change, and Agentic Kit reports that the recorded pre-change state was restored. Review the retained receipt before trying again."
    };
    return {
      title:"Recovery required",
      message:"The provider may have changed this resource, but completion or recovery was not verified. Inspect the retained receipt before trying another change."
    };
  }
  function maintActionErrorCopy(error,operation){
    var code=maintText(error&&error.code).toUpperCase(),status=Number(error&&error.status);
    var effect=maintText(error&&error.effect);
    if(operation&&operation.state==="loading"){
      if(/DRIFT|STALE|MISMATCH/.test(code))return {
        title:"Evidence changed",message:"The current evidence changed while the preview was being prepared. No change was requested. Close this sheet and preview current evidence again.",
        status:"The preview did not authorize a change."
      };
      return {
        title:"Preview unavailable",message:"The preview could not be prepared. No change was requested. Close this sheet and try again.",
        status:"The preview did not authorize a change."
      };
    }
    if(effect==="not-requested")return {
      title:"Preview expired",message:"This preview expired before a maintenance request was sent. No change was requested. Close this sheet and preview the finding again.",
      status:"The expired preview was not submitted."
    };
    if(effect==="not-started"){
      if(status===410||/EXPIRED/.test(code))return {
        title:"Preview expired",message:"The server refused this request before starting a maintenance change. Nothing changed. Close this sheet and preview the finding again.",
        status:"The server verified that no mutation started."
      };
      if(/DRIFT|STALE|MISMATCH/.test(code))return {
        title:"Evidence changed",message:"The server refused this request before starting a maintenance change because the evidence changed. Nothing changed. Preview current evidence again.",
        status:"The server verified that no mutation started."
      };
      return {
        title:"Change refused",message:"The server refused this request before starting a maintenance change. Nothing changed. Close this sheet and preview the finding again.",
        status:"The server verified that no mutation started."
      };
    }
    return {
      title:"Outcome needs verification",
      message:"The request did not complete with a verified outcome. Do not assume the resource is unchanged. Refresh Maintenance and inspect Recent changes before trying again.",
      status:"The outcome is not verified."
    };
  }
  function maintRecoveryHtml(operation){
    var receipt=operation.receipt||{},state=maintReceiptPresentation(receipt),summary=state.summary;
    return '<div class="mt-confirm-error" role="alert">'+esc(operation.error.message)+"</div>"
      +(summary&&summary!==operation.error.message?'<p class="mt-confirm-summary">'+esc(summary)+"</p>":"")
      +'<dl class="mt-facts compact mt-confirm-facts">'+maintFact("Receipt",maintReceiptId(receipt))
      +maintFact("Status",state.label)+maintFact(state.timeLabel,maintAge(state.at))
      +maintFact("Verification",receipt.verification)+"</dl>"
      +'<p class="mt-expiry">This receipt remains available under Recent changes.</p>';
  }
  function updateMaintConfirmEnabled(){
    var elements=maintDialogElements(),operation=maintOperation;if(!elements.confirm||!operation)return;
    if(operation.state!=="confirm"){elements.confirm.disabled=maintActionBusy;return;}
    var phrase=maintText(operation.confirmation&&operation.confirmation.typedPhrase);
    var input=document.getElementById("sys-maint-typed");
    elements.confirm.disabled=maintActionBusy||!!phrase&&(!input||input.value!==phrase);
  }
  function renderMaintDialog(){
    var elements=maintDialogElements(),operation=maintOperation;
    if(!elements.dialog||!operation)return;
    elements.dialog.setAttribute("aria-busy",maintActionBusy?"true":"false");
    elements.close.disabled=maintActionBusy;
    if(operation.state==="loading"){
      elements.title.textContent=operation.kind==="undo"?"Preparing undo preview":"Preparing change preview";
      elements.body.innerHTML='<p class="mt-confirm-summary">Checking current evidence and requesting short-lived authorization.</p>';
      elements.status.textContent="Preparing preview. No change has run.";
      elements.cancel.hidden=false;elements.cancel.disabled=maintActionBusy;elements.confirm.hidden=true;
    }else if(operation.state==="confirm"){
      var confirmation=operation.confirmation||{};
      elements.title.textContent=maintText(confirmation.title)||(operation.kind==="undo"?"Confirm undo":"Confirm maintenance change");
      elements.body.innerHTML=maintConfirmationHtml(operation);
      elements.status.textContent=maintActionBusy
        ?(operation.kind==="undo"?"Undoing change. Keep this window open.":"Applying change. Keep this window open.")
        :"Preview ready. Review what changes and what remains.";
      elements.cancel.hidden=false;elements.cancel.disabled=maintActionBusy;elements.confirm.hidden=false;
      elements.confirm.textContent=maintText(confirmation.actionLabel)||(operation.kind==="undo"?"Undo change":"Apply change");
    }else if(operation.state==="receipt"){
      elements.title.textContent=operation.kind==="undo-result"?"Undo recorded":"Change recorded";
      elements.body.innerHTML=maintReceiptResultHtml(operation);
      elements.status.textContent="The operation completed and its receipt was retained.";
      elements.cancel.hidden=true;elements.confirm.hidden=false;elements.confirm.textContent="Done";
    }else if(operation.state==="recovery"){
      elements.title.textContent=operation.error.title;
      elements.body.innerHTML=maintRecoveryHtml(operation);
      elements.status.textContent="The operation did not complete safely. Its receipt was retained under Recent changes.";
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
      :document.querySelector('#sys-maint-list [aria-current="true"]')||document.querySelector('[data-system-view="maintenance"]');
    maintReturnFocus=null;if(target)setTimeout(function(){target.focus();},0);
  }
  function setMaintRootBusy(value){
    var root=document.getElementById("sys-maintenance");if(root)root.setAttribute("aria-busy",value?"true":"false");
  }
  function maintActionFailed(error){
    var previous=maintOperation||{},payload=error&&error.payload&&typeof error.payload==="object"?error.payload:{};
    var returned=payload.receipt&&typeof payload.receipt==="object"?payload.receipt:null;
    var effect=maintText(error&&error.effect),copy=returned?maintRecoveryCopy(effect):maintActionErrorCopy(error,previous);
    maintActionBusy=false;maintCapability=null;
    if(returned){
      var receipt=Object.assign({},returned);
      if(!maintText(receipt.status))receipt.status=maintText(payload.status)||"recovery-required";
      if(!maintText(receipt.statusLabel))receipt.statusLabel=copy.title;
      if(!maintText(receipt.summary))receipt.summary=copy.message;
      var key=maintRememberReceipt(receipt);maintShowReceipt(key);
      maintOperation={state:"recovery",kind:previous.kind,receipt:receipt,error:copy};
      renderMaintenance();
    }else maintOperation={state:"error",error:copy};
    setMaintRootBusy(false);renderMaintDialog();
  }
  function beginMaintPreview(trigger){
    if(maintActionBusy)return;
    var record=maintCurrentRecord("finding");
    if(!record||!maintCanPreview(record.value))return;
    var findingId=maintText(record.value.id);if(!findingId)return;
    maintActionBusy=true;openMaintDialog(trigger,{state:"loading",kind:"apply",findingId:findingId});setMaintRootBusy(true);
    maintPost("/api/maintenance/plans",{findingIds:[findingId]}).then(function(response){
      if(!maintOperation||maintOperation.findingId!==findingId)return;
      if(response.capability==null||!response.confirmation||!response.plan)throw new Error("invalid preview");
      maintCapability=response.capability;maintActionBusy=false;
      maintOperation={state:"confirm",kind:"apply",findingId:findingId,plan:response.plan,confirmation:response.confirmation};
      setMaintRootBusy(false);renderMaintDialog();
      var input=document.getElementById("sys-maint-typed");if(input)input.focus();else maintDialogElements().confirm.focus();
    }).catch(maintActionFailed);
  }
  function beginMaintUndo(trigger){
    if(maintActionBusy)return;
    var record=maintCurrentRecord("receipt");
    if(!record||!maintCanUndo(record.value))return;
    var receiptId=maintReceiptId(record.value);if(!receiptId)return;
    maintActionBusy=true;openMaintDialog(trigger,{state:"loading",kind:"undo",receiptId:receiptId,originalReceipt:record.value});setMaintRootBusy(true);
    maintPost("/api/maintenance/undo",{receiptId:receiptId,preview:true}).then(function(response){
      if(!maintOperation||maintOperation.receiptId!==receiptId)return;
      if(response.capability==null||!response.confirmation)throw new Error("invalid undo preview");
      maintCapability=response.capability;maintActionBusy=false;
      maintOperation={state:"confirm",kind:"undo",receiptId:receiptId,originalReceipt:record.value,confirmation:response.confirmation};
      setMaintRootBusy(false);renderMaintDialog();maintDialogElements().confirm.focus();
    }).catch(maintActionFailed);
  }
  function finishMaintAction(kind,originalReceipt,response){
    var receipt=response&&response.receipt;
    if(!response||response.ok!==true||!receipt||typeof receipt!=="object")throw new Error("invalid maintenance receipt");
    if(originalReceipt){
      originalReceipt.undoEligible=false;
      if(originalReceipt.undo&&typeof originalReceipt.undo==="object")originalReceipt.undo.eligible=false;
    }
    var key=maintRememberReceipt(receipt);
    maintCapability=null;maintActionBusy=false;maintShowReceipt(key);
    maintOperation={state:"receipt",kind:kind==="undo"?"undo-result":"apply-result",receipt:receipt};
    renderMaintenance();renderMaintDialog();maintDialogElements().confirm.focus();
  }
  function submitMaintAction(){
    var operation=maintOperation;if(maintActionBusy||!operation)return;
    if(operation.state==="receipt"||operation.state==="recovery"||operation.state==="error"){closeMaintDialog();return;}
    if(operation.state!=="confirm"||maintCapability==null)return;
    var phrase=maintText(operation.confirmation&&operation.confirmation.typedPhrase);
    var input=document.getElementById("sys-maint-typed");
    if(phrase&&(!input||input.value!==phrase)){updateMaintConfirmEnabled();return;}
    if(operation.kind==="apply"&&Number.isFinite(Date.parse(maintText(operation.plan&&operation.plan.expiresAt)))
      &&Date.parse(operation.plan.expiresAt)<=Date.now()){
      maintActionFailed({code:"PLAN_EXPIRED",status:410,effect:"not-requested"});return;
    }
    var capability=maintCapability,kind=operation.kind,originalReceipt=operation.originalReceipt;
    maintActionBusy=true;renderMaintDialog();setMaintRootBusy(true);
    var url=kind==="undo"?"/api/maintenance/undo":"/api/maintenance/apply";
    var payload={capability:capability,confirm:true};if(phrase)payload.typedPhrase=phrase;
    maintPost(url,payload).then(function(response){finishMaintAction(kind,originalReceipt,response);}).catch(maintActionFailed);
  }


  export function wireMaintActions(root){
    if(root)root.addEventListener("click",function(event){
      var button=event.target.closest?event.target.closest("[data-maint-action]"):null;if(!button)return;
      if(button.getAttribute("data-maint-action")==="preview")beginMaintPreview(button);
      else if(button.getAttribute("data-maint-action")==="undo")beginMaintUndo(button);
    });
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
