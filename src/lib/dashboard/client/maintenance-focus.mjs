// @ts-nocheck — classic browser bundle source.
import { esc } from './bootstrap.mjs';
import { MNT, MNT_SCOPE_LABELS, mntKindLabel } from './maintenance-workspace.mjs';
import { mntIcon, mntAvailableTo } from './maintenance-cards.mjs';
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
      return '<span class="mnt-language-badge" title="'+esc(language.evidence==='artifact'?'Project artifact detected; source lines not measured':'Source language detected')+'"><span class="mnt-language-icon" aria-hidden="true">'+esc(language.icon)+'</span>'+esc(language.name)+'</span>';
    }).join('')+'</span>';
  }
  function mntFocusNode(node,index,level,busy){
    var icon=level==='scope'?node.value:level==='project'?'project':level==='kind'?node.value:node.kind;
    var note=level==='project'?({git:'Git repository',worktree:'Worktree',folder:'Folder',unknown:'Project type not checked'}[node.projectKind]||'')
      :level==='resource'&&!(MNT.facets.kind||[]).length?mntKindLabel(node.kind):'';
    if(level==='resource'&&node.installationSource)note=node.installationSource;
    return '<li><button type="button" class="mnt-row mnt-focus-node" data-mnt-focus="'+esc(node.value)+'" data-mnt-level="'+esc(level)+'" tabindex="'+(index===0?'0':'-1')+'"'+(busy?' disabled':'')+'>'
      +mntIcon(icon)+'<span class="mnt-row-copy"><span class="mnt-row-name">'+esc(node.label)+'</span>'
      +(level==='project'&&node.languages&&node.languages.length?mntLanguageBadges(node.languages.slice(0,3)):'')
      +(node.description?'<span class="mnt-row-context mnt-resource-description" title="'+esc(node.descriptionSource||'Declared description')+'">'+esc(node.description)+'</span>':'')
      +(note?'<span class="mnt-row-context">'+esc(note)+'</span>':'')+'</span><span class="mnt-node-count">'+esc(node.count)+' installation'+(node.count===1?'':'s')+'</span>'+mntIcon('chevron')+'</button>'+(level==='project'&&node.languages&&node.languages.length>3?'<details class="mnt-language-more"><summary>+'+(node.languages.length-3)+' more languages</summary>'+mntLanguageBadges(node.languages.slice(3))+'</details>':'')+'</li>';
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
    if(nav.level!=='installation')return '<ul class="mnt-focus-list">'+(nav.nodes||[]).map(function(node,index){return mntFocusNode(node,index,nav.level,busy);}).join('')+'</ul>';
    var rows=(MNT.query.groups||[]).reduce(function(all,group){return all.concat(group.placements||[]);},[]);
    var family=(MNT.query.groups||[])[0],allLink=family&&family.knownPlacementCount>MNT.query.total?'<p><button type="button" class="mt-action" data-mnt-family="'+esc(family.presentationKey||family.resourceId)+'">View all '+esc(family.knownPlacementCount)+' installations</button></p>':'';
    return allLink+'<ul class="mnt-focus-list">'+rows.map(mntFocusInstallation).join('')+'</ul>';
  }
