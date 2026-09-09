// @ts-nocheck — browser bundle source.
import { esc } from './bootstrap.mjs';
import { renderSysProjects } from './system-projects.mjs';
import { SYSTEM } from './system-readout.mjs';
export var projectPopulation='measured', projectOrigin='all';
export function projectControls(payload) {
  var options=[['all','All session origins'],['claude-desktop','Claude Desktop'],['codex-desktop','Codex Desktop'],['unknown','Unknown / unclassified']];
  return '<div class="project-controls"><label>Show <select id="project-population"><option value="measured"'
    +(projectPopulation==='measured'?' selected':'')+'>Measured repositories</option><option value="all"'
    +(projectPopulation==='all'?' selected':'')+'>All discovered directories</option></select></label>'
    +'<label>Session origin <select id="project-origin">'+options.map(function(pair){return '<option value="'+pair[0]+'"'
      +(projectOrigin===pair[0]?' selected':'')+'>'+pair[1]+'</option>';}).join('')+'</select></label></div>'
    +(!payload.discoveryProjects?'<p class="project-note">Older snapshot: full discovery and origin evidence unavailable. Rescan to populate.</p>':'');
}
export function projectIdentityCell(pr) {
  if(!pr.repository&&!pr.sessionOrigins)return '';
  var origins=(pr.sessionOrigins||[]).map(function(item){var labels={'claude-desktop':'Claude Desktop','codex-desktop':'Codex Desktop',unknown:'Unknown origin'};
    return esc(labels[item.origin]||item.origin);}).join(' · ');
  return '<span class="project-identity">'+esc(pr.repository&&pr.repository.kind||'unknown')
    +(origins?' · '+origins:'')+'</span><span class="project-path">'+esc(pr.path||'')+'</span>';
}
document.addEventListener('change',function(event){
  var id=event.target&&event.target.id;
  if(id!=='project-population'&&id!=='project-origin')return;
  if(id==='project-population')projectPopulation=event.target.value;
  else projectOrigin=event.target.value;
  if(SYSTEM)renderSysProjects(SYSTEM);
  var control=document.getElementById(id);if(control)control.focus();
});
