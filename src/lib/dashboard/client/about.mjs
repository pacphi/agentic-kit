// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { ABOUT_SECTIONS, LS_ABOUT_NUDGE, RANK, activeTab, esc, scrollToAboutSection, setTab } from './bootstrap.mjs';
import { sourceHostIcon } from './usage.mjs';

  // ══ About area (ADR-0026) ══════════════════════════════════════════════════
  // Editorial content comes from the versioned directory below; runtime facts
  // come from the /api/status payload this file already polls. No endpoint, no
  // second fetch — the join happens here, and its absence is rendered, not
  // hidden.
  var ABOUT = []; // PLACEHOLDER:ABOUT_JS

  // Directory category -> the page section that carries it. Quality, Safety and
  // Knowledge are three one-card categories that read as one cluster, so they
  // share a section; the directory keeps them distinct because they are
  // distinct concerns, and the page groups them because they scan better that way.
  var ABOUT_SECTION_OF={hosts:"hosts","engine-memory":"engine",quality:"quality",
    safety:"quality",knowledge:"quality",kit:"kit",configured:"configured"};

  // Which `ak status` rows are unambiguously ABOUT a given component.
  //   host      one host id inside the shared "hosts" subsystem, matched on the
  //             row's leading word (those rows are "<host> …" by construction).
  //   versions  one package inside the shared "versions" subsystem, matched the
  //             same way, because that subsystem carries every managed package.
  //   subs      whole subsystems that belong to this component alone.
  // A component with NO entry here — or one whose rows are simply absent from
  // this payload — degrades to "state unknown". That is the honest reading: an
  // unjoined key is an unmeasured fact, never a satisfied one. The permission
  // allowlist is the standing example: ak emits no permissions row today.
  var ABOUT_JOIN={
    "hosts.claude":{host:"claude"},
    "hosts.codex":{host:"codex"},
    "hosts.opencode":{host:"opencode"},
    "ruflo":{versions:"ruflo"},
    "agentdb":{subs:["agentdb"]},
    "deja-vu":{subs:["deja-vu"]},
    "agentic-qe":{subs:["aqe"],versions:"agentic-qe"},
    "security":{subs:["security"]},
    "ruvnet-brain":{subs:["ruvnet-brain"]},
    "self":{subs:["self"]},
    "mcp":{subs:["mcp","codex-mcp"]},
    "blocks":{subs:["blocks"]},
    // Two statusline surfaces, one card: the worst of the pair drives the chip,
    // or Codex's line could be broken while the card reads green.
    "statusline":{subs:["statusline","codex-statusline"]},
    "routing":{subs:["routing"]},
    "daemons":{subs:["daemons"]}
  };
  var ABOUT_WORD={ok:"installed",warn:"needs attention",fail:"not working"};
  var ABOUT_WORD_CONF={ok:"configured",warn:"needs attention",fail:"not working"};

  function aboutLead(msg,word){
    return String(msg||"").toLowerCase().indexOf(String(word).toLowerCase()+" ")===0;
  }
  function aboutRows(rows,join){
    var out=[];
    for(var i=0;i<rows.length;i++){
      var r=rows[i]||{},sub=r.subsystem;
      if(join.host&&sub==="hosts"&&aboutLead(r.message,join.host))out.push(r);
      else if(join.versions&&sub==="versions"&&aboutLead(r.message,join.versions))out.push(r);
      else if(join.subs&&join.subs.indexOf(sub)>=0)out.push(r);
    }
    return out;
  }
  function aboutState(entry,data){
    var configured=entry.category==="configured";
    if(!data||!Array.isArray(data.rows))
      return {state:"unknown",word:"state unknown",title:"the dashboard could not read /api/status",detail:null};
    var join=ABOUT_JOIN[entry.detectionKey||entry.subsystem||""];
    if(!join)
      return {state:"unknown",word:"state unknown",title:"ak status reports no row for this surface yet",detail:null};
    var rows=aboutRows(data.rows,join);
    if(!rows.length)
      return {state:"unknown",word:"state unknown",title:"no ak status row reported this on this machine",detail:null};
    var level="info",worst=null,titles=rows.map(function(r){return r.level+": "+r.message;}).join(" \u00b7 ");
    for(var i=0;i<rows.length;i++){
      if((RANK[rows[i].level]||0)>=(RANK[level]||0)&&rows[i].level!=="info"){level=rows[i].level;worst=rows[i];}
    }
    // Only info rows means the subsystem stated a fact without a verdict — it
    // told us something, but not that this component is working. Claiming
    // "installed" from that would be inventing the one thing we were not told.
    if(level==="info")return {state:"unknown",word:"state unknown",title:titles,detail:null};
    var state=(level==="warn"||level==="fail")?level:(configured?"configured":"ok");
    var word=(configured?ABOUT_WORD_CONF:ABOUT_WORD)[level==="warn"||level==="fail"?level:"ok"];
    return {
      state:state,word:word,title:titles,
      // Only a problem earns a line of its own on the card; a healthy component
      // says so in four words and gets out of the way.
      detail:(worst&&(level==="warn"||level==="fail"))?worst:null
    };
  }
  // The version chip's fact source is the drift array /api/status already
  // carries, keyed by package name. A component with no drift entry (Claude
  // Code is externally installed; aidefence ships inside ruflo) shows its state
  // WITHOUT a version rather than a version scraped out of prose.
  function aboutVersion(entry,data){
    if(!entry.npmPackage||!data||!Array.isArray(data.drift))return null;
    for(var i=0;i<data.drift.length;i++){
      var d=data.drift[i];
      if(d&&d.pkg===entry.npmPackage&&d.installed)return d;
    }
    return null;
  }
  function aboutVerLabel(v){
    v=String(v==null?"":v);
    return /^v/i.test(v)?v:"v"+v;
  }
  function aboutTile(icon){
    if(icon&&icon.kind==="official")
      return '<span class="ab-tile" data-mark="'+esc(icon.ref)+'" aria-hidden="true">'+sourceHostIcon(icon.ref)+"</span>";
    // The hue is a token NAME chosen by the directory, never a colour value —
    // the pattern test is what keeps it that way if the directory ever grows.
    var hue=(icon&&/^--[a-z-]+$/.test(String(icon.hue||"")))?icon.hue:"--info";
    return '<span class="ab-tile ab-mg" style="background:var('+hue+')" aria-hidden="true">'
      +esc((icon&&icon.ref)||"?")+"</span>";
  }
  function aboutCard(entry,data){
    var st=aboutState(entry,data),ver=aboutVersion(entry,data);
    // Release-tagged tools (the Brain) already record their leading "v"; npm
    // packages do not. Prefixing unconditionally produced "vv4.0.7".
    var chipText=st.word+(ver?" \u00b7 "+aboutVerLabel(ver.installed):"");
    var detail="";
    if(st.detail){
      detail='<p class="ab-detail" data-level="'+esc(st.detail.level)+'">'+esc(st.detail.message)
        +(st.detail.fix?' <code>'+esc(st.detail.fix)+"</code>":"")+"</p>";
    }else if(ver&&ver.outdated&&ver.latest){
      detail='<p class="ab-detail">update available \u2014 '+esc(aboutVerLabel(ver.latest))+' <code>ak sync</code></p>';
    }
    var tail="";
    if(entry.links&&entry.links.length){
      tail='<div class="ab-links">'+entry.links.map(function(l){
        // https only, and outbound only: these are plain anchors the reader
        // clicks. Nothing on this page ever fetches them (ADR-0025/0026's
        // zero-egress line), which is why there is no preview, no favicon,
        // and no link check in the browser.
        if(!l||!/^https:\/\//.test(String(l.url||"")))return "";
        return '<a class="ab-pill" href="'+esc(l.url)+'" target="_blank" rel="noreferrer noopener">'
          +esc(l.label)+" &#8599;</a>";
      }).join("")+"</div>";
    }else if(entry.manage){
      tail='<div class="ab-manage">manage: '+esc(entry.manage)+"</div>";
    }
    return '<article class="ab-card'+(entry.category==="kit"?" ab-wide":"")+'">'
      +'<div class="ab-head">'+aboutTile(entry.icon)
      +'<span class="ab-name"><b>'+esc(entry.name)+"</b>"
      +'<span class="ab-state" data-state="'+esc(st.state)+'" title="'+esc(st.title)+'">'+esc(chipText)+"</span>"
      +"</span></div>"
      +'<span class="ab-tagline">'+esc(entry.tagline)+"</span>"
      +'<p class="ab-body">'+esc(entry.paragraph)+"</p>"
      +detail+tail
    +"</article>";
  }
  export function renderAbout(data){
    var buckets={},i,entry,section;
    for(i=0;i<ABOUT_SECTIONS.length;i++)buckets[ABOUT_SECTIONS[i]]=[];
    var packaged=0,configured=0,_detected=0,_joined=false;
    for(i=0;i<ABOUT.length;i++){
      entry=ABOUT[i];
      section=ABOUT_SECTION_OF[entry.category];
      if(!buckets[section])continue;
      buckets[section].push(aboutCard(entry,data));
      if(entry.category==="configured")configured++;
      else{
        packaged++;
        var st=aboutState(entry,data);
        if(st.state!=="unknown")_joined=true;
        if(st.state==="ok")_detected++;
      }
    }
    for(i=0;i<ABOUT_SECTIONS.length;i++){
      var el=document.getElementById("ab-cards-"+ABOUT_SECTIONS[i]);
      if(el)el.innerHTML=buckets[ABOUT_SECTIONS[i]].join("");
    }
    var lede=document.getElementById("ab-hero-lede");
    if(lede){
      // Counts describe the DIRECTORY (what ak manages), which is a release
      // fact and true on any machine. Per-component state lives on each card's
      // own chip; an aggregate tally here would just restate it less precisely.
      lede.innerHTML="agentic-kit manages <b>"+packaged+" components</b> and <b>"+configured
        +" configurations</b>. This page says what each one is, in plain words \u2014 and where to "
        +"read more. Health lives in Overview, spend in Usage, activity in Observability; here, "
        +"everything just introduces itself.";
    }
    if(aboutScrollPending&&activeTab==="about"){aboutScrollPending=false;scrollToAboutSection();}
  }

  // The first-run nudge. Overview stays the landing view; this points at About
  // once and remembers being dismissed, in the same localStorage the poll and
  // theme preferences use. Opening About counts as dismissing it: the tip has
  // done its job and should not greet a returning reader.
  function aboutNudgeDismissed(){
    try{return localStorage.getItem(LS_ABOUT_NUDGE)==="1";}catch(e){return false;}
  }
  function dismissAboutNudge(){
    try{localStorage.setItem(LS_ABOUT_NUDGE,"1");}catch(e){}
    var el=document.getElementById("about-nudge");
    if(el)el.hidden=true;
  }
  export function wireAboutNudge(){
    var el=document.getElementById("about-nudge");
    if(el&&!aboutNudgeDismissed()&&activeTab!=="about")el.hidden=false;
    var go=document.getElementById("about-nudge-go");
    if(go)go.addEventListener("click",function(){dismissAboutNudge();setTab("about");});
    var x=document.getElementById("about-nudge-x");
    if(x)x.addEventListener("click",dismissAboutNudge);
  }

