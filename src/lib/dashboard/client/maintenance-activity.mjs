// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 Activity destination (MNT-RCV-011/012). Six groups: recovery to
// finish, in-progress reads/writes, change receipts with eligible undo,
// dispositions, recipe changes, and scan records. Receipts open a detail
// sheet; export defaults to sanitized and "Include local paths" is a fresh,
// separately warned selection every time — never persisted.
import { mntWritesBlocked, mntOperationText } from './maintenance-operation.mjs';
import { esc } from './bootstrap.mjs';
import { MNT, MNT_AUDIT_ACTION_LABEL, mntAge, mntGet, mntKindLabel, mntPost, mntRegisterDestination } from './maintenance-workspace.mjs';
import { mntWireGuidanceActions } from './maintenance-guidance.mjs';
import { beginMaintUndo } from './system-maintenance-actions.mjs';

  var mntActivityWired=false,mntActivityBusy=false,mntActivityError=null;

  export function loadMntActivity(force){
    if(mntActivityBusy&&!force)return Promise.resolve();
    mntActivityBusy=true;mntActivityError=null;renderMntActivity();
    return mntGet("/api/maintenance/v2/activity").then(function(data){
      MNT.activity=data;mntActivityBusy=false;renderMntActivity();
    }).catch(function(error){
      mntActivityBusy=false;mntActivityError=error;renderMntActivity();
    });
  }

  function mntReceiptRow(entry){
    return '<li><button type="button" class="mnt-row" data-mnt-receipt="'+esc(entry.receiptId)+'">'
      +"<b>"+esc(entry.statusLabel)+"</b><span>"+esc(entry.summary)+"</span>"
      +(entry.updatedAt?"<small>"+esc(mntAge(entry.updatedAt))+"</small>":"")
      +"</button>"
      +(entry.eligibleUndo?'<button type="button" class="mt-action" data-mnt-undo-receipt="'+esc(entry.receiptId)+'"'
        +(mntWritesBlocked()?" disabled":"")+">Undo</button>":"")
      +'<button type="button" class="mt-action" data-mnt-export-receipt="'+esc(entry.receiptId)+'">Export</button></li>';
  }
  function mntRecoveryRow(entry){
    return "<li><b>"+esc(entry.statusLabel)+"</b><span>"+esc(entry.summary)+"</span>"
      +'<button type="button" class="mt-action primary" data-mnt-audit-receipt="'+esc(entry.receiptId)
      +'">'+esc(entry.primaryActionLabel||MNT_AUDIT_ACTION_LABEL)+"</button></li>";
  }
  function mntDispositionRow(entry){
    return "<li>"+esc(entry.kindLabel)+(entry.until?" until "+esc(mntAge(entry.until)):"")
      +(entry.invalidationReason?" — "+esc(entry.invalidationReason):"")+"</li>";
  }
  function mntRecipeRow(entry){
    return "<li>"+esc(entry.kind)+(entry.recipeId?" "+esc(entry.recipeId)+" v"+esc(entry.recipeVersion):"")
      +(entry.at?" — "+esc(mntAge(entry.at)):"")+"</li>";
  }
  function mntScanRow(entry){
    return "<li>"+esc(entry.label||"Discovery source")+" — "+esc(entry.state==="published"?"Complete":entry.state)
      +(entry.completedAt?" "+esc(mntAge(entry.completedAt)):"")+"</li>";
  }
  function mntGroupSection(title,items,renderer,emptyText){
    return "<section class=\"mnt-activity-group\"><h3>"+esc(title)+"</h3>"
      +(items&&items.length?"<ul>"+items.map(renderer).join("")+"</ul>":"<p>"+esc(emptyText)+"</p>")
      +"</section>";
  }

  export function renderMntActivity(){
    var el=document.getElementById("mnt-activity-groups");if(!el)return;
    if(mntActivityError){el.innerHTML="<p>Activity could not be read.</p>";return;}
    var data=MNT.activity||{};
    el.innerHTML=mntGroupSection("Recovery to finish",data.recovery,mntRecoveryRow,"Nothing needs recovery.")
      +mntGroupSection("In progress",(mntWritesBlocked()?[{label:mntOperationText(),activeMeasurement:true}]:[]).concat(data.inProgress||[]),function(entry){return (entry.activeMeasurement?'<li id="mnt-active-operation">':"<li>")+esc(entry.label||mntKindLabel(entry.kind))+"</li>";},"Nothing is in progress.")
      +mntGroupSection("Change receipts",data.receipts,mntReceiptRow,"No changes have been recorded.")
      +mntGroupSection("Dispositions",data.dispositions,mntDispositionRow,"No dispositions have been recorded.")
      +mntGroupSection("Recipe changes",data.recipes,mntRecipeRow,"No recipe changes yet.")
      +mntGroupSection("Scan records",data.scans,mntScanRow,"No scans have completed yet.");
  }

  // ── Receipt detail sheet ─────────────────────────────────────────────────
  function mntReceiptDialogEl(){return document.getElementById("mnt-receipt-dialog");}
  function mntRenderReceiptDetail(detail){
    var body=document.getElementById("mnt-receipt-body");
    if(!body)return;
    body.innerHTML="<dl class=\"mt-facts compact\">"
      +"<div><dt>Intent</dt><dd>"+esc(detail.intent)+"</dd></div>"
      +(detail.provider?"<div><dt>Provider</dt><dd>"+esc(detail.provider.id)+" v"+esc(detail.provider.version)+"</dd></div>":"")
      +"<div><dt>Result</dt><dd>"+esc(detail.result)+"</dd></div>"
      +(detail.rollback?"<div><dt>Rollback</dt><dd>"+esc(detail.rollback)+"</dd></div>":"")
      +"</dl>"
      +(detail.preserved&&detail.preserved.length?"<p><b>Preserved:</b> "+detail.preserved.map(esc).join(", ")+"</p>":"");
  }
  function mntOpenReceiptDialog(receiptId){
    var dialog=mntReceiptDialogEl();if(!dialog)return;
    if(typeof dialog.showModal==="function"&&!dialog.open)dialog.showModal();
    var body=document.getElementById("mnt-receipt-body");
    if(body)body.innerHTML="<p>Reading receipt…</p>";
    mntGet("/api/maintenance/v2/receipts/"+encodeURIComponent(receiptId)).then(mntRenderReceiptDetail).catch(function(){
      if(body)body.innerHTML="<p>This receipt could not be read.</p>";
    });
  }
  function mntCloseReceiptDialog(){
    var dialog=mntReceiptDialogEl();
    if(dialog&&dialog.open&&typeof dialog.close==="function")dialog.close();
  }

  // ── Export: sanitized default; "Include local paths" is a fresh selection
  // every time and is never remembered (MNT-RCV-012). ──
  function mntExportReceipt(receiptId){
    return mntPost("/api/maintenance/v2/receipts/export",{receiptId:receiptId,includeLocalPaths:false})
      .then(function(exported){
        var body=document.getElementById("mnt-receipt-body");
        var actions=document.getElementById("mnt-receipt-actions");
        var dialog=mntReceiptDialogEl();
        if(dialog&&typeof dialog.showModal==="function"&&!dialog.open)dialog.showModal();
        if(body)body.innerHTML="<pre>"+esc(JSON.stringify(exported,null,2))+"</pre>";
        if(actions){
          actions.innerHTML='<label><input type="checkbox" id="mnt-export-local-paths"> Include local paths</label>'
            +'<p class="mnt-warning" id="mnt-export-warning" hidden>Local paths reveal exact filesystem locations. This selection is not remembered and must be made again for every export.</p>'
            +'<button type="button" class="mt-action" id="mnt-export-again" data-mnt-export-receipt="'+esc(receiptId)+'">Export again</button>';
        }
      }).catch(function(){});
  }
  function mntExportReceiptWithPaths(receiptId){
    // MNT-RCV-012: includeLocalPaths:true requires acknowledgedWarning:true
    // in the SAME request, and this checkbox is never remembered — every
    // export starts from the sanitized default again.
    return mntPost("/api/maintenance/v2/receipts/export",{receiptId:receiptId,includeLocalPaths:true,acknowledgedWarning:true})
      .then(function(exported){
        var body=document.getElementById("mnt-receipt-body");
        if(body)body.innerHTML="<pre>"+esc(JSON.stringify(exported,null,2))+"</pre>";
      }).catch(function(){});
  }

  export function wireMntActivity(){
    if(mntActivityWired)return;mntActivityWired=true;
    var el=document.getElementById("mnt-activity-groups");
    if(el){
      mntWireGuidanceActions(el);
      el.addEventListener("click",function(event){
        var row=event.target.closest?event.target.closest("[data-mnt-receipt]"):null;
        if(row){mntOpenReceiptDialog(row.getAttribute("data-mnt-receipt"));return;}
        var undo=event.target.closest?event.target.closest("[data-mnt-undo-receipt]"):null;
        if(undo){beginMaintUndo(undo,{receiptId:undo.getAttribute("data-mnt-undo-receipt")});return;}
        var exportBtn=event.target.closest?event.target.closest("[data-mnt-export-receipt]"):null;
        if(exportBtn)mntExportReceipt(exportBtn.getAttribute("data-mnt-export-receipt"));
      });
    }
    var dialog=mntReceiptDialogEl();
    if(dialog){
      var close=document.getElementById("mnt-receipt-close");
      if(close)close.addEventListener("click",mntCloseReceiptDialog);
      var actions=document.getElementById("mnt-receipt-actions");
      if(actions){
        actions.addEventListener("click",function(event){
          var again=event.target.closest?event.target.closest("#mnt-export-again"):null;
          if(!again)return;
          var checkbox=document.getElementById("mnt-export-local-paths");
          var receiptId=again.getAttribute("data-mnt-export-receipt");
          if(checkbox&&checkbox.checked)mntExportReceiptWithPaths(receiptId);
          else mntExportReceipt(receiptId);
        });
        actions.addEventListener("change",function(event){
          if(!event.target||event.target.id!=="mnt-export-local-paths")return;
          var warning=document.getElementById("mnt-export-warning");
          if(warning)warning.hidden=!event.target.checked;
        });
      }
    }
  }

  // See maintenance-inventory.mjs's matching comment: registered immediately
  // so a lazy load can fire before boot.mjs's explicit wireMaintenance() runs.
  mntRegisterDestination("activity",loadMntActivity,renderMntActivity);
