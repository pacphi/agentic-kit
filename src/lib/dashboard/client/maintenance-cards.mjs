// @ts-nocheck — dashboard browser bundle.
import { esc } from './bootstrap.mjs';
import { MNT, mntKindLabel } from './maintenance-workspace.mjs';
  // Fixed geometry only: resource metadata is never interpolated into SVG.
  var MNT_ICON_PATHS={
    across:'<path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
    system:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/>',
    machine:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    user:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    git:'<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10v2a7 7 0 0 1-7 7H6"/>',
    project:'<path d="M3 7V5h7l2 3h9v12H3V7Z"/>',
    skill:'<path d="M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h6"/>',
    'mcp-registration':'<path d="M8 3v5m8-5v5M5 8h14v3a7 7 0 0 1-14 0V8Zm7 10v4"/>',
    plugin:'<path d="M4 4h6a3 3 0 1 1 6 0h4v6a3 3 0 1 0 0 6v4H4V4Z"/>',
    model:'<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10 9-5m-9 5L3 8m9 5v9"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    filter:'<path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>'
  };
  export function mntIcon(kind){
    return '<svg class="mnt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      +(MNT_ICON_PATHS[kind]||MNT_ICON_PATHS.skill)+'</svg>';
  }
  var MNT_PROJECT_KIND_LABELS={git:'Git',folder:'Folder',worktree:'Worktree',unknown:'Not checked'};
  export function mntProjectDesignation(projectId){
    var kind=MNT.query&&MNT.query.projectKinds&&MNT.query.projectKinds[projectId]||'unknown';
    return '<span class="mnt-project-kind">'+mntIcon(kind==='git'||kind==='worktree'?'git':kind==='folder'?'project':'info')+'<span>'+esc(MNT_PROJECT_KIND_LABELS[kind]||MNT_PROJECT_KIND_LABELS.unknown)+'</span></span>';
  }
  function mntRowContext(row){
    var crumbs=(row.breadcrumb||[]).slice();
    var project=row.projectId&&MNT.query&&MNT.query.facetLabels&&MNT.query.facetLabels.project&&MNT.query.facetLabels.project[row.projectId];
    if(row.scope.value==='project'&&project&&(mntProjectContext===row.projectId||(MNT.facets.project||[]).length===1)){
      var prefix=project.split(' › ');
      if(prefix.every(function(part,i){return crumbs[i]===part;}))crumbs=crumbs.slice(prefix.length);
    }
    var hostsInContext=MNT.facets.adapter||MNT.facets.consumer||[];
    var inheritedHost=hostsInContext.length===1?hostsInContext[0].toLowerCase():null;
    if(inheritedHost)crumbs=crumbs.filter(function(crumb){return crumb.toLowerCase()!==inheritedHost;});
    var context=crumbs.join(' › ');
    if(MNT.scope==='across')context=(row.scope.label||'')+(context?' · '+context:'');
    return context;
  }
  export function mntAvailableTo(row){
    var labels={claude:'Claude',codex:'Codex',opencode:'OpenCode',hermes:'Hermes','agentic-kit':'Agentic Kit'};
    var hosts=Array.from(new Set((row.consumerHosts||[]).map(function(host){return host.toLowerCase();})))
      .map(function(host){return labels[host]||host;});
    if(!hosts.length)return '';
    return 'Available to '+(hosts.length<2?hosts[0]:hosts.slice(0,-1).join(', ')+' and '+hosts[hosts.length-1]);
  }
  function renderMntVersions(row){
    var v=row.versions||{},pieces=[];
    if(v.installed)pieces.push(v.candidate?v.installed+' → '+v.candidate:'Installed '+v.installed);
    else if(v.producer)pieces.push('Plugin '+v.producer+(v.candidate?' → '+v.candidate:''));
    if(v.effective&&v.effective!==v.installed)pieces.push('Effective '+v.effective);
    return pieces.join(' · ');
  }
  function renderMntPlacementRow(row,rowIndex,single,showCarrier){
    var selected=MNT.plc===row.placementId;
    var context=mntRowContext(row),version=renderMntVersions(row);
    if(showCarrier&&row.carrier&&row.carrier.label&&context.toLowerCase().indexOf(row.carrier.label.toLowerCase())<0)context+=(context?' · ':'')+row.carrier.label;
    var title=single?row.displayName:context||row.displayName;
    var subtitle=[single?context:'',mntAvailableTo(row),single?'':version].filter(Boolean).join(' · ');
    var kindShown=!(MNT.facets.kind&&MNT.facets.kind.length===1);
    return '<li><button type="button" class="mnt-row'+(selected?' selected':'')+'" data-mnt-plc="'+esc(row.placementId)
      +'" tabindex="'+(rowIndex===0?'0':'-1')+'" aria-controls="mnt-inspector" aria-expanded="'+selected+'"'
      +' aria-label="View details for '+esc(row.displayName)+(context?' — '+esc(context):'')+'">'
      +(single?mntIcon(row.kind):'')+'<span class="mnt-row-copy"><span class="mnt-row-name">'+esc(title)+'</span>'
      +(subtitle?'<span class="mnt-row-context">'+esc(subtitle)+'</span>':'')+'</span>'
      +(single&&kindShown?'<span class="mnt-group-kind">'+esc(mntKindLabel(row.kind))+'</span>':'')
      +(single&&version?'<span class="mnt-row-versions">'+esc(version)+'</span>':'')
      +(row.guidanceLane&&row.guidanceLane.value!=='apply'?'<span class="mnt-lane-badge">'+esc(row.guidanceLane.label)+'</span>':'')
      +'<span class="mnt-row-action"><span class="sr-only">View details</span>'+mntIcon('chevron')+'</span></button></li>';
  }
  // ── Large-group disclosure: a group carrying more than 3 placements (a
  // shared skill/plugin/etc. installed across many projects) shows only its
  // first 3 rows behind a "Show N more" toggle, so a screenshot of the whole
  // list is not dominated by one identical-looking group. It opens expanded
  // by default when ANY of its placements carries a guidance lane (that
  // guidance must not sit below the fold); a purely healthy/evidence-only
  // group starts collapsed. An explicit toggle click is remembered per
  // resourceId for the rest of THIS session (sessionStorage) only — P's
  // separate work on the group projection (one group per resource, not one
  // per project) is what actually shrinks the count; this is presentation
  // only and never merges groups client-side. ──
  var MNT_GROUP_COLLAPSE_LIMIT=3;
  var MNT_SS_GROUP_EXPANDED="ak-dash-mnt-group-expanded";
  function mntGroupExpandedMap(){
    try{return JSON.parse(sessionStorage.getItem(MNT_SS_GROUP_EXPANDED)||"{}");}catch(e){return {};}
  }
  export function mntRememberGroupExpanded(resourceId,expanded){
    try{
      var state=mntGroupExpandedMap();
      state[resourceId]=expanded;
      sessionStorage.setItem(MNT_SS_GROUP_EXPANDED,JSON.stringify(state));
    }catch(e){}
  }
  function mntGroupExpanded(group){
    var remembered=mntGroupExpandedMap()[group.disclosureKey||group.presentationKey||group.resourceId];
    if(typeof remembered==="boolean")return remembered;
    return group.placements.some(function(row){return !!row.guidanceLane;});
  }
  export function renderMntGroup(group,rowIndexRef){
    var overLimit=group.placements.length>MNT_GROUP_COLLAPSE_LIMIT;
    var expanded=!overLimit||mntGroupExpanded(group);
    var visible=expanded?group.placements:group.placements.slice(0,MNT_GROUP_COLLAPSE_LIMIT);
    var carriers=new Set(group.placements.map(function(row){return row.carrier&&row.carrier.value;}));
    var rowsHtml=visible.map(function(row){
      var html=renderMntPlacementRow(row,rowIndexRef.value,group.placements.length===1&&!(group.knownPlacementCount>1),carriers.size>1);
      rowIndexRef.value+=1;
      return html;
    }).join("");
    var toggle=overLimit
      ?'<button type="button" class="mt-action mnt-group-toggle" data-mnt-group-toggle="'+esc(group.disclosureKey||group.presentationKey||group.resourceId)
        +'" aria-expanded="'+(expanded?"true":"false")+'">'
        +(expanded?"Show fewer":"Show "+esc(group.placements.length-visible.length)+" more")+"</button>"
      :"";
    if(group.placements.length===1&&!(group.knownPlacementCount>1))return '<li class="mnt-group mnt-group-single"><ul class="mnt-placements">'+rowsHtml+'</ul></li>';
    var kindShown=!(MNT.facets.kind&&MNT.facets.kind.length===1);
    return '<li class="mnt-group"><div class="mnt-group-head">'+mntIcon(group.kind)
      +'<span class="mnt-group-name">'+esc(group.displayName)+'</span>'
      +(kindShown?'<span class="mnt-group-kind">'+esc(mntKindLabel(group.kind))+'</span>':'')
      +'<span class="mnt-group-counts">'+esc(group.placementCount)+(group.placementCount===1?' installation':' installations')+(mntProjectContext?' in this project':' in these results')+'</span>'
      +(group.knownPlacementCount>group.placements.length&&(MNT.view!=='all'||MNT.scope!=='across'||MNT.search||Object.keys(MNT.facets||{}).some(function(f){return f!=='family';}))?'<button type="button" class="mt-action" data-mnt-family="'+esc(group.presentationKey||group.resourceId)+'" aria-label="View all '+esc(group.knownPlacementCount)+' installations of '+esc(group.displayName)+' across scopes">View all '+esc(group.knownPlacementCount)+' installations</button>':'')
      +'</div><ul class="mnt-placements">'+rowsHtml+'</ul>'+toggle+'</li>';
  }

  var mntProjectContext=null;
  export function renderMntGroups(groups,rowIndexRef){
    if(MNT.scope!=='project')return groups.map(function(group){return renderMntGroup(group,rowIndexRef);}).join('');
    var projects=new Map(),labels=MNT.query&&MNT.query.facetLabels&&MNT.query.facetLabels.project||{};
    groups.forEach(function(group){
      var rows=new Map();
      group.placements.forEach(function(row){var key=row.projectId||'';if(!rows.has(key))rows.set(key,[]);rows.get(key).push(row);});
      rows.forEach(function(placements,key){
        if(!projects.has(key))projects.set(key,[]);
        projects.get(key).push(Object.assign({},group,{disclosureKey:(group.presentationKey||group.resourceId)+':'+key,placements:placements,placementCount:placements.length}));
      });
    });
    var html='';
    projects.forEach(function(items,key){
      mntProjectContext=key;
      var contents=items.map(function(group){return renderMntGroup(group,rowIndexRef);}).join('');
      html+=(MNT.facets.project||[]).length===1&&MNT.facets.project[0]===key?contents:
        '<li class="mnt-project-section"><h4>'+esc(labels[key]||'Project installations')+mntProjectDesignation(key)+'</h4><ul class="mnt-groups">'+contents+'</ul></li>';
    });
    mntProjectContext=null;return html;
  }
