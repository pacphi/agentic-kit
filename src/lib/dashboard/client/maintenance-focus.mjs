// @ts-nocheck — classic browser bundle source.
import { mntLanguageLogo } from './maintenance-language-logos.mjs';
import { esc } from './bootstrap.mjs';
import { MNT, MNT_SCOPE_LABELS, mntKindLabel } from './maintenance-workspace.mjs';
import { mntIcon, mntAvailableTo, mntProjectKindBadge } from './maintenance-cards.mjs';
import { mntFacetValueLabel } from './maintenance-filters.mjs';

  export function mntFocusNavigation(){return MNT.query&&MNT.query.navigation;}
  export function mntFocusCrumbs(){
    var crumbs=[{level:'root',label:'All scopes'}];
    if(MNT.scope!=='across')crumbs.push({level:'scope',label:MNT_SCOPE_LABELS[MNT.scope]});
    else if((MNT.facets.scope||[]).length===1)crumbs.push({level:'scope',label:MNT_SCOPE_LABELS[MNT.facets.scope[0]]});
    ['project','kind','family'].forEach(function(facet){
      var values=MNT.facets[facet]||[];
      if(values.length===1)crumbs.push({level:facet,label:mntFacetValueLabel(facet,values[0])});
    });
    return crumbs;
  }
  export function renderMntFocusContext(){
    var el=document.getElementById('mnt-breadcrumbs');if(!el)return;
    var crumbs=mntFocusCrumbs();
    el.innerHTML=crumbs.map(function(crumb,index){
      return (index?'<span aria-hidden="true">/</span>':'')+(index===crumbs.length-1
        ?'<span aria-current="page">'+esc(crumb.label)+'</span>'
        :'<button type="button" data-mnt-back="'+crumb.level+'">'+esc(crumb.label)+'</button>');
    }).join('');
    var heading=document.getElementById('mnt-context-heading');if(heading)heading.textContent=crumbs[crumbs.length-1].label;
    var nav=mntFocusNavigation(),help=document.getElementById('mnt-focus-help');
    var labels={scope:'Choose a scope to explore its resources.',project:'Choose a project to explore its resources.',kind:'Choose a resource type.',resource:'Choose a resource to see its installations.',installation:'Choose an exact installation to see its evidence and relationships.'};
    if(help)help.textContent=nav?labels[nav.level]||'':'';
  }
  export function mntFocusChoose(level,value){
    if(level==='scope'){MNT.scope=value;if(value!=='project')delete MNT.facets.project;}
    else if(level==='project'){MNT.facets.project=[value];delete MNT.facets.kind;delete MNT.facets.family;}
    else if(level==='kind'){MNT.facets.kind=[value];delete MNT.facets.family;}
    else if(level==='resource')MNT.facets.family=[value];
  }
  export function mntFocusBack(level){
    if(level==='root'){MNT.scope='across';delete MNT.facets.scope;delete MNT.facets.project;}
    if(level==='root'||level==='scope')delete MNT.facets.project;
    if(level==='root'||level==='scope'||level==='project')delete MNT.facets.kind;
    if(level!=='family')delete MNT.facets.family;
  }
  function mntLanguageBadges(languages){
    return '<span class="mnt-language-list">'+languages.map(function(language){
      var label=language.name+' — '+(language.evidence==='artifact'?'Project artifact detected; source lines not measured':'Source language detected');
      return '<span class="mnt-language-badge" title="'+esc(label)+'"><img class="mnt-language-icon" width="24" height="24" src="'+mntLanguageLogo(language.id)+'" alt="'+esc(language.name)+'" aria-label="'+esc(label)+'"></span>';
    }).join('')+'</span>';
  }
  function mntProjectOrigins(node){
    var origins=(node.sessionOrigins||[]).filter(function(item){return item.origin==='claude-desktop'||item.origin==='codex-desktop';});
    if(!origins.length)return '';
    return '<span class="mnt-project-origins">'+origins.map(function(item){
      return esc(mntFacetValueLabel('sessionOrigin',item.origin));
    }).join(' · ')+'</span>';
  }
  function mntProjectGroups(nodes,busy){
    var groups=new Map(),index=0;
    nodes.forEach(function(node){
      var key=node.repositoryId||(node.projectKind==='folder'?'folders':'unassociated');
      if(!groups.has(key))groups.set(key,{label:node.repositoryLabel||(key==='folders'?'Other folders':'Other projects'),nodes:[]});
      groups.get(key).nodes.push(node);
    });
    return Array.from(groups.values()).map(function(group){
      return '<section class="mnt-repository-group"><h3>'+esc(group.label)+'</h3><ul class="mnt-focus-list">'
        +group.nodes.map(function(node){return mntFocusNode(node,index++,'project',busy);}).join('')+'</ul></section>';
    }).join('');
  }
  function mntFocusNode(node,index,level,busy){
    var icon=level==='scope'?node.value:level==='project'?'project':level==='kind'?node.value:node.kind;
    var note=level==='resource'&&!(MNT.facets.kind||[]).length?mntKindLabel(node.kind):'';
    if(level==='resource'&&node.installationSource)note=node.installationSource;
    return '<li><button type="button" class="mnt-row mnt-focus-node" data-mnt-focus="'+esc(node.value)+'" data-mnt-level="'+esc(level)+'" tabindex="'+(index===0?'0':'-1')+'"'+(busy?' disabled':'')+'>'
      +(level==='project'?'':mntIcon(icon))+'<span class="mnt-row-copy"><span class="mnt-row-name'+(level==='project'?' mnt-project-title':'')+'">'+(level==='project'?mntIcon('project'):'')+esc(node.label)+'</span>'
      +(level==='project'?mntProjectKindBadge(node.projectKind)+mntProjectOrigins(node):'')
      +(level==='project'&&node.languages&&node.languages.length?mntLanguageBadges(node.languages):'')
      +(node.description?'<span class="mnt-row-context mnt-resource-description" title="'+esc(node.descriptionSource||'Declared description')+'">'+esc(node.description)+'</span>':'')
      +(note?'<span class="mnt-row-context">'+esc(note)+'</span>':'')+'</span><span class="mnt-node-count">'+esc(node.count)+' installation'+(node.count===1?'':'s')+'</span>'+mntIcon('chevron')+'</button></li>';
  }
  function mntFocusInstallation(row,index){
    var crumbs=(row.breadcrumb||[]).slice(),scope=row.scope||{};
    var hosts=mntAvailableTo(row),context=crumbs.join(' › ');
    var title=row.kind==='mcp-registration'&&hosts?hosts.replace(/^Available to /,''):context||row.displayName;
    var subtitle=row.installationSource||(row.kind==='mcp-registration'?context:hosts);
    if(MNT.scope==='across')subtitle=(scope.label||'')+(subtitle?' · '+subtitle:'');
    var selected=MNT.plc===row.placementId;
    return '<li><button type="button" class="mnt-row'+(selected?' selected':'')+'" data-mnt-plc="'+esc(row.placementId)+'" tabindex="'+(index===0?'0':'-1')+'" aria-controls="mnt-inspector" aria-expanded="'+selected+'">'
      +mntIcon(row.kind)+'<span class="mnt-row-copy"><span class="mnt-row-name">'+esc(title)+'</span>'
      +(row.description?'<span class="mnt-row-context mnt-resource-description">'+esc(row.description)+'</span>':'')
      +(subtitle?'<span class="mnt-row-context">'+esc(subtitle)+'</span>':'')+'</span>'
      +(row.guidanceLane?'<span class="mnt-lane-badge">'+esc(row.guidanceLane.label)+'</span>':'')+mntIcon('chevron')+'</button></li>';
  }
  export function renderMntFocusResults(busy){
    var nav=mntFocusNavigation();if(!nav)return null;
    if(nav.level==='project')return mntProjectGroups(nav.nodes||[],busy);
    if(nav.level!=='installation')return '<ul class="mnt-focus-list">'+(nav.nodes||[]).map(function(node,index){return mntFocusNode(node,index,nav.level,busy);}).join('')+'</ul>';
    var rows=(MNT.query.groups||[]).reduce(function(all,group){return all.concat(group.placements||[]);},[]);
    var family=(MNT.query.groups||[])[0],allLink=family&&family.knownPlacementCount>MNT.query.total?'<p><button type="button" class="mt-action" data-mnt-family="'+esc(family.presentationKey||family.resourceId)+'">View all '+esc(family.knownPlacementCount)+' installations</button></p>':'';
    return allLink+'<ul class="mnt-focus-list">'+rows.map(mntFocusInstallation).join('')+'</ul>';
  }
