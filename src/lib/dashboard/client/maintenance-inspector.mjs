// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 Resource inspector (MNT-UX-003/004/011, MNT-PRV-005). Desktop opens
// details below the list without losing the selected result; every screen also supports
// the "Back to N results" affordance that returns focus to the originating
// row. The exact path is revealed only via an explicit click on the
// owner-protected reveal endpoint, and is never copied automatically.
import { formatLocalDateTimeLong } from './datetime.mjs';
import { mntRenderRelationships } from './maintenance-relationships.mjs';
import { mntIcon } from './maintenance-cards.mjs';
import { esc } from './bootstrap.mjs';
import {
  MNT, MNT_CONFLICT_EXPLANATIONS, mntGet, mntKindLabel, mntPost, mntPushEscapable, mntPopEscapable,
  mntSyncHash,
} from './maintenance-workspace.mjs';
import { mntRenderGuidanceEntry, mntWireGuidanceActions } from './maintenance-guidance.mjs';

  var mntInspectorBusy=false,mntInspectorError=null,mntInspectorOriginPlc=null,mntInspectorWired=false;
  var mntRevealed=null,mntInspectorSeq=0,mntRevealError=null,mntRelatedTrail=[],mntRelatedOutside=false;
  function mntInspectorCloseButton(){return '<div class="mnt-inspector-toolbar"><span>Details</span><button type="button" class="mnt-icon-button" id="mnt-inspector-back" aria-label="Close details">'+mntIcon("close")+'</button></div>';}
  function mntMarkSelection(){document.querySelectorAll("[data-mnt-plc]").forEach(function(row){var on=row.getAttribute("data-mnt-plc")===MNT.plc;row.classList.toggle("selected",on);row.setAttribute("aria-expanded",String(on));});}

  function mntInspectorEl(){return document.getElementById("mnt-inspector");}

  export function mntCloseInspector(){
    var el=mntInspectorEl();if(!el||el.hidden)return;
    mntInspectorSeq++;mntInspectorBusy=false;
    el.hidden=true;el.innerHTML="";
    mntPopEscapable(mntCloseInspector);
    MNT.plc=null;MNT.inspector=null;mntRevealed=null;mntRelatedTrail=[];mntRelatedOutside=false;mntMarkSelection();
    mntSyncHash();
    var origin=mntInspectorOriginPlc;
    mntInspectorOriginPlc=null;
    if(origin){
      var row=document.querySelector('[data-mnt-plc="'+origin+'"]');
      if(row)row.focus();
    }
  }

  function mntWhereDidItComeFrom(section){
    if(!section)return "";
    return '<section class="mnt-q"><h4>Where did it come from?</h4><p>'+esc(section.label||section.kind)
      +" · "+esc(section.authority)+"</p></section>";
  }

  function mntWhatVersion(versions){
    var versionLabels={installed:'Installed version',producer:'Parent plugin version',providedBy:'Provided by',candidate:'Available release',cacheGeneration:'Cache generation',installedStatus:'Installed version',updateStatus:'Update check',source:'Update source',checkedAt:'Update check attempted',measuredAt:'Version measured',compatibility:'Compatibility'};
    var keys=Object.keys(versions||{}).filter(function(key){return key!=="contentDigest";});
    if(!keys.length)return "";
    return '<section class="mnt-q"><h4>What version is here?</h4><dl class="mt-facts compact">'
      +keys.map(function(key){return "<div><dt>"+esc(versionLabels[key]||mntKindLabel(key)||key)+"</dt><dd>"+esc(key==='checkedAt'||key==='measuredAt' ? (formatLocalDateTimeLong(versions[key])||'Not recorded') : versions[key])+"</dd></div>";}).join("")
      +"</dl></section>";
  }

  function mntWhoUses(whoUsesIt){
    whoUsesIt=whoUsesIt||{};
    var consumers=(whoUsesIt.consumers||[]).map(function(c){
      return "<li>"+esc(c.consumerLabel)+" ("+esc(c.consumerKind)+(c.enabled===false?", disabled":"")+")</li>";
    }).join("");
    var reverse=(whoUsesIt.reverseDependencies||[]).map(function(edge){
      return "<li>"+esc(mntKindLabel(edge.kind)||edge.kind)+" from another exact placement</li>";
    }).join("");
    if(!consumers&&!reverse)return "";
    return '<section class="mnt-q"><h4>Who uses it?</h4>'
      +(consumers?"<ul>"+consumers+"</ul>":"")
      +(reverse?'<b>Depended on by</b><ul class="mnt-dep-graph">'+reverse+"</ul>":"")
      +"</section>";
  }

  function mntConflicts(list){
    if(!list||!list.length)return "";
    return '<section class="mnt-q"><h4>What changed or conflicts?</h4><ul class="mnt-conflicts">'
      +list.map(function(entry){
        var label=entry.label||(MNT_CONFLICT_EXPLANATIONS[entry.kind]&&MNT_CONFLICT_EXPLANATIONS[entry.kind].label);
        return "<li><b>"+esc(label)+"</b><p>"+esc(entry.proves)+"</p><p>"+esc(entry.doesNotProve)+"</p></li>";
      }).join("")+"</ul></section>";
  }

  function mntWhatCanIAccomplish(entries,resourceKind){
    if(!entries||entries.detail){
      return '<section class="mnt-q"><h4>What can I accomplish?</h4><p class="mnt-no-action">'
        +esc((entries&&entries.detail)||"")+"</p></section>";
    }
    var recommendations=entries.filter(function(entry){return entry.purpose!=='optional-management';});
    var optional=entries.filter(function(entry){return entry.purpose==='optional-management';});
    return (recommendations.length?'<section class="mnt-q"><h4>Guidance</h4>'+recommendations.map(function(entry){return mntRenderGuidanceEntry(entry,resourceKind);}).join('')+'</section>':'')
      +(optional.length?'<section class="mnt-q"><h4>Optional actions</h4><p>These actions are available if you choose to manage this resource; their availability is not a recommendation to change it.</p>'+optional.map(function(entry){return mntRenderGuidanceEntry(entry,resourceKind);}).join('')+'</section>':'');
  }

  function mntEvidence(scorecard,technicalDetails){
    var rows=Object.keys(scorecard||{}).map(function(field){
      return "<div><dt>"+esc(mntKindLabel(field)||field)+"</dt><dd>"+esc(scorecard[field])+"</dd></div>";
    }).join("");
    var details=(technicalDetails||[]).map(function(t){return "<li>"+esc(t)+"</li>";}).join("");
    return '<details class="mnt-q"><summary>Evidence</summary>'
      +(rows?'<dl class="mt-facts compact">'+rows+"</dl>":"")
      +(details?"<details><summary>Technical details</summary><ul>"+details+"</ul></details>":"")
      +"</details>";
  }

  function mntHistory(history){
    history=history||{};
    var receipts=(history.receipts||[]).map(function(r){return "<li>"+esc(r.status)+"</li>";}).join("");
    var dispositions=(history.dispositions||[]).map(function(d){return "<li>"+esc(d.kind)+"</li>";}).join("");
    var coverage=(history.coverage||[]).map(function(c){return "<li>"+esc(c.label)+" — "+esc(c.state)+"</li>";}).join("");
    if(!receipts&&!dispositions&&!coverage)return "";
    return '<section class="mnt-q"><h4>What happened before?</h4>'
      +(receipts?"<b>Receipts</b><ul>"+receipts+"</ul>":"")
      +(dispositions?"<b>Dispositions</b><ul>"+dispositions+"</ul>":"")
      +(coverage?"<b>Scan coverage</b><ul>"+coverage+"</ul>":"")+"</section>";
  }

  function mntRevealHtml(){
    if(!mntRevealed)return (mntRevealError?'<p role="status">'+esc(mntRevealError)+'</p>':'')+'<button type="button" class="mt-action" id="mnt-reveal">Reveal exact path</button>';
    return '<div class="mnt-revealed"><code>'+esc(mntRevealed.exactPath)+"</code>"
      +'<button type="button" class="mt-action" id="mnt-copy-path" data-copy-state="idle">Copy exact path</button>'
      +'<span id="mnt-copy-status" role="status" aria-live="polite" aria-atomic="true"></span></div>';
  }

  function mntWhereIsIt(inspector){
    var where=inspector.whereIsIt||{};
    return '<section class="mnt-q"><h4>Where is it?</h4>'
      +'<p><span aria-hidden="true">○</span> '+esc(mntKindLabel(where.scope)||where.scope)+" · "
      +(where.breadcrumb||[]).map(esc).join(" › ")+"</p>"
      +(where.carrier?"<p>"+esc(where.carrier.label||where.carrier.value)+"</p>":"")
      +(where.revealAvailable===false?'<p>'+esc(where.locationNote||'No local file path was measured for this resource.')+'</p>':'<div class="mnt-reveal">'+mntRevealHtml()+'</div>')+'</section>';
  }

  function renderMntInspector(){
    var el=mntInspectorEl();if(!el)return;
    if(mntInspectorBusy){el.hidden=false;el.innerHTML=mntInspectorCloseButton()+'<p class="mnt-loading">Reading placement…</p>';return;}
    if(MNT.inspector&&MNT.inspector.scanRequired){
      el.hidden=false;
      el.innerHTML=mntInspectorCloseButton()+'<p>No inventory has been built yet. '
        +"Use Refresh evidence, above, to build it.</p>";
      return;
    }
    if(mntInspectorError||!MNT.inspector){
      el.hidden=false;
      el.innerHTML=mntInspectorCloseButton()+'<p>This placement could not be read.</p>';
      return;
    }
    var inspector=MNT.inspector;
    var what=inspector.whatIsThis||{};
    el.hidden=false;
    el.innerHTML=mntInspectorCloseButton()
      +(mntRelatedTrail.length?'<p class="mnt-related-context">'+(mntRelatedOutside?'Related installation outside the current filters.':'Related installation.')+' Your inventory location and filters are unchanged.</p><button type="button" class="mt-action" id="mnt-related-back">Back to '+esc(mntRelatedTrail[mntRelatedTrail.length-1].name)+'</button>':'')
      +'<h3 id="mnt-inspector-title" tabindex="-1">'+esc(what.displayName)+"</h3>"
      +'<p class="mnt-inspector-kind">'+esc(what.kindLabel)+"</p>"
      +(what.conditionLabels&&what.conditionLabels.length
        ?'<ul class="mnt-conditions">'+what.conditionLabels.map(function(c){return "<li>"+esc(c)+"</li>";}).join("")+"</ul>":"")
      +mntWhereIsIt(inspector)
      +(inspector.relationships?'':mntWhereDidItComeFrom(inspector.whereDidItComeFrom))
      +(inspector.whatVersionIsHere&&Object.keys(inspector.whatVersionIsHere).length?'<details class="mnt-q"><summary>Version details</summary>'+mntWhatVersion(inspector.whatVersionIsHere)+'</details>':'')
      +(inspector.relationships?mntRenderRelationships(inspector.relationships):mntWhoUses(inspector.whoUsesIt))
      +mntConflicts(inspector.whatChangedOrConflicts)
      +mntWhatCanIAccomplish(inspector.whatCanIAccomplish,what.kind)
      +mntEvidence(inspector.whatProvesThis&&inspector.whatProvesThis.evidenceScorecard,
        (inspector.whatProvesThis&&inspector.whatProvesThis.technicalDetails||[]).concat(inspector.whatVersionIsHere&&inspector.whatVersionIsHere.contentDigest?['Content digest: '+inspector.whatVersionIsHere.contentDigest]:[]))
      +'<details class="mnt-q"><summary>History</summary>'+mntHistory(inspector.whatHappenedBefore)+'</details>';
    var title=document.getElementById("mnt-inspector-title");
    if(title)title.focus();
  }

  export function mntOpenInspector(placementId,originButton,related){
    if(!related){mntRelatedTrail=[];mntRelatedOutside=false;mntInspectorOriginPlc=originButton&&originButton.getAttribute?originButton.getAttribute("data-mnt-plc"):placementId;}
    MNT.plc=placementId;MNT.inspector=null;mntInspectorBusy=true;mntInspectorError=null;mntRevealed=null;mntRevealError=null;
    mntSyncHash();mntMarkSelection();
    renderMntInspector();
    mntPopEscapable(mntCloseInspector);mntPushEscapable(mntCloseInspector);
    var seq=++mntInspectorSeq;
    return mntGet("/api/maintenance/v2/placements/"+encodeURIComponent(placementId)).then(function(inspector){
      if(seq!==mntInspectorSeq)return;
      MNT.inspector=inspector;mntInspectorBusy=false;renderMntInspector();
    }).catch(function(error){
      if(seq!==mntInspectorSeq)return;
      mntInspectorBusy=false;mntInspectorError=error;renderMntInspector();
    });
  }

  function mntCopyToClipboard(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("clipboard unavailable"));
  }

  function mntBeginReveal(){
    if(!MNT.plc)return;
    var placementId=MNT.plc,seq=mntInspectorSeq;
    return mntPost("/api/maintenance/v2/placements/reveal",{placementId:placementId}).then(function(result){
      if(seq!==mntInspectorSeq||placementId!==MNT.plc)return;
      if(!result.exactPath)throw new Error("unavailable");
      mntRevealed=result;mntRevealError=null;renderMntInspector();
    }).catch(function(){
      if(seq!==mntInspectorSeq||placementId!==MNT.plc)return;
      mntRevealError="The exact path could not be revealed. Refresh evidence and try again.";renderMntInspector();
    });
  }

  export function wireMntInspector(){
    if(mntInspectorWired)return;mntInspectorWired=true;
    var el=mntInspectorEl();if(!el)return;
    el.addEventListener("click",function(event){
      var related=event.target.closest&&event.target.closest('[data-mnt-related]');
      if(related){mntRelatedTrail.push({id:MNT.plc,outside:mntRelatedOutside,name:MNT.inspector&&MNT.inspector.whatIsThis&&MNT.inspector.whatIsThis.displayName||'installation'});mntRelatedOutside=related.getAttribute('data-mnt-related-outside')==='true';mntOpenInspector(related.getAttribute('data-mnt-related'),null,true);return;}
      if(event.target.closest&&event.target.closest('#mnt-related-back')){var previous=mntRelatedTrail.pop();if(previous){mntRelatedOutside=previous.outside;mntOpenInspector(previous.id,null,true);}return;}
      var back=event.target.closest?event.target.closest("#mnt-inspector-back"):null;
      if(back){mntCloseInspector();return;}
      var reveal=event.target.closest?event.target.closest("#mnt-reveal"):null;
      if(reveal){mntBeginReveal();return;}
      var copy=event.target.closest?event.target.closest("#mnt-copy-path"):null;
      if(copy&&mntRevealed){
        mntCopyToClipboard(mntRevealed.exactPath).then(function(){
          copy.setAttribute("data-copy-state","copied");
          var status=document.getElementById("mnt-copy-status");
          if(status)status.textContent="Exact path copied.";
        }).catch(function(){
          copy.setAttribute("data-copy-state","failed");
          var status=document.getElementById("mnt-copy-status");
          if(status)status.textContent="Could not copy the exact path.";
        });
      }
    });
    mntWireGuidanceActions(el);
  }
