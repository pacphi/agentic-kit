// @ts-nocheck — dashboard browser bundle.
import { mntIcon, mntProjectDesignation } from './maintenance-cards.mjs';
import { esc } from './bootstrap.mjs';
import { MNT, MNT_GUIDANCE_LANE_LABELS, MNT_CONFLICT_EXPLANATIONS, MNT_CREDENTIAL_READINESS_LABELS, MNT_CURATED_VIEW_LABELS, MNT_SCOPE_LABELS, mntHumanize, mntKindLabel } from './maintenance-workspace.mjs';
  var MNT_CURATED_VIEWS=Object.keys(MNT_CURATED_VIEW_LABELS);
  var MNT_FACET_ORDER=[
    "scope","environment","project","projectType","kind","adapter","consumer","carrier","provenance","packageManager",
    "versionState","guidance","dependencyRole","conflict","credentialReadiness","channel",
    "evidenceFields","recentlyChanged",
  ];
  var MNT_FACET_LABEL={
    scope:"Scope",environment:"Environment",project:"Project",projectType:"Project type",kind:"Type",adapter:"Adapters",consumer:"Hosts",
    carrier:"Carrier",provenance:"Source",packageManager:"Package manager",versionState:"Version state",
    guidance:"Guidance",dependencyRole:"Dependency role",conflict:"Conflict",
    credentialReadiness:"Credential",channel:"Channel",evidenceFields:"Evidence available",
    recentlyChanged:"Recently changed",
  };
  var MNT_ADAPTER_LABELS={claude:'Claude',codex:'Codex',opencode:'OpenCode',hermes:'Hermes'};
  var MNT_DEPENDENCY_ROLE_LABEL={"depends-on":"Depends on","depended-on-by":"Depended on by","none":"No dependency role"};

  function mntFacetLabelsFor(facet){
    var labels=MNT.query&&MNT.query.facetLabels;
    return labels?labels[facet]:null;
  }
  export function mntFacetValueLabel(facet,value){
    if(facet==="adapter"||facet==="consumer")return MNT_ADAPTER_LABELS[value]||mntHumanize(value);
    if(facet==="projectType")return ({git:'Git',folder:'Folder',worktree:'Worktree',unknown:'Not checked'})[value]||'Not checked';
    if(facet==="scope")return MNT_SCOPE_LABELS[value]||mntHumanize(value);
    if(facet==="kind")return mntKindLabel(value);
    if(facet==="guidance")return MNT_GUIDANCE_LANE_LABELS[value]||mntHumanize(value);
    if(facet==="conflict")return (MNT_CONFLICT_EXPLANATIONS[value]&&MNT_CONFLICT_EXPLANATIONS[value].label)||mntHumanize(value);
    if(facet==="credentialReadiness")return MNT_CREDENTIAL_READINESS_LABELS[value]||mntHumanize(value);
    if(facet==="dependencyRole")return MNT_DEPENDENCY_ROLE_LABEL[value]||mntHumanize(value);
    if(facet==="recentlyChanged")return value==="true"?"Recently changed":mntHumanize(value);
    if(facet==="environment"||facet==="project"){
      var named=mntFacetLabelsFor(facet);
      var label=named&&named[value];
      if(label)return label;
      return value.length>14?value.slice(0,10)+"…":value;
    }
    return mntHumanize(value);
  }

  var mntDisclosureState={},mntFacetNeedles={};
  function mntDisclosure(key,label,body,initial){
    var open=Object.prototype.hasOwnProperty.call(mntDisclosureState,key)?mntDisclosureState[key]:initial;
    return '<details class="mnt-filter-disclosure" data-mnt-disclosure="'+esc(key)+'"'+(open?' open':'')+'><summary>'+esc(label)+'</summary>'+body+'</details>';
  }
  function mntViewButton(view){
    return '<li><button type="button" class="mnt-view-btn'+(MNT.view===view?' on':'')+'" data-mnt-view="'+esc(view)
      +'" aria-pressed="'+(MNT.view===view)+'">'+mntIcon(view==='recently-changed'?'clock':view==='conflicts'?'info':'across')
      +esc(MNT_CURATED_VIEW_LABELS[view])+'</button></li>';
  }
  export function renderMntViews(){
    var el=document.getElementById('mnt-views');if(!el)return;
    var common=['all','conflicts','recently-changed'];
    var rest=MNT_CURATED_VIEWS.filter(function(view){return common.indexOf(view)<0;});
    el.innerHTML='<div class="mnt-refine-heading"><h3>Refine</h3><button type="button" class="mnt-clear-all" data-mnt-reset>Reset</button></div>'
      +'<ul>'+common.map(mntViewButton).join('')+'</ul>'
      +mntDisclosure('views','More views','<ul>'+rest.map(mntViewButton).join('')+'</ul>',rest.indexOf(MNT.view)>=0);
  }

  // ── Facets + chips ───────────────────────────────────────────────────────
  function mntFacetSelected(facet,value){return (MNT.facets[facet]||[]).indexOf(value)>=0;}
  function renderMntFacetGroup(facet,counts){
    var values=Object.keys(counts||{}).sort(function(a,b){return mntFacetValueLabel(facet,a).localeCompare(mntFacetValueLabel(facet,b));});
    if(!values.length)return '';
    var label=MNT_FACET_LABEL[facet]||mntHumanize(facet),needle=mntFacetNeedles[facet]||'';
    var search=values.length>6||needle?'<input type="search" class="mnt-facet-search" data-mnt-facet-search="'+esc(facet)+'" aria-label="Find '+esc(label.toLowerCase())+' options" placeholder="Find '+esc(label.toLowerCase())+'…" value="'+esc(needle)+'">':'';
    var body=(facet==='adapter'?'<p class="mnt-filter-note">Associated resources; zero means none observed.</p>':'')+'<fieldset class="mnt-facet-group"><legend class="sr-only">'+esc(label)+'</legend>'+search+'<div class="mnt-facet-options">'
      +values.map(function(value){
        var checked=mntFacetSelected(facet,value),name=mntFacetValueLabel(facet,value);
        return '<label class="mnt-facet-opt"'+(!checked&&needle&&name.toLowerCase().indexOf(needle.toLowerCase())<0?' hidden':'')+'><input type="checkbox" data-mnt-facet="'+esc(facet)+'" value="'+esc(value)+'"'+(checked?' checked':'')+'> <span>'+esc(name)+(facet==='project'?mntProjectDesignation(value):'')+'</span><span class="mono">'+esc(counts[value])+'</span></label>';
      }).join('')+'</div></fieldset>';
    var selected=(MNT.facets[facet]||[]).length;
    return mntDisclosure(facet,label+(selected?' ('+selected+')':''),body,['project','kind','consumer','adapter'].indexOf(facet)>=0||selected>0);
  }
  export function renderMntFacets(){
    var counts=Object.assign({},(MNT.query&&MNT.query.facetCounts)||{});
    counts.adapter=Object.assign({hermes:0},counts.adapter||{});
    var common=['project','projectType','kind','consumer','adapter'];
    var other=MNT_FACET_ORDER.filter(function(facet){return common.indexOf(facet)<0;});
    var advanced=other.map(function(facet){return renderMntFacetGroup(facet,counts[facet]);}).join('');
    var active=other.some(function(facet){return (MNT.facets[facet]||[]).length>0;});
    var html=common.map(function(facet){return renderMntFacetGroup(facet,counts[facet]);}).join('')
      +(advanced?mntDisclosure('advanced','More filters',advanced,active):'');
    var target=document.getElementById('mnt-facets');if(target)target.innerHTML=html;
    var sheet=document.getElementById('mnt-facets-sheet-body');
    if(sheet)sheet.innerHTML=document.getElementById('mnt-views').innerHTML+html;
  }
  export function mntWireFilterPresentation(){
    ['mnt-side','mnt-facets-sheet-body'].forEach(function(id){
      var root=document.getElementById(id);if(!root)return;
      root.addEventListener('toggle',function(event){
        var key=event.target.getAttribute&&event.target.getAttribute('data-mnt-disclosure');
        if(key)mntDisclosureState[key]=event.target.open;
      },true);
      root.addEventListener('input',function(event){
        var input=event.target,facet=input.getAttribute&&input.getAttribute('data-mnt-facet-search');if(!facet)return;
        mntFacetNeedles[facet]=input.value;
        input.parentElement.querySelectorAll('.mnt-facet-opt').forEach(function(label){label.hidden=!label.querySelector('input:checked')&&label.textContent.toLowerCase().indexOf(input.value.toLowerCase())<0;});
      });
    });
  }

  function mntActiveFacetEntries(){
    var out=[];
    Object.keys(MNT.facets||{}).forEach(function(facet){
      (MNT.facets[facet]||[]).forEach(function(value){out.push({facet:facet,value:value});});
    });
    return out;
  }
  export function renderMntChips(){
    var el=document.getElementById("mnt-chips");if(!el)return;
    var entries=mntActiveFacetEntries();
    if(!entries.length){el.innerHTML="";return;}
    el.innerHTML=entries.map(function(entry){
      return '<span class="mnt-chip">'+esc(MNT_FACET_LABEL[entry.facet]||entry.facet)+": "
        +esc(mntFacetValueLabel(entry.facet,entry.value))
        +'<button type="button" data-mnt-chip-facet="'+esc(entry.facet)+'" data-mnt-chip-value="'
        +esc(entry.value)+'" aria-label="Remove '+esc(mntFacetValueLabel(entry.facet,entry.value))
        +' filter">×</button></span>';
    }).join("")+'<button type="button" class="mnt-clear-all" id="mnt-clear-all">Clear all</button>';
  }


export function mntResetFacetSearch(){mntFacetNeedles={};}
