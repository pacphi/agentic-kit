// @ts-nocheck — bundled with shared vocabulary by client.mjs.
import { SESSION_HOST_LABELS, SESSION_SURFACE_LABELS, sessionPresentation } from '../../session-surface.mjs';
import { esc } from './bootstrap.mjs';

export function surfaceEntries(project){
  if(Array.isArray(project.sessionSurfaces))return project.sessionSurfaces.filter(function(row){return row.sessions>0;});
  return (project.sessionOrigins||[]).filter(function(row){return row.sessions>0;});
}
export function surfaceNames(project){
  var entries=surfaceEntries(project);
  return Array.from(new Set(entries.map(function(row){return sessionPresentation(row).label;}))).sort();
}
export function surfaceRawText(origin){
  var raw=origin.rawEvidence||{},parts=[];
  ['entrypoint','originator','source','threadSource','sessionKind'].forEach(function(key){
    var values=Array.isArray(raw[key])?raw[key]:[raw[key]];
    values.slice(0,16).forEach(function(value){
      if(typeof value==='string'&&value.length<=80&&(value==='Codex Desktop'||/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)))parts.push(key+': '+value);
    });
  });
  if(origin.rawEvidenceComplete===false)parts.push('additional raw declarations omitted by bound');
  return parts.join(' · ');
}
export function surfaceDetailHtml(origin){
  var p=sessionPresentation(origin),raw=surfaceRawText(origin);
  return esc(p.label)+' · initiator: '+esc(p.initiator)+(p.note?' · '+esc(p.note):'')+(raw?' · '+esc(raw):'')+(Array.isArray(origin.attributes)?' · '+origin.attributes.filter(function(value){return ['on 3P','started from Claude Desktop','started from mobile','started from a project','started from web'].includes(value);}).map(esc).join(', '):'');
}
export function projectSurfacesHtml(project){
  var entries=surfaceEntries(project);
  return '<details class="session-surface-detail"><summary>Session surfaces: '+esc(surfaceNames(project).join(', ')||'Unknown')+'</summary>'
    +(entries.length?entries.map(function(row){return '<div>Host: '+esc(Object.hasOwn(SESSION_HOST_LABELS,row.host)?SESSION_HOST_LABELS[row.host]:'Unknown')+' · '+surfaceDetailHtml(row)+' · provider: '+esc(sessionPresentation(row).provider)+' ('+esc(sessionPresentation(row).providerBasis)+')'
      +' · '+esc(row.sessions)+' sessions ('+esc(row.countBasis||'legacy count basis unknown')+')</div>';}).join(''):'<div>Host, initiator and provider: Unknown</div>')+'</details>';
}
export function surfaceFacetLabel(value){
  if(value==='unknown')return 'Legacy origin: no declared desktop origin';
  if(value==='surface-unknown')return 'Unknown session surface';
  if(value==='codex-desktop')return sessionPresentation({origin:value}).note;
  return Object.hasOwn(SESSION_SURFACE_LABELS,value)?SESSION_SURFACE_LABELS[value]:'Unknown';}
