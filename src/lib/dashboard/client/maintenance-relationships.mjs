// @ts-nocheck — browser bundle; evidence-bearing relationships only.
import { esc } from './bootstrap.mjs';
import { MNT, mntKindLabel, MNT_SCOPE_LABELS } from './maintenance-workspace.mjs';

  function mntRelationshipTarget(target){
    var outside=MNT.scope!=='across'&&target.scope!==MNT.scope;
    ['kind','project'].forEach(function(facet){var values=MNT.facets[facet]||[];if(values.length&&values.indexOf(facet==='kind'?target.kind:target.projectId)<0)outside=true;});
    var context=[MNT_SCOPE_LABELS[target.scope]||target.scope,(target.consumerHosts||[]).join(', ')].filter(Boolean).join(' · ');
    return '<li><button type="button" class="mnt-relationship-link" data-mnt-related="'+esc(target.placementId)+'" data-mnt-related-outside="'+outside+'">'+esc(target.displayName)
      +(context?' <span>'+esc(context)+'</span>':'')+' →</button></li>';
  }
  function mntRelationshipCard(label,summary,body){
    return '<details class="mnt-relationship"><summary><span>'+esc(label)+'</span><strong>'+esc(summary)+'</strong></summary>'+body+'</details>';
  }
  function mntRelationshipTargets(label,targets,explanation){
    if(!targets||!targets.length)return '';
    return mntRelationshipCard(label,targets.length===1?targets[0].displayName:targets.length+' installations','<p>'+esc(explanation)+'</p><ul>'+targets.map(mntRelationshipTarget).join('')+'</ul>');
  }
  function mntRelationshipDependencies(label,entries){
    if(!entries||!entries.length)return '';
    return mntRelationshipCard(label,entries.length+' recorded relationship'+(entries.length===1?'':'s'),'<ul>'+entries.map(function(edge){
      if(edge.target)return mntRelationshipTarget(edge.target);
      return '<li>'+esc(edge.requirement||mntKindLabel(edge.kind))+(edge.satisfied===false?' · Missing':edge.satisfied===true?' · Observed':' · Resolution not established')+'</li>';
    }).join('')+'</ul><p>A requirement does not prove that a change is safe for its consumers.</p>');
  }
  export function mntRenderRelationships(relationships){
    if(!relationships)return '';
    var r=relationships,html='';
    html+=mntRelationshipTargets('Provided by',r.providedBy,'Recorded producer relationship. Inclusion does not prove who performed the installation.');
    html+=mntRelationshipTargets('Provides',r.includes,'Included resources remain distinct installations; these links do not add to inventory counts.');
    if((r.consumers||[]).length)html+=mntRelationshipCard('Available to',r.consumers.map(function(c){return c.label;}).join(', '),'<p>Recorded consumer bindings do not establish recent use.</p><ul>'+r.consumers.map(function(c){return '<li>'+esc(c.label)+(c.enabled===false?' · Disabled':'')+'</li>';}).join('')+'</ul>');
    html+=mntRelationshipDependencies('Requires',r.dependencies);
    html+=mntRelationshipDependencies('Required by',r.dependents);
    html+=mntRelationshipTargets('Also installed',r.otherInstallations,'Other recorded installations of this resource. Shared identity does not establish identical content or make an installation disposable.');
    if(r.originStatus==='not-established'&&!((r.providedBy||[]).length))html+=mntRelationshipCard('Origin','Not established','<p>No recorded producer relationship is available. An absent plugin link does not prove independent installation.</p>');
    return html?'<section class="mnt-q"><h4>Relationships</h4><div class="mnt-relationships">'+html+'</div>'+(r.truncated?'<p>Some relationship links are omitted from this bounded view.</p>':'')+'</section>':'';
  }
