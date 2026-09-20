// @ts-nocheck — browser bundle source; assembled by ../client.mjs.
import { esc, authHeaders } from './bootstrap.mjs';
import { sourceHostIcon } from './usage.mjs';

var HEALTH_REPORT=null, HEALTH_HOST=null, HEALTH_BUSY=false, HEALTH_BUSY_HOST=null, HEALTH_ACK=null;
var HEALTH_NAMES={claude:'Claude Code',codex:'Codex',opencode:'OpenCode'};
var HEALTH_LABELS={ok:'OK',attention:'Attention',unknown:'Unknown',disabled:'Disabled',checking:'Checking'};
var HEALTH_CHECK_NAMES={installation:'Executable',configuration:'Configuration',model:'Provider / model selection',authentication:'Authentication setup',integration:'Integration configuration'};

function healthTime(value){var date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString():'Not checked';}
function healthRow(){return HEALTH_REPORT&&HEALTH_REPORT.hosts&&HEALTH_REPORT.hosts[HEALTH_HOST];}
function healthState(state){return ({pass:'Passed',fail:'Needs attention',unknown:'Unknown','not-run':'Not run',running:'Checking',expired:'Expired',changed:'Settings changed','not-checked':'Not checked'})[state]||'Unknown';}

export function renderHostReadiness(report,checking){
  var el=document.getElementById('host-readiness');
  if(!el)return;
  if(report&&HEALTH_REPORT&&Date.parse(report.checkedAt)<Date.parse(HEALTH_REPORT.checkedAt))return;
  HEALTH_REPORT=report;
  el.hidden=false;
  el.innerHTML=['claude','codex','opencode'].map(function(host){
    var row=report&&report.hosts&&report.hosts[host];
    var state=checking||(HEALTH_BUSY&&HEALTH_BUSY_HOST===host)?'checking':row&&HEALTH_LABELS[row.status]?row.status:'unknown';
    var level=row&&row.level==='connected'?'Connected':'Local';
    var detail=HEALTH_NAMES[host]+': '+HEALTH_LABELS[state]+'. '+level+' health check. Open check details.';
    return '<button type="button" class="source-pill" data-health-host="'+host+'" data-status="'+state+'" aria-label="'+esc(detail)+'" aria-haspopup="dialog" aria-controls="host-health-dialog">'
      +'<span class="sp-icon live-host" data-host="'+host+'">'+sourceHostIcon(host)+'</span>'
      +'<span class="sp-status">'+HEALTH_LABELS[state]+'</span></button>';
  }).join('');
  renderHealthDialog();
}

function renderHealthDialog(){
  if(!HEALTH_HOST)return;
  var row=healthRow(),dialog=document.getElementById('host-health-dialog');
  if(!dialog)return;
  document.getElementById('host-health-title').textContent=HEALTH_NAMES[HEALTH_HOST]+' health';
  var level=row&&row.level==='connected'?'Connected':'Local';
  document.getElementById('host-health-summary').textContent=HEALTH_BUSY&&HEALTH_BUSY_HOST===HEALTH_HOST?'Checking…':
    (row?HEALTH_LABELS[row.status]:'Unknown')+' · '+level+' checks · '+healthTime(row&&row.level==='connected'&&row.connection&&row.connection.checkedAt||row&&row.checkedAt);
  document.getElementById('host-health-project').textContent='Project: '+(HEALTH_REPORT&&HEALTH_REPORT.project||'dashboard launch directory');
  var checks=row&&row.checks||{};
  document.getElementById('host-health-checks').innerHTML=Object.keys(HEALTH_CHECK_NAMES).map(function(key){
    var check=checks[key]||{state:'unknown',reason:row&&row.status==='disabled'?'Host is disabled.':'No current evidence.'};
    return '<li data-check-state="'+esc(check.state)+'"><span class="health-check-heading">'+HEALTH_CHECK_NAMES[key]+' <b>'+healthState(check.state)+'</b></span>'
      +'<span>'+esc(check.reason)+(check.version?' · '+esc(check.version):'')+'</span></li>';
  }).join('');
  var target=row&&row.target;
  document.getElementById('host-health-target').textContent='Selection: '+(target?[target.provider,target.model].filter(Boolean).join(' / ')||'native host default':'native host default or unassessed');
  var connection=row&&row.connection||{state:'not-run'};
  document.getElementById('host-health-connection').textContent=healthState(connection.state)+(connection.checkedAt?' · '+healthTime(connection.checkedAt):'')+(connection.reason?' — '+connection.reason:'');
  document.getElementById('host-health-integrations').textContent='Connected check scope: provider inference. Optional MCP tool connections are not tested.';
  document.getElementById('host-health-eligibility').textContent=row&&row.connectionUnavailable||'';
  var consent=document.getElementById('host-health-consent');
  if(!row||HEALTH_ACK!==row.evidenceKey){consent.checked=false;HEALTH_ACK=null;}
  consent.disabled=HEALTH_BUSY||!row||!row.canCheckConnection;
  document.getElementById('host-health-connect').disabled=HEALTH_BUSY||!row||!row.canCheckConnection||!consent.checked;
  document.getElementById('host-health-refresh').disabled=HEALTH_BUSY;
}

async function runHealthCheck(connected){
  var row=healthRow();
  if(HEALTH_BUSY||!HEALTH_HOST||connected&&(!row||!row.canCheckConnection||HEALTH_ACK!==row.evidenceKey))return;
  var body={host:HEALTH_HOST};
  if(connected){body.confirm=true;body.evidenceKey=row.evidenceKey;}
  HEALTH_BUSY=true;HEALTH_BUSY_HOST=HEALTH_HOST;
  document.getElementById('host-health-message').textContent=connected?'Checking connection and revalidating local setup…':'Checking local setup…';
  renderHostReadiness(HEALTH_REPORT);
  try{
    var response=await fetch('/api/host-health/'+(connected?'connection':'local'),{method:'POST',headers:Object.assign({'content-type':'application/json'},authHeaders()),body:JSON.stringify(body)});
    var data=await response.json();
    if(!response.ok)throw new Error(data.error||'Health check unavailable.');
    HEALTH_BUSY=false;HEALTH_BUSY_HOST=null;HEALTH_ACK=null;
    renderHostReadiness(data);
    document.getElementById('host-health-message').textContent='Check completed.';
  }catch(error){
    HEALTH_BUSY=false;HEALTH_BUSY_HOST=null;HEALTH_ACK=null;
    renderHostReadiness(null);
    document.getElementById('host-health-message').textContent=error.message||'Health check unavailable.';
  }
}

export function wireHostHealth(){
  var region=document.getElementById('host-readiness'),dialog=document.getElementById('host-health-dialog');
  if(!region||!dialog)return;
  region.addEventListener('click',function(event){
    var button=event.target.closest('[data-health-host]');if(!button)return;
    HEALTH_HOST=button.getAttribute('data-health-host');HEALTH_ACK=null;
    document.getElementById('host-health-message').textContent='';renderHealthDialog();dialog.showModal();
  });
  document.getElementById('host-health-close').addEventListener('click',function(){dialog.close();});
  dialog.addEventListener('close',function(){var button=region.querySelector('[data-health-host="'+HEALTH_HOST+'"]');if(button)button.focus();});
  document.getElementById('host-health-consent').addEventListener('change',function(event){HEALTH_ACK=event.target.checked&&healthRow()?healthRow().evidenceKey:null;renderHealthDialog();});
  document.getElementById('host-health-refresh').addEventListener('click',function(){runHealthCheck(false);});
  document.getElementById('host-health-connect').addEventListener('click',function(){runHealthCheck(true);});
  renderHostReadiness(null,true);
}
