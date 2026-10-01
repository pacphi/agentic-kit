// @ts-nocheck — browser bundle source; assembled by ../client.mjs.
import { esc, authHeaders } from './bootstrap.mjs';
import { sourceHostIcon } from './usage.mjs';
import { startRefresh, refreshRunning } from './refresh-control.mjs';

var HEALTH_REPORT=null, HEALTH_HOST=null, HEALTH_BUSY=false, HEALTH_BUSY_HOST=null, HEALTH_ACK=null;
var HEALTH_NAMES={claude:'Claude Code',codex:'Codex',opencode:'OpenCode'};
var HEALTH_LABELS={ok:'OK',attention:'Attention',unknown:'Unknown',checking:'Checking',unmanaged:'Found, not managed','not-installed':'Not installed'};
var HEALTH_CHECK_NAMES={installation:'Executable',configuration:'Configuration',model:'Provider / model selection',authentication:'Authentication setup',integration:'Integration configuration'};
// ADR-0053 (2026-09-26): whether ak manages a host is a management fact, not
// health. The server sends the words (src/lib/host-management.mjs); a payload
// without them predates the split, when every assessed host was managed.
var MANAGED={state:'managed',label:'Managed by ak'};
var NOT_PARTICIPATING='Not participating: ak routes no work to this host.';

function healthTime(value){var date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString():'Not checked';}
function healthRow(){return HEALTH_REPORT&&HEALTH_REPORT.hosts&&HEALTH_REPORT.hosts[HEALTH_HOST];}
function healthState(state){return ({pass:'Passed',fail:'Needs attention',unknown:'Unknown','not-run':'Not run',running:'Checking',expired:'Expired',changed:'Settings changed','not-checked':'Not checked'})[state]||'Unknown';}
function hostManagementOf(row){return row&&row.management&&row.management.label?row.management:MANAGED;}
function hostIsManaged(row){return hostManagementOf(row).state==='managed';}
function hostHint(row){return row&&row.participation&&!row.participation.participating&&row.participation.hint||null;}
function hintHtml(hint){
  return ' To include it: <code>'+esc(hint)+'</code> <button type="button" class="hp-copy" data-copy="'+esc(hint)+'">Copy</button>';
}

export function renderHostReadiness(report,checking){
  var el=document.getElementById('host-readiness');
  if(!el)return;
  if(report&&HEALTH_REPORT&&Date.parse(report.checkedAt)<Date.parse(HEALTH_REPORT.checkedAt))return;
  HEALTH_REPORT=report;
  el.hidden=false;
  el.innerHTML=['claude','codex','opencode'].map(function(host){
    var row=report&&report.hosts&&report.hosts[host];
    var configuration=row&&row.checks&&row.checks.configuration;
    var unassessed=host==='claude'&&configuration&&['unknown','not-run','not-checked'].includes(configuration.state);
    var state=checking||(HEALTH_BUSY&&HEALTH_BUSY_HOST===host)?'checking':unassessed?'unknown':row&&HEALTH_LABELS[row.status]?row.status:'unknown';
    var managed=!row||hostIsManaged(row);
    // A managed host's badge is its health; any other host's badge is its
    // management word, in a neutral colour: its problems are information.
    var text=managed||state==='checking'?HEALTH_LABELS[state]:hostManagementOf(row).label;
    var level=row&&row.level==='connected'?'Connected':'Local';
    var detail=HEALTH_NAMES[host]+': '+(row?hostManagementOf(row).label+'. ':'')
      +(managed?HEALTH_LABELS[state]+'. '+level+' health check.':'Tool checks: '+(HEALTH_LABELS[row.localStatus]||'Unknown')+' (information only).')+' Open check details.';
    return '<button type="button" class="source-pill" data-health-host="'+host+'" data-status="'+state+'" aria-label="'+esc(detail)+'" aria-haspopup="dialog" aria-controls="host-health-dialog">'
      +'<span class="sp-icon live-host" data-host="'+host+'">'+sourceHostIcon(host)+'</span>'
      +'<span class="sp-status">'+esc(text)+'</span></button>';
  }).join('');
  renderHostParticipation(report);
  renderHealthDialog();
}

// Overview → Hosts & Routing: which hosts ak's routing policy may target
// (dual-host routes, the AQE agent routes ak projects, ak run pipelines).
// The enable hint is copyable text, never a control that edits
// configuration; it names the complete --host list.
export function renderHostParticipation(report){
  var strip=document.getElementById('host-participation');
  if(!strip)return;
  var hosts=report&&report.hosts;
  var ids=['claude','codex','opencode'].filter(function(host){return hosts&&hosts[host];});
  if(!ids.length){strip.hidden=true;return;}
  strip.hidden=false;
  var managedCount=ids.filter(function(host){return hostIsManaged(hosts[host]);}).length;
  var note=document.getElementById('host-participation-note');
  if(note)note.textContent=managedCount+' of '+ids.length+' managed by ak';
  document.getElementById('host-participation-list').innerHTML=ids.map(function(host){
    var row=hosts[host],management=hostManagementOf(row),hint=hostHint(row);
    var part=hostIsManaged(row)?'Participating: ak can route work to this host.':NOT_PARTICIPATING+(hint?hintHtml(hint):'');
    return '<li class="hp-row" data-host="'+host+'" data-management="'+esc(management.state)+'">'
      +'<span class="sp-icon live-host" data-host="'+host+'">'+sourceHostIcon(host)+'</span>'
      +'<b>'+HEALTH_NAMES[host]+'</b><span class="hp-state">'+esc(management.label)+'</span>'
      +'<span class="hp-part">'+part+'</span></li>';
  }).join('');
}

/** About → Hosts card chip from the same report the header pills use. Null
 * without a report, so About keeps joining `ak status` rows. */
export function aboutHostChip(host,report){
  var row=report&&report.hosts&&report.hosts[host];
  if(!row||!row.management)return null;
  var management=row.management,hint=hostHint(row);
  if(management.state==='managed')return {state:'managed',word:management.label,detail:null};
  return {state:management.state==='not-installed'?'not-installed':'unmanaged',word:management.label,
    detail:hint?NOT_PARTICIPATING+' To include it: '+hint:null};
}

function healthSummary(row){
  if(HEALTH_BUSY&&HEALTH_BUSY_HOST===HEALTH_HOST)return 'Checking…';
  var level=row&&row.level==='connected'?'Connected':'Local';
  var time=healthTime(row&&row.level==='connected'&&row.connection&&row.connection.checkedAt||row&&row.checkedAt);
  if(row&&!hostIsManaged(row))return hostManagementOf(row).label+' · Local checks · '+time;
  return (row?hostManagementOf(row).label+' · '+HEALTH_LABELS[row.status]:'Unknown')+' · '+level+' checks · '+time;
}

function healthCheckItem(key,check,managed){
  var fyi=check.fyi?' (FYI: ak does not wire this host)':'';
  return '<li data-check-key="'+key+'" data-check-state="'+esc(check.state)+'"'+(managed?'':' data-info="true"')+'><span class="health-check-heading">'+HEALTH_CHECK_NAMES[key]+fyi+' <b>'+healthState(check.state)+'</b></span>'
    +'<span>'+esc(check.reason)+(check.version?' · '+esc(check.version):'')+'</span></li>';
}

function renderHealthDialog(){
  if(!HEALTH_HOST)return;
  var row=healthRow(),dialog=document.getElementById('host-health-dialog');
  if(!dialog)return;
  var managed=!row||hostIsManaged(row);
  document.getElementById('host-health-title').textContent=HEALTH_NAMES[HEALTH_HOST]+' health';
  document.getElementById('host-health-summary').textContent=healthSummary(row);
  document.getElementById('host-health-project').textContent='Project: '+(HEALTH_REPORT&&HEALTH_REPORT.project||'dashboard launch directory');
  var checks=row&&row.checks||{};
  document.getElementById('host-health-checks').innerHTML=Object.keys(HEALTH_CHECK_NAMES).map(function(key){
    return healthCheckItem(key,checks[key]||{state:'unknown',reason:'No current evidence.'},managed);
  }).join('');
  var target=row&&row.target;
  document.getElementById('host-health-target').textContent='Selection: '+(target?[target.provider,target.model].filter(Boolean).join(' / ')||'native host default':'native host default or unassessed');
  var participation=document.getElementById('host-health-participation');
  if(participation){
    var hint=hostHint(row);
    participation.innerHTML=!row?'':managed?'Managed by ak: ak can route work to this host.'
      :esc(NOT_PARTICIPATING)+' Its checks are information only.'+(hint?hintHtml(hint):'');
  }
  var connection=row&&row.connection||{state:'not-run'};
  document.getElementById('host-health-connection').textContent=healthState(connection.state)+(connection.checkedAt?' · '+healthTime(connection.checkedAt):'')+(connection.reason?' — '+connection.reason:'');
  document.getElementById('host-health-integrations').textContent='Connected check scope: provider inference. Optional MCP tool connections are not tested.';
  document.getElementById('host-health-eligibility').textContent=row&&row.connectionUnavailable||'';
  var consent=document.getElementById('host-health-consent');
  if(!row||HEALTH_ACK!==row.evidenceKey){consent.checked=false;HEALTH_ACK=null;}
  consent.disabled=HEALTH_BUSY||!row||!row.canCheckConnection;
  document.getElementById('host-health-connect').disabled=HEALTH_BUSY||!row||!row.canCheckConnection||!consent.checked;
  document.getElementById('host-health-run-refresh').disabled=HEALTH_BUSY||refreshRunning();
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

// Copy only: the dashboard never runs `ak host pick` for the user.
function copyHostHint(button,status){
  var text=button.getAttribute('data-copy');
  var done=function(ok){if(status)status.textContent=ok?'Copied: '+text:'Copy unavailable; select the command and copy it.';};
  if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){
    Promise.resolve(navigator.clipboard.writeText(text)).then(function(){done(true);},function(){done(false);});
  }else done(false);
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
  // Return focus to the badge that opened the dialog, but only while focus is
  // still in the dialog or nowhere. `close` is a queued task: a fast keyboard
  // sequence may already have moved focus to another badge.
  dialog.addEventListener('close',function(){
    var active=document.activeElement;
    if(active&&active!==document.body&&!dialog.contains(active))return;
    var button=region.querySelector('[data-health-host="'+HEALTH_HOST+'"]');if(button)button.focus();
  });
  document.getElementById('host-health-consent').addEventListener('change',function(event){HEALTH_ACK=event.target.checked&&healthRow()?healthRow().evidenceKey:null;renderHealthDialog();});
  document.getElementById('host-health-run-refresh').addEventListener('click',function(){startRefresh('local');});
  document.getElementById('host-health-connect').addEventListener('click',function(){runHealthCheck(true);});
  dialog.addEventListener('click',function(event){
    var button=event.target.closest('[data-copy]');
    if(button)copyHostHint(button,document.getElementById('host-health-message'));
  });
  var strip=document.getElementById('host-participation');
  if(strip)strip.addEventListener('click',function(event){
    var button=event.target.closest('[data-copy]');
    if(button)copyHostHint(button,document.getElementById('host-participation-note'));
  });
  renderHostReadiness(null,true);
}
