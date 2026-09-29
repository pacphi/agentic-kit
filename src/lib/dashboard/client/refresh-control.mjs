// @ts-nocheck — browser bundle source, assembled by ../client.mjs.
import { authHeaders } from './bootstrap.mjs';
import { reloadView } from './poll.mjs';
import { mntRefreshActiveDestination } from './maintenance-workspace.mjs';

var refreshBusy=false,refreshStartedAt=0,refreshOperationId=null,refreshRequireNewer=true,refreshRenderedBusy=null;
export function refreshRunning(){return refreshBusy;}
function validRefreshState(state){
  return !!state&&typeof state.operationId==='string'&&state.operationId.length>0
    &&Number.isFinite(Date.parse(state.startedAt))
    &&typeof state.running==='boolean'&&Array.isArray(state.stages)
    &&(state.running||typeof state.ok==='boolean');
}
function refreshText(state){
  var stages=state&&state.stages||[];
  var active=stages.find(function(stage){return stage.state==='running';});
  var latest=active||stages[stages.length-1];
  var elapsed=Math.max(0,Math.floor((Date.now()-refreshStartedAt)/1000));
  if(state&&state.running)return (latest&&latest.label||'Preparing refresh')+' · '+elapsed+'s';
  return state&&state.ok?'Refresh complete.':state?'Refresh did not complete.':'';
}
function renderRefresh(state,message){
  var button=document.getElementById('refresh-run'),status=document.getElementById('refresh-status');
  if(button)button.disabled=refreshBusy;
  if(status)status.textContent=message||refreshText(state);
  document.querySelectorAll('[data-mnt-plan-plc], [data-mnt-undo-receipt], [data-mnt-reconcile-receipt]').forEach(function(action){
    if(refreshBusy){
      if(action.dataset.refreshWasDisabled===undefined)action.dataset.refreshWasDisabled=action.disabled?'1':'0';
      action.disabled=true;
    }else if(action.dataset.refreshWasDisabled!==undefined){
      action.disabled=action.dataset.refreshWasDisabled==='1';
      delete action.dataset.refreshWasDisabled;
    }
  });
  if(refreshRenderedBusy!==refreshBusy){refreshRenderedBusy=refreshBusy;if(refreshBusy)mntRefreshActiveDestination();}
}
function refreshPoll(){
  if(!refreshBusy)return;
  fetch('/api/refresh',{cache:'no-store',headers:authHeaders()}).then(function(response){
    if(!response.ok)throw new Error('Refresh status unavailable.');
    return response.json();
  }).then(function(state){
    if(!validRefreshState(state))throw new Error('Refresh status was incomplete.');
    if(refreshOperationId===null&&refreshRequireNewer&&Date.parse(state.startedAt)<refreshStartedAt)
      throw new Error('Refresh status predates the unconfirmed request.');
    return state;
  })
    .then(function(state){
      if(!refreshBusy)return;
      if(refreshOperationId!==null&&state.operationId===refreshOperationId){
        if(state.running){renderRefresh(state);setTimeout(refreshPoll,1500);return;}
        refreshBusy=false;renderRefresh(state);reloadView(true);return;
      }
      // The server exposes only its latest operation. A different identity
      // proves this page's operation ended, but cannot establish its outcome.
      // A missing POST response likewise cannot identify the observed run.
      if(state.running){
        renderRefresh(state,'Another refresh is running; this page’s outcome is unavailable.');
        setTimeout(refreshPoll,1500);return;
      }
      refreshBusy=false;
      renderRefresh(null,'Refresh outcome unavailable; the current operation has ended.');
      reloadView(true);
    }).catch(function(){
      if(!refreshBusy)return;
      var status=document.getElementById('refresh-status');if(status)status.textContent='Refresh status unavailable; retrying…';
      setTimeout(refreshPoll,1500);
    });
}
export function startRefresh(strength,options){
  if(refreshBusy)return Promise.resolve(false);
  refreshBusy=true;refreshStartedAt=Date.now();refreshOperationId=null;refreshRequireNewer=true;
  renderRefresh({running:true,stages:[]});
  var body={strength:strength||'local'};
  if(strength==='machine'&&options&&options.projectTrees)body.projectTrees=true;
  return fetch('/api/refresh',{method:'POST',headers:Object.assign({'content-type':'application/json'},authHeaders()),body:JSON.stringify(body)})
    .then(function(response){return response.json().catch(function(){return null;}).then(function(state){return {response:response,state:state};});})
    .then(function(result){
      if(!result.response.ok){
        if(result.response.status===409){
          refreshRequireNewer=false;
          renderRefresh(null,'Another refresh is running; this page’s outcome is unavailable.');
          setTimeout(refreshPoll,1500);
          return false;
        }
        refreshBusy=false;renderRefresh(null);
        var rejected=document.getElementById('refresh-status');
        if(rejected)rejected.textContent=result.state&&result.state.error||'Refresh could not start.';
        return false;
      }
      if(validRefreshState(result.state&&result.state.state)){
        refreshOperationId=result.state.state.operationId;
        renderRefresh(result.state.state);
      }
      else{var pending=document.getElementById('refresh-status');if(pending)pending.textContent='Checking refresh status…';}
      setTimeout(refreshPoll,1500);return true;
    }).catch(function(){
      // The POST may have reached the server before the network failed. Keep
      // writes blocked until a valid operation state establishes completion.
      var status=document.getElementById('refresh-status');
      if(status)status.textContent='Refresh request outcome unavailable; checking status…';
      setTimeout(refreshPoll,1500);return null;
    });
}
export function wireRefresh(){
  var strength=document.getElementById('refresh-strength'),trees=document.getElementById('refresh-project-trees');
  if(strength&&trees)strength.addEventListener('change',function(){trees.disabled=strength.value!=='machine';if(trees.disabled)trees.checked=false;});
  var button=document.getElementById('refresh-run');
  if(button)button.addEventListener('click',function(){startRefresh(strength&&strength.value||'local',{projectTrees:!!(trees&&trees.checked)});});
}
