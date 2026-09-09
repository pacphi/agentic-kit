// @ts-nocheck — dashboard browser bundle.
import { MNT, mntGet, mntRefreshActiveDestination } from './maintenance-workspace.mjs';
import { loadSystem } from './system-projects.mjs';
import { SYSTEM, systemBusy } from './system-readout.mjs';

var mntOperationTimer=null,mntOperationWired=false;
var MNT_SCAN_PHASES={install:'Reading installed tools',storage:'Measuring retained data',catalog:'Comparing skills, plugins, and MCP servers',projects:'Measuring projects',consumers:'Ranking disk use',persist:'Saving report'};
export function mntWritesBlocked(){return !!(MNT.providersBusy||MNT.remeasureBusy||MNT.externalScanBusy);}
export function mntOperationText(){return MNT.operation&&MNT.operation.message||'No measurement in progress.';}
function mntElapsed(started){
  var seconds=Math.max(0,Math.floor((Date.now()-started)/1000));
  return seconds<60?seconds+'s':Math.floor(seconds/60)+'m '+seconds%60+'s';
}
export function renderMntOperation(){
  var op=MNT.operation,busy=mntWritesBlocked();
  ['mnt-check-providers','mnt-remeasure'].forEach(function(id){var button=document.getElementById(id);if(button)button.disabled=busy;});
  var el=document.getElementById('mnt-check-providers-status');
  if(el){
    var message=op?op.message:'';
    // Timer is visual only; screen readers hear phase changes, not every tick.
    if(el.textContent!==message)el.textContent=message;
    el.dataset.state=busy?'running':op&&op.failed?'failed':'idle';
  }
  var clock=document.getElementById('mnt-operation-elapsed');
  if(clock){clock.hidden=!busy;clock.textContent=busy&&op?mntElapsed(op.startedAt):'';}
  var live=document.getElementById('mnt-active-operation');
  if(live){live.hidden=!busy;live.textContent=busy?mntOperationText():'';}
}
function mntSetOperation(message){
  if(!MNT.operation)MNT.operation={startedAt:Date.now()};
  MNT.operation.message=message;renderMntOperation();
}
function mntBeginOperation(kind){
  MNT.operation={kind:kind,startedAt:Date.now(),message:kind==='measure'?'Preparing measurement…':'Refreshing evidence…',failed:false};
  if(mntOperationTimer)clearInterval(mntOperationTimer);
  mntOperationTimer=setInterval(renderMntOperation,1000);
  renderMntOperation();mntRefreshActiveDestination();
}
function mntSetMeasurement(scan){
  var phase=MNT_SCAN_PHASES[scan.phase]||'Preparing measurement';
  mntSetOperation(phase+(scan.total?' · '+scan.scanned+' of '+scan.total:''));
}
function mntDelay(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
function mntPollSystemMeasurement(){
  return mntGet('/api/system').then(function(data){
    if(!data||data.error||!data.scan)throw new Error('The measurement status could not be read.');
    if(data.scan.running){mntSetMeasurement(data.scan);return mntDelay(3000).then(mntPollSystemMeasurement);}
    if(data.scan.error)throw new Error('The measurement reported a problem.');
    mntSetOperation('Machine measured · refreshing evidence…');
  });
}
export function mntBuildStatusOf(page){
  var refresh=page&&page.lastRefresh;
  if(refresh&&(refresh.status==='running'||refresh.status==='failed'))return refresh.status;
  return page&&page.scanRequired===false?'ok':refresh&&refresh.status||'pending';
}
export function mntAwaitInventoryBuild(previousAt){
  var started=Date.now();mntSetOperation('Updating inventory and source coverage…');
  function tick(){
    return mntGet('/api/maintenance/v2/inventory?limit=1').then(function(page){
      var status=mntBuildStatusOf(page),at=page.lastRefresh&&page.lastRefresh.at;
      var fresh=previousAt===undefined||at!==previousAt;
      if(fresh&&status==='failed')throw new Error('The inventory update failed.');
      if(fresh&&status==='ok'){
        MNT.buildSettled=true;
        if(page.partialSources&&page.partialSources.total)MNT.operation.gaps=true;
        return page;
      }
      if(Date.now()-started>300000)throw new Error('The inventory update is still pending. Check Activity before retrying.');
      return mntDelay(1500).then(tick);
    });
  }
  return tick();
}
function mntPollProviders(previousCheck){
  var started=Date.now();
  function tick(){return mntGet('/api/maintenance').then(function(data){
    var activity=data&&data.activity,scan=data&&data.scan;
    if(activity&&activity.status==='failed')throw new Error('The evidence check failed.');
    var fresh=previousCheck===undefined||(scan&&scan.checkedAt!==previousCheck);
    if(activity&&activity.status==='running'||!fresh){
      mntSetOperation('Refreshing evidence…');
      if(Date.now()-started>300000)throw new Error('The evidence check is still pending.');
      return mntDelay(2000).then(tick);
    }
    if(!scan||(scan.status!=='complete'&&scan.status!=='stale'))throw new Error('The evidence check did not complete.');
    MNT.operation.staleMeasurement=scan.status==='stale';
    MNT.operation.gaps=scan.coverage==='partial';
    return data;
  });}
  return tick();
}
function mntRunOperation(measure){
  if(mntWritesBlocked()||(measure&&systemBusy))return Promise.resolve();
  MNT.remeasureBusy=measure;MNT.providersBusy=!measure;mntBeginOperation(measure?'measure':'evidence');
  var previousAt,previousCheck;
  return Promise.all([mntGet('/api/maintenance/v2/inventory?limit=1'),mntGet('/api/maintenance')]).then(function(before){
    previousAt=before[0].lastRefresh&&before[0].lastRefresh.at;
    previousCheck=before[1].scan&&before[1].scan.checkedAt;
    if(measure){if(systemBusy)throw new Error('Another system request is in progress. Please retry.');return loadSystem(true).then(function(){if(!SYSTEM||SYSTEM.error)throw new Error('The measurement could not be started.');return mntPollSystemMeasurement();});}
    return mntGet('/api/maintenance?refresh=scan');
  }).then(function(){return mntPollProviders(previousCheck);})
    .then(function(){return mntAwaitInventoryBuild(previousAt);})
    .then(function(){mntSetOperation(MNT.operation.staleMeasurement?'Evidence refreshed · machine measurement is stale. Re-measure machine.':MNT.operation.gaps?'Finished with coverage gaps · see Discovery.':'Inventory updated · checks complete.');})
    .catch(function(error){MNT.operation.failed=true;mntSetOperation(error.message+' Previous inventory remains available.');})
    .then(function(){
      MNT.remeasureBusy=false;MNT.providersBusy=false;
      if(mntOperationTimer){clearInterval(mntOperationTimer);mntOperationTimer=null;}
      renderMntOperation();mntRefreshActiveDestination();
    });
}
export function mntRemeasureMachine(){return mntRunOperation(true);}
export function mntCheckProviders(){return mntRunOperation(false);}
function mntObserveSystemScan(scan){
  if(MNT.remeasureBusy||MNT.providersBusy){
    MNT.externalScanBusy=!!(scan&&scan.running);
    if(scan&&scan.running)mntSetMeasurement(scan);
    renderMntOperation();return;
  }
  if(scan&&scan.running){
    if(!MNT.operation||MNT.operation.kind!=='external'||!MNT.externalScanBusy){
      MNT.externalScanBusy=true;mntBeginOperation('external');
      MNT.operation.startedAt=Number(scan.startedAt)||Date.parse(scan.startedAt)||Date.now();
      MNT.operation.baseline=Promise.all([mntGet('/api/maintenance/v2/inventory?limit=1'),mntGet('/api/maintenance')])
        .then(function(before){return {at:before[0].lastRefresh&&before[0].lastRefresh.at,check:before[1].scan&&before[1].scan.checkedAt};})
        .catch(function(){return {};});
    }
    if(!MNT.operation.following)mntSetMeasurement(scan);
  }else if(MNT.externalScanBusy&&MNT.operation&&MNT.operation.kind==='external'&&!MNT.operation.following){
    var op=MNT.operation;op.following=true;
    Promise.resolve(op.baseline).then(function(before){
      if(scan&&scan.error)throw new Error('The measurement reported a problem.');
      return mntPollProviders(before&&before.check).then(function(){return mntAwaitInventoryBuild(before&&before.at);});
    }).then(function(){mntSetOperation(op.staleMeasurement?'Evidence refreshed · machine measurement is stale. Re-measure machine.':op.gaps?'Finished with coverage gaps · see Discovery.':'Inventory updated · checks complete.');})
      .catch(function(error){op.failed=true;mntSetOperation(error.message+' Previous inventory remains available.');})
      .then(function(){MNT.externalScanBusy=false;clearInterval(mntOperationTimer);mntOperationTimer=null;renderMntOperation();mntRefreshActiveDestination();});
  }
  renderMntOperation();
}
export function mntWireOperation(){
  if(mntOperationWired)return;mntOperationWired=true;
  document.addEventListener('ak-system-scan',function(event){mntObserveSystemScan(event.detail&&event.detail.scan);});
  if(SYSTEM&&SYSTEM.scan&&SYSTEM.scan.running)mntObserveSystemScan(SYSTEM.scan);
}
