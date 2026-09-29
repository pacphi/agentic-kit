// @ts-nocheck — browser bundle source, assembled by ../client.mjs.
import { authHeaders } from './bootstrap.mjs';
import { reloadView } from './poll.mjs';
import { mntRefreshActiveDestination } from './maintenance-workspace.mjs';

var refreshBusy=false,refreshStartedAt=0,refreshRenderedBusy=null;
export function refreshRunning(){return refreshBusy;}
function refreshText(state){
  var stages=state&&state.stages||[];
  var active=stages.find(function(stage){return stage.state==='running';});
  var latest=active||stages[stages.length-1];
  var elapsed=Math.max(0,Math.floor((Date.now()-refreshStartedAt)/1000));
  if(state&&state.running)return (latest&&latest.label||'Preparing refresh')+' · '+elapsed+'s';
  return state&&state.ok?'Refresh complete.':state?'Refresh did not complete.':'';
}
function renderRefresh(state){
  var button=document.getElementById('refresh-run'),status=document.getElementById('refresh-status');
  if(button)button.disabled=refreshBusy;
  if(status)status.textContent=refreshText(state);
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
  fetch('/api/refresh',{cache:'no-store',headers:authHeaders()}).then(function(response){return response.json();})
    .then(function(state){
      if(!refreshBusy)return;
      if(state.running){renderRefresh(state);setTimeout(refreshPoll,1500);return;}
      refreshBusy=false;renderRefresh(state);reloadView(true);
    }).catch(function(){
      refreshBusy=false;renderRefresh(null);
      var status=document.getElementById('refresh-status');if(status)status.textContent='Refresh status could not be read.';
    });
}
export function startRefresh(strength,options){
  if(refreshBusy)return Promise.resolve(false);
  refreshBusy=true;refreshStartedAt=Date.now();renderRefresh({running:true,stages:[]});
  var body={strength:strength||'local'};
  if(strength==='machine'&&options&&options.projectTrees)body.projectTrees=true;
  return fetch('/api/refresh',{method:'POST',headers:Object.assign({'content-type':'application/json'},authHeaders()),body:JSON.stringify(body)})
    .then(function(response){return response.json().then(function(state){return {response:response,state:state};});})
    .then(function(result){
      if(!result.response.ok)throw new Error(result.state.error||'Refresh could not start.');
      renderRefresh(result.state.state);setTimeout(refreshPoll,1500);return true;
    }).catch(function(error){
      refreshBusy=false;renderRefresh(null);
      var status=document.getElementById('refresh-status');if(status)status.textContent=error.message;
      return false;
    });
}
export function wireRefresh(){
  var strength=document.getElementById('refresh-strength'),trees=document.getElementById('refresh-project-trees');
  if(strength&&trees)strength.addEventListener('change',function(){trees.disabled=strength.value!=='machine';if(trees.disabled)trees.checked=false;});
  var button=document.getElementById('refresh-run');
  if(button)button.addEventListener('click',function(){startRefresh(strength&&strength.value||'local',{projectTrees:!!(trees&&trees.checked)});});
}
