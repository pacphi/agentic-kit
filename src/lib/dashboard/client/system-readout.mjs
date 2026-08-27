// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { esc } from './bootstrap.mjs';
import { fmtNum, fmtTok } from './usage.mjs';

  // ══ System area (ADR-0025) ════════════════════════════════════════════════
  // One payload (GET /api/system), five sub-views. The cheap tier arrives on
  // open; the deep tier is whatever the last user-triggered scan measured,
  // carried forward with ITS timestamp. Nothing here ever renders an unmeasured
  // quantity as 0 — mhtml() has no code path that can.
  export var SYSTEM=null, systemBusy=false, systemPollTimer=null;
  // Consumers view state. consMode re-shapes rows the payload already carries;
  // whether project trees were MEASURED is the server's fact, read back off the
  // payload rather than mirrored here, so the chip can never claim a scope the
  // numbers below it were not measured with.
  export var consMode="ranked";

  // ── Measurement vocabulary (walk.mjs's, read-side) ──
  export function mval(m){return m&&typeof m.value==="number"&&isFinite(m.value)?m.value:null;}
  export function unkHtml(reason,never){
    return '<span class="sy-unk" title="'+esc(reason||"not measured")+'">'
      +(never?"not measured yet":"unavailable")+"</span>";
  }
  // The ONLY renderer for a Measurement. A missing field is "not measured yet"
  // (the deep tier has never run); a failed one is "unavailable" with its
  // reason on hover; a capped or partially-degraded one is prefixed with a
  // "at least" sign, because those figures are floors and a bare total would
  // read as a ceiling.
  export function mhtml(m,fmt){
    if(!m||typeof m!=="object")return unkHtml("this section has not been deep-scanned yet",true);
    if(m.status==="unknown"||m.value==null)return unkHtml(m.reason,false);
    return (m.partial?"&#8805;&#8239;":"")+esc((fmt||fmtNum)(m.value));
  }
  export function fmtBytes(n){
    n=Number(n)||0;
    var abs=Math.abs(n);
    if(abs>=1e12)return (n/1e12).toFixed(2)+" TB";
    if(abs>=1e9)return (n/1e9).toFixed(2)+" GB";
    if(abs>=1e6)return (n/1e6).toFixed(1)+" MB";
    if(abs>=1e3)return (n/1e3).toFixed(0)+" KB";
    return Math.round(n)+" B";
  }
  export function bytesPair(n){
    n=Number(n)||0;
    var abs=Math.abs(n);
    if(abs>=1e12)return {n:(n/1e12).toFixed(2),u:"TB"};
    if(abs>=1e9)return {n:(n/1e9).toFixed(2),u:"GB"};
    if(abs>=1e6)return {n:(n/1e6).toFixed(1),u:"MB"};
    if(abs>=1e3)return {n:(n/1e3).toFixed(0),u:"KB"};
    return {n:String(Math.round(n)),u:"B"};
  }
  export function fmtDur(ms){
    ms=Number(ms)||0;
    var m=Math.floor(ms/60000),h=Math.floor(m/60);
    if(h>=24)return Math.floor(h/24)+"d "+(h%24)+"h";
    return h?(h+"h "+(m%60)+"m"):(m+"m");
  }
  // Series tokens are chosen from a fixed set — never interpolated from data —
  // so nothing in a payload can reach a style attribute as a colour.
  export var SERIES=["var(--s1)","var(--s2)","var(--s3)","var(--s4)"];
  // The project and agentic-kit keys are storage-root owners, not hosts, but they DO
  // get growth series — and without entries here both rendered in the same
  // undifferentiated grey, so two of the five panels were unreadable.
  var HOST_SERIES={claude:"var(--s1)",codex:"var(--s2)",opencode:"var(--s3)",
    project:"var(--s4)","agentic-kit":"var(--purple)"};
  /** A YYYY-MM-DD day key as a compact axis tick (MM-DD). Null-safe.
   *  No regex: this whole file is a template literal, so a backslash class
   *  would be eaten before it ever reached the browser. */
  export function dayTick(day){
    var d=String(day||"");
    return (d.length===10&&d.charAt(4)==="-"&&d.charAt(7)==="-")?d.slice(5):d;
  }
  var CAT_SERIES={transcripts:"var(--s1)","ledgers-and-logs":"var(--s2)",
    "learning-stores":"var(--s3)","kit-caches":"var(--s4)"};
  // The catalog's kind ids are wire identifiers; these are what a reader sees.
  // An unknown future kind falls through as its own id rather than vanishing.
  export var KIND_LABEL={skill:"skills",agent:"agents",command:"commands",plugin:"plugins",mcpServer:"MCP"};
  export var KIND_PLURAL={skill:"skills",agent:"agents",command:"commands",plugin:"plugins",mcpServer:"MCP servers"};
  export function hostColor(h){return HOST_SERIES[h]||"var(--dim)";}
  export function catColor(k){return CAT_SERIES[k]||"var(--dim)";}
  export function sysEmpty(msg){return '<div class="empty">'+esc(msg)+"</div>";}
  export var NOT_SCANNED="not measured yet \u2014 press Rescan to run a deep scan.";

  // ── odometer readout ──
  // Each digit rolls from 0 to its target. Under prefers-reduced-motion the
  // page-wide transition kill makes the same code paint the final value at once.
  // Row height of one digit, in px. MUST equal .od's height in styles.mjs: the
  // stack is scrolled by whole rows, so a mismatch shows two half digits. 30
  // because the digits are the Scorecard KPI's 27px — one type scale for both
  // KPI bands, since they are one click apart.
  var OD_H=30;
  function mountOdometers(root){
    var els=(root||document).querySelectorAll(".od[data-od]");
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el.getAttribute("data-mounted")==="1")continue;
      el.setAttribute("data-mounted","1");
      var s=String(el.getAttribute("data-od")||""),html="",c,d;
      for(c=0;c<s.length;c++){
        var ch=s.charAt(c);
        if(ch>="0"&&ch<="9"){
          html+='<span class="dcol"><span class="dstack" data-d="'+ch+'">';
          for(d=0;d<=9;d++)html+="<span>"+d+"</span>";
          html+="</span></span>";
        }else html+='<span class="lit">'+esc(ch)+"</span>";
      }
      el.innerHTML=html;
      (function(node){
        var stacks=node.querySelectorAll(".dstack");
        var apply=function(){
          for(var k=0;k<stacks.length;k++)
            stacks[k].style.transform="translateY("+(-OD_H*Number(stacks[k].getAttribute("data-d")))+"px)";
        };
        if(window.requestAnimationFrame)requestAnimationFrame(function(){requestAnimationFrame(apply);});
        else apply();
      })(el);
    }
  }
  /** A KPI tile. The subs argument is an ARRAY of facts, one per line — not a
   *  dot-joined string. The old single line claimed to be one line of facts but had no
   *  way to enforce it: three figures in a 250px tile wrapped wherever the text
   *  ran out, so the separators ended up mid-line and a fact could break across
   *  two rows. Stacking makes the wrap deliberate and each fact scannable. */
  function kpiCard(label,valueHtml,subs){
    var list=[].concat(subs||[]),html="",i;
    for(i=0;i<list.length;i++)html+='<span class="sub-l">'+list[i]+"</span>";
    return '<div class="sy-kpi"><span class="lbl">'+esc(label)+"</span>"
      +'<div class="val">'+valueHtml+"</div>"
      +'<div class="sub">'+html+"</div></div>";
  }
  function odBytes(m){
    if(!m||m.status==="unknown"||m.value==null)return mhtml(m,fmtBytes);
    var p=bytesPair(m.value);
    return (m.partial?'<span class="unit">&#8805;</span>':"")
      +'<span class="od" data-od="'+esc(p.n)+'"></span><span class="unit">'+p.u+"</span>";
  }
  function odCount(m){
    if(!m||m.status==="unknown"||m.value==null)return mhtml(m);
    return (m.partial?'<span class="unit">&#8805;</span>':"")
      +'<span class="od" data-od="'+esc(String(Math.round(m.value)))+'"></span>';
  }

  // ── charts (inline SVG, built from the payload; no image, no remote asset) ──
  // The disk denominator is a horizontal meter, not a radial: the question is
  // "how much of this disk is the toolchain", one ratio, and a ratio does not
  // need a card's worth of height. A segment thinner than 0.4% of the bar is not
  // drawn — but its share is always STATED, because padding a sliver up to a
  // visible width would draw a picture that disagrees with its own caption.
  function diskSeg(bytes,total,color,label,opacity){
    var f=total>0?Math.max(0,Math.min(1,bytes/total)):0;
    if(f<=0.004)return "";
    return '<i style="width:'+(f*100).toFixed(2)+"%;background:"+color
      +(opacity?";opacity:"+opacity:"")+'" title="'+esc(label)+'"></i>';
  }
  function diskBand(installBytes,dataBytes,totalBytes,freeBytes){
    var used=installBytes+dataBytes;
    var share=totalBytes>0?(used/totalBytes)*100:null;
    var otherUsed=(freeBytes==null||totalBytes<=0)?null:Math.max(0,totalBytes-freeBytes-used);
    var bar=diskSeg(installBytes,totalBytes,"var(--accent)",
        "install \u00b7 "+fmtBytes(installBytes))
      +diskSeg(dataBytes,totalBytes,"var(--accent)","retained data \u00b7 "+fmtBytes(dataBytes),".5")
      +(otherUsed==null?"":diskSeg(otherUsed,totalBytes,"var(--dim)",
        "everything else on this disk \u00b7 "+fmtBytes(otherUsed),".55"));
    var facts='<b>'+esc(fmtBytes(used))+"</b> toolchain ("
      +esc(fmtBytes(installBytes))+" install + "+esc(fmtBytes(dataBytes))+" retained)"
      +(share==null?" \u00b7 disk size unmeasured"
        :" \u00b7 "+esc(share<0.1?"<0.1%":share.toFixed(share<10?1:0)+"%")
          +" of "+esc(fmtBytes(totalBytes)))
      +" \u00b7 "+(freeBytes==null?'<span class="sy-unk">free space unmeasured</span>'
        :"<b>"+esc(fmtBytes(freeBytes))+"</b> free");
    // No separate legend row: the facts line already names install, retained and
    // free, and each segment carries its own tooltip. A legend restating them
    // would be a second line of height buying nothing.
    return '<div class="sy-diskband"><span class="dk-lbl">disk</span>'
      +'<span class="dk-meter" role="img" aria-label="'+esc(fmtBytes(used)+" of "
        +(totalBytes>0?fmtBytes(totalBytes):"an unmeasured disk")+" used by the toolchain")+'">'
      +bar+"</span>"
      +'<span class="dk-facts">'+facts+"</span></div>";
  }
  export function svgDonut(slices,total,unit){
    var C=2*Math.PI*56,off=0,arcs="";
    for(var i=0;i<slices.length;i++){
      var frac=total>0?(slices[i].value/total):0,len=C*frac;
      arcs+='<circle r="56" fill="none" stroke="'+slices[i].color+'" stroke-width="20" '
        +'stroke-dasharray="'+len.toFixed(2)+" "+(C-len).toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)+'">'
        +"<title>"+esc(slices[i].label+" \u00b7 "+fmtBytes(slices[i].value))+"</title></circle>";
      off+=len;
    }
    var p=bytesPair(total);
    return '<svg viewBox="0 0 150 150" width="150" role="img" aria-label="'+esc(unit)+'">'
      +'<g transform="translate(75 75) rotate(-90)">'+arcs+"</g>"
      +'<text class="big" text-anchor="middle" x="75" y="72">'+esc(p.n)+"</text>"
      +'<text text-anchor="middle" x="75" y="88">'+esc(p.u+" retained")+"</text>"
    +"</svg>";
  }
  // A sparkline with SCALED AXES. The bare version drew a shape with no
  // magnitude on it, so five of them side by side looked comparable when one
  // could be a thousand times the others — the eye reads the silhouette, and
  // every silhouette is normalised to its own max. The axes option adds the y peak and
  // the x endpoints, which is the minimum that makes two panels comparable.
  // Gutters are reserved in the viewBox rather than overlaid, so a long byte
  // label can never sit on top of the plot.
  export function svgArea(values,color,label,axes){
    if(!values.length)return sysEmpty("no days measured");
    var PAD_L=axes?34:0,PAD_B=axes?12:1,W=180,H=54;
    var plotW=W-PAD_L,plotH=H-PAD_B-4;
    var max=Math.max.apply(null,values)||1,pts=[],i;
    for(i=0;i<values.length;i++){
      var x=PAD_L+(values.length===1?plotW:(i/(values.length-1))*plotW);
      var y=4+plotH-(values[i]/max)*plotH;
      pts.push(x.toFixed(1)+","+y.toFixed(1));
    }
    var line=pts.join(" "),last=pts[pts.length-1].split(","),base=(4+plotH).toFixed(1);
    var axisHtml="";
    if(axes){
      var xFirst=(axes.firstDay||""),xLast=(axes.lastDay||"");
      axisHtml=
        // y axis: peak and zero. Two ticks, not a scale — a five-tick axis in a
        // 54px band is unreadable and the peak is the number that matters.
        '<text class="ax" x="'+(PAD_L-4)+'" y="9" text-anchor="end">'+esc(axes.peakLabel||"")+"</text>"
        +'<text class="ax" x="'+(PAD_L-4)+'" y="'+base+'" text-anchor="end">0</text>'
        +'<polyline class="gridline" points="'+PAD_L+',4 '+PAD_L+","+base+'"/>'
        +'<text class="ax" x="'+PAD_L+'" y="'+(H-2)+'">'+esc(xFirst)+"</text>"
        +'<text class="ax" x="'+W+'" y="'+(H-2)+'" text-anchor="end">'+esc(xLast)+"</text>";
    }
    return '<svg viewBox="0 0 '+W+" "+H+'" role="img" aria-label="'+esc(label)+'">'
      +'<polyline class="gridline" points="'+PAD_L+","+base+" "+W+","+base+'"/>'
      +'<polygon fill="'+color+'" opacity=".18" points="'+line+" "+W+","+base+" "+PAD_L+","+base+'"/>'
      +'<polyline fill="none" stroke="'+color+'" stroke-width="2" points="'+line+'"/>'
      +'<circle cx="'+last[0]+'" cy="'+last[1]+'" r="3" fill="'+color+'"/>'
      +axisHtml
      +"<title>"+esc(label)+"</title>"
    +"</svg>";
  }
  // Geometry constants, not magic numbers: the plot radius is what the data
  // occupies and the label radius is outside it, both chosen so the widest
  // label ("commands") still fits inside the viewBox at either flank.
  var RADAR={cx:150,cy:142,r:90,label:112};
  function radarPoint(axis,axes,r){
    var a=-Math.PI/2+(2*Math.PI*axis)/axes;
    return [(RADAR.cx+r*Math.cos(a)).toFixed(1),(RADAR.cy+r*Math.sin(a)).toFixed(1)];
  }
  function radarRing(axes,r){
    var pts=[];
    for(var i=0;i<axes;i++)pts.push(radarPoint(i,axes,r).join(","));
    return pts.join(" ");
  }
  export function svgRadar(axes,series){
    if(!axes.length||!series.length)return sysEmpty("nothing measured to compare");
    var n=axes.length,g="",i,j;
    for(i=1;i<=4;i++)g+='<polygon class="gridline" points="'+radarRing(n,(RADAR.r/4)*i)+'"/>';
    for(i=0;i<n;i++){
      var tip=radarPoint(i,n,RADAR.r);
      g+='<line class="gridline" x1="'+RADAR.cx+'" y1="'+RADAR.cy+'" x2="'+tip[0]+'" y2="'+tip[1]+'"/>';
    }
    for(i=0;i<series.length;i++){
      var pts=[];
      for(j=0;j<n;j++){
        var mx=axes[j].max||0,v=series[i].values[j];
        pts.push(radarPoint(j,n,mx>0&&v!=null?(v/mx)*RADAR.r:0).join(","));
      }
      g+='<polygon fill="'+series[i].color+'" opacity=".14" stroke="'+series[i].color
        +'" stroke-width="2" points="'+pts.join(" ")+'"><title>'+esc(series[i].tip)+"</title></polygon>";
    }
    for(i=0;i<n;i++){
      var lp=radarPoint(i,n,RADAR.label);
      var dx=Number(lp[0])-RADAR.cx;
      var anchor=dx>6?"start":(dx<-6?"end":"middle");
      g+='<text x="'+lp[0]+'" y="'+lp[1]+'" text-anchor="'+anchor+'" dominant-baseline="middle">'
        +esc(axes[i].label)+"</text>";
    }
    return '<svg viewBox="0 0 300 274" role="img" aria-label="per-host inventory profile, each axis normalized to its own maximum">'+g+"</svg>";
  }

  // ── data shaping ──
  export function storageHostTotals(storage){
    var totals={},cats=(storage&&storage.categories)||[],i,j;
    for(i=0;i<cats.length;i++){
      var kids=cats[i].children||[];
      for(j=0;j<kids.length;j++){
        var v=mval(kids[j].bytes);
        if(v==null)continue;
        totals[kids[j].key]=(totals[kids[j].key]||0)+v;
      }
    }
    return totals;
  }
  function topConsumers(d,limit){
    var rows=[],i,j;
    var cats=(d.storage&&d.storage.categories)||[];
    for(i=0;i<cats.length;i++){
      var kids=cats[i].children||[];
      for(j=0;j<kids.length;j++){
        var v=mval(kids[j].bytes);
        if(v==null||v<=0)continue;
        rows.push({label:kids[j].key+" "+cats[i].key,bytes:v,color:hostColor(kids[j].host||kids[j].key)});
      }
    }
    var tools=(d.install&&d.install.tools)||[];
    for(i=0;i<tools.length;i++){
      var tb=mval(tools[i].bytes);
      if(tb!=null&&tb>0)rows.push({label:tools[i].label+" install tree",bytes:tb,color:"var(--dim)"});
    }
    var caches=(d.install&&d.install.sharedCaches)||[];
    for(i=0;i<caches.length;i++){
      var cb=mval(caches[i].bytes);
      if(cb!=null&&cb>0)rows.push({label:caches[i].label,bytes:cb,color:"var(--dim)"});
    }
    rows.sort(function(a,b){return b.bytes-a.bytes;});
    return rows.slice(0,limit||6);
  }
  // Lines of code across the catalog. Projects whose count is unmeasured are
  // EXCLUDED from the sum and named in the caption, so the total is an honest
  // floor over the projects that were counted rather than a figure that
  // silently treats an unreadable project as containing no code.
  /** The projects tile's sub-lines, one fact per entry — led by the on-disk
   *  count, which the headline no longer carries. */
  function locSummary(projects){
    var onDisk=projects&&projects.onDisk?[mhtml(projects.onDisk)+" on disk"]:[];
    if(!projects)return [unkHtml("projects have not been deep-scanned yet",true)+" lines"];
    var list=projects.projects||[],total=0,counted=0,i;
    for(i=0;i<list.length;i++){
      var v=mval(list[i].loc&&list[i].loc.total);
      if(v==null)continue;
      total+=v; counted++;
    }
    if(!counted)return onDisk.concat([unkHtml("no project reported a line count",false)+" lines"]);
    return onDisk.concat(["&#8776;"+esc(fmtTok(total))+" lines",
      esc(counted+"/"+list.length)+" counted"]);
  }
  function rankedBars(rows){
    if(!rows.length)return sysEmpty(NOT_SCANNED);
    var max=rows[0].bytes||1,html="",i;
    for(i=0;i<rows.length;i++){
      html+='<div class="sy-bar"><span class="n" title="'+esc(rows[i].label)+'">'+esc(rows[i].label)+"</span>"
        +'<div class="sy-track"><i class="sy-fill" style="width:'+Math.max(1,(rows[i].bytes/max)*100).toFixed(1)
        +"%;background:"+rows[i].color+'"></i></div>'
        +'<span class="v">'+esc(fmtBytes(rows[i].bytes))+"</span></div>";
    }
    return '<div class="sy-bars">'+html+"</div>";
  }

  // ── views ──
  // The projects KPI states BOTH counts, because they answer different
  // questions: everSeen is how many projects this machine has touched, onDisk is
  // how many still exist to be measured. Rendering either alone under the word
  // "projects" misreports the other.
  //
  // The older "count" field is NOT a stand-in for either. It is the number of
  // rows the scan measured, and labelling it "ever seen" is how this panel
  // reported 4 on a machine that has touched 50 — the wrong question answered
  // under the right word. A snapshot that predates the cross-host census renders
  // that field as exactly what it is, and the liner says why the others are gone.
  /** The projects tile's headline. ONE figure only: "ever" is the value, and
   *  "on disk" moved to a sub-line. Two figures separated by a dot inside a
   *  30px odometer row wrapped the second one under the first, which read as a
   *  broken value rather than as a second fact. */
  function projectsValue(p){
    if(!p)return odCount(null);
    if(!p.everSeen)return odCount(p.count)+'<span class="unit">measured</span>';
    return odCount(p.everSeen)+'<span class="unit">ever</span>';
  }
  // Liner note (data, never design): the two counts come from different
  // populations and the de-duplication across hosts is the part a reader cannot
  // infer from the number.
  function projectsLiner(p){
    if(!p)return "";
    if(!p.everSeen){
      return "<b>Projects</b> \u2014 this snapshot predates the cross-host project census, so "
        +"it carries only the projects it measured, not how many this machine has ever "
        +"touched. A rescan states both.";
    }
    var note='<span title="'+esc(p.method||"")+'"><b>Projects</b> \u2014 <b>ever</b>: every '
      +"working directory any host recorded, de-duped across Claude, Codex and OpenCode by "
      +"resolved real path, so one project used from two hosts counts once. <b>on disk</b>: the "
      +"subset that still exists to measure.</span>";
    var g=mval(p.gitRepos);
    if(g!=null)note+=" "+esc(fmtNum(g))+" are git repos.";
    if(p.unresolved>0){
      note+=" "+esc(fmtNum(p.unresolved))+" path"+(p.unresolved===1?"":"s")
        +" could not be decoded, so both counts are floors.";
    }
    if(p.truncated)note+=" The measured list is capped, so fewer rows than on-disk projects.";
    return note;
  }
  export function renderSysSummary(d){
    var install=d.install,storage=d.storage,catalog=d.catalog,projects=d.projects;
    var rt=d.runtime||{},totals=rt.totals||{};
    var kpis=document.getElementById("sys-kpis");
    if(kpis){
      // One fact per line. A KPI band is read by scanning down the values, and a
      // caption that wraps mid-separator is harder to scan than three short
      // stacked lines — the tiles are a grid, so they share a height regardless.
      var counts=(catalog&&catalog.counts)||{};
      kpis.innerHTML=
        kpiCard("install footprint",odBytes(install&&install.totals&&install.totals.installBytes),[
          mhtml(install&&install.totals&&install.totals.toolsPresent)+" tools",
          mhtml(install&&install.totals&&install.totals.nativeAddons)+" native addons",
        ])
        +kpiCard("data retained",odBytes(storage&&storage.totals&&storage.totals.bytes),
          ["transcripts","ledgers","caches"])
        +kpiCard("live processes",odCount(totals.processCount),[
          mhtml(totals.rssBytes,fmtBytes)+" RSS",
          mhtml(totals.cpuPercent,function(v){return v.toFixed(1)+"%";})+" CPU",
        ])
        +kpiCard("projects",projectsValue(projects),locSummary(projects))
        +kpiCard("catalog",odCount(counts.skill)+'<span class="unit">skills</span>',[
          mhtml(counts.agent)+" agents",
          mhtml(counts.command)+" commands",
        ]);
      mountOdometers(kpis);
    }
    var kpiNote=document.getElementById("sys-kpis-note");
    if(kpiNote)kpiNote.innerHTML=projectsLiner(projects);

    var band=document.getElementById("sys-gauge");
    if(band){
      var disk=(install&&install.disk)||null;
      var total=mval(disk&&disk.totalBytes),free=mval(disk&&disk.freeBytes);
      var used=mval(install&&install.totals&&install.totals.installBytes);
      var data=mval(storage&&storage.totals&&storage.totals.bytes);
      if(used==null||data==null){
        band.innerHTML=sysEmpty(install?"the disk band needs the install and storage totals; at least one is unmeasured.":NOT_SCANNED);
      }else{
        band.innerHTML=diskBand(used,data,total==null?0:total,free);
      }
    }
    renderSysConsumers(d);
  }

  // ── largest consumers ──
  // Every row the strip ranks comes from the consumers collector, which walks
  // shared caches, model stores and toolchains the install and storage sections
  // never see. When that section is absent the panel falls back to what those
  // two sections DO carry and says so — a ranking whose scope is narrower than
  // its title is exactly the misreading a liner note exists to prevent.
  // The named parts of a row whose figure covers more than its label suggests.
  // This is the whole liner note for the brain row: that row is the WHOLE
  // ~/.cache/ruvnet-brain root, so it is many times the active-KB figure the
  // install section reported on its own, and naming the parts says where the
  // difference actually sits (superseded copies, embedding models) instead of
  // leaving a number that looks like it grew overnight.
  function consBreakdown(kids){
    if(!kids||!kids.length)return "";
    var list=kids.slice().sort(function(a,b){return (mval(b.bytes)||0)-(mval(a.bytes)||0);});
    var parts=[],unknowns=0,i;
    for(i=0;i<list.length&&i<3;i++){
      var v=mval(list[i].bytes);
      if(v==null)unknowns++;
      else parts.push(list[i].label+" "+fmtBytes(v));
    }
    if(!parts.length)return "";
    // An unmeasured part is named as missing rather than dropped, or the parts
    // would silently fail to account for the whole.
    return " Of it: "+parts.join(", ")
      +(unknowns?", plus "+unknowns+" part(s) that could not be measured":"")+".";
  }
  function consRows(c){
    var top=(c&&c.top)||[],rows=(c&&c.rows)||[],out=[],i;
    var kids={};
    for(i=0;i<rows.length;i++){
      var owner=rows[i].containedBy;
      if(owner)(kids[owner]||(kids[owner]=[])).push(rows[i]);
    }
    for(i=0;i<top.length;i++){
      var r=top[i],v=mval(r.bytes);
      var app=mval(r.apparentBytes);
      var tail="";
      if(app!=null&&v!=null&&app>v*1.05)tail=fmtBytes(app)+" apparent";
      out.push({
        label:r.label,group:r.group,bytes:v,measure:r.bytes,tail:tail,
        title:(r.path||r.pathPattern||"")+(r.accountingNote?" \u2014 "+r.accountingNote:""),
        // Only a row with breakdowns gets a visible note: those are the rows
        // whose figure covers more than its name suggests, so the note is what
        // makes the number readable rather than surprising.
        note:kids[r.id]?(r.accountingNote||"")+consBreakdown(kids[r.id]):"",
        color:r.group==="project-trees"?"var(--s2)":"var(--accent)"
      });
    }
    return out;
  }
  function consGroupRows(c){
    var gs=(c&&c.groups)||[],out=[],i;
    for(i=0;i<gs.length;i++){
      var v=mval(gs[i].bytes);
      // A group with nothing in it is dropped — EXCEPT project trees, whose
      // emptiness is the toggle's own answer: hiding it would make an excluded
      // category invisible instead of stated.
      if(v==null&&!gs[i].rowCount&&gs[i].id!=="project-trees")continue;
      out.push({
        label:gs[i].label,group:gs[i].id,bytes:v,measure:gs[i].bytes,tail:"",
        title:gs[i].note||"",
        note:fmtNum(gs[i].rowCount)+" root"+(gs[i].rowCount===1?"":"s")
          +(gs[i].note?" \u00b7 "+gs[i].note:""),
        color:gs[i].id==="project-trees"?"var(--s2)":"var(--accent)"
      });
    }
    return out;
  }
  function consumerRows(rows){
    if(!rows.length)return sysEmpty("nothing was ranked \u2014 every candidate root was absent or unmeasured.");
    var max=0,html="",i;
    for(i=0;i<rows.length;i++)if(rows[i].bytes!=null&&rows[i].bytes>max)max=rows[i].bytes;
    for(i=0;i<rows.length;i++){
      var r=rows[i],w=(max>0&&r.bytes!=null)?Math.max(1,(r.bytes/max)*100):0;
      html+='<div class="sy-crow"><span class="n" title="'+esc(r.title||r.label)+'">'+esc(r.label)
        +(r.tail?'<span class="g">'+esc(r.tail)+"</span>":"")+"</span>"
        +'<div class="sy-track">'+(w>0?'<i class="sy-fill" style="width:'+w.toFixed(1)
          +"%;background:"+r.color+'"></i>':"")+"</div>"
        +'<span class="v">'+mhtml(r.measure,fmtBytes)+"</span></div>"
        +(r.note?'<div class="sy-cnote">'+esc(r.note)+"</div>":"");
    }
    return html;
  }
  function consumerLiner(c,fallbackRows){
    if(!c){
      return "<b>Ranked from the install and storage sections only</b> \u2014 this snapshot "
        +"carries no consumers scan, so shared caches outside those two sections (npm's "
        +"_cacache, model stores, language toolchains) are not counted here at all. "
        +esc(fmtNum(fallbackRows))+" rows ranked.";
    }
    var ranked=mval(c.totals&&c.totals.rankedCount);
    var a=c.accounting||{},t=c.projectTrees||{};
    // One line on the page, the collector's full accounting prose on hover: the
    // reader needs the scope to read the ranking, not a paragraph to read the
    // scope.
    var full=[a.basis,a.containment,a.residuals,a.absent,t.included?null:t.reason]
      .filter(Boolean).join(" ");
    var lead=consMode==="ecosystem"
      ? "Grouped by ecosystem, ranked roots only. "
      : "Top "+esc(fmtNum(c.topN||20))+" of "+(ranked==null?"the":esc(fmtNum(ranked)))
        +" measured roots. ";
    return '<span title="'+esc(full)+'">'+lead
      +"Counted: model stores, package and browser caches, language toolchains and the kit's "
      +"own trees \u2014 each at ONE level, so nesting never adds twice; absent roots are not "
      +"ranked. "
      +(t.included?"Project working trees are included in this measurement."
        :"Project trees are NOT measured unless the chip is on \u2014 one repo would flatten "
          +"the ranking.")
      +(c.unmeasured&&c.unmeasured.length
        ? " "+esc(fmtNum(c.unmeasured.length))+" unmeasurable."
        :"")+"</span>";
  }
  export function renderSysConsumers(d){
    var el=document.getElementById("sys-consumers");
    var note=document.getElementById("sys-consumers-note");
    var trees=document.getElementById("sys-cons-trees");
    var c=d.consumers||null;
    if(trees){
      var on=!!(c&&c.includeProjectTrees);
      trees.classList.toggle("on",on);
      trees.setAttribute("aria-pressed",on?"true":"false");
      // Not a filter: whether trees were walked is decided at scan time, so the
      // chip advertises the rescan it will start rather than pretending the
      // answer is already on the client.
      trees.title=on
        ?"project working trees are in this ranking \u2014 click to rescan without them"
        :"project working trees are excluded \u2014 click to rescan with them (a deep scan takes a while)";
      trees.disabled=!!(d.scan&&d.scan.running);
    }
    if(!el)return;
    if(!c&&!d.storage&&!d.install){
      el.innerHTML=sysEmpty(NOT_SCANNED);
      if(note)note.innerHTML="";
      return;
    }
    var rows=c?(consMode==="ecosystem"?consGroupRows(c):consRows(c)):topConsumers(d,20);
    el.innerHTML=c?consumerRows(rows):rankedBars(rows);
    if(note)note.innerHTML=consumerLiner(c,rows.length);
  }

  // ── reclaimables (advisory, two tiers) ──
  // ADR-0025 §6 and the storage collector's own header: this context has no
  // delete verb, so nothing below is an action. The two safety tiers are
  // rendered as SEPARATE blocks because they are separate promises —
  // 'regenerable' is space the owning tool refetches by itself, 'review' is a
  // pointer at something to look at. A review row therefore never gets the
  // bytes-in-a-pill treatment: that pill is the visual grammar of "this much is
  // yours to take back", and on a row that may be in use it would be a claim
  // the measurement does not support.
  var TIER_ORDER=["regenerable","review"];
  // One scrollable table rather than two stacked card grids. The rows are an
  // advisory list of "here is a thing, here is where it lives" — nine of them
  // as paragraph-bearing cards towered over the rest of the tab, and the
  // reading task (scan, find a path, go run something elsewhere) is a table's.
  // The pills stay: they are the visual grammar that separates the two
  // promises, and only the regenerable one carries bytes.
  function reclaimRow(r){
    var review=r.safety!=="regenerable";
    var meas=mhtml(r.bytes,fmtBytes);
    return '<tr data-safety="'+esc(review?"review":"regenerable")+'">'
      +"<td>"+(review?'<span class="tag review">review</span>'
        :'<span class="tag regen">regenerable</span>')+"</td>"
      +'<td class="sy-adv-t"><b>'+esc(r.label)+"</b>"
      +(r.rationale?'<span class="why"> \u2014 '+esc(r.rationale)+"</span>":"")
      // Documentation, not an affordance: the CLI that already owns removal.
      // The remediation is a DIFFERENT kind of sentence from the finding above
      // it — what you could do, rather than what was found — and ran on from
      // the rationale as if it were the next clause of it. Its own class, so
      // the gap is part of the row's grammar rather than a stray margin.
      +(r.cleanupHint?'<div class="sy-adv-fix">removal lives in <span class="mono">'
        +esc(r.cleanupHint)+"</span></div>":"")
      +"</td>"
      +'<td class="sy-path mono">'+esc(r.path||"")+"</td>"
      // On a review row the figure is CONTEXT, never a claim of free space —
      // the title says which kind so the column stays one word wide.
      +'<td class="num"'+(review?' title="'+esc(r.bytesMeaning==="installed"
        ? "installed at this path — context, not a figure to reclaim"
        : "across the matching files — context, not a figure to reclaim")+'"':"")
      +">"+meas+(review?'<span class="g"> ctx</span>':"")+"</td>"
    +"</tr>";
  }
  export function renderSysReclaim(s){
    var rec=document.getElementById("sys-reclaim");
    var note=document.getElementById("sys-reclaim-note");
    if(note)note.innerHTML="";
    if(!rec)return;
    if(!s){rec.innerHTML=sysEmpty(NOT_SCANNED);return;}
    var list=s.reclaimables||[];
    if(!list.length){
      rec.innerHTML=sysEmpty("nothing crossed a reclaimable threshold \u2014 a real, measured nothing.");
      return;
    }
    var summary=s.reclaimSummary||null,tiers={},i;
    for(i=0;i<((summary&&summary.tiers)||[]).length;i++)tiers[summary.tiers[i].safety]=summary.tiers[i];
    // Regenerable first, then review — the sort is the tiering now that the two
    // no longer occupy separate blocks.
    var ordered=[],placed=0;
    for(i=0;i<TIER_ORDER.length;i++){
      var members=list.filter((function(t){
        // A row from a snapshot older than the safety field lands in 'review',
        // the tier that promises less — never in the one that reads as free space.
        return function(r){return (r.safety==="regenerable"?"regenerable":"review")===t;};
      })(TIER_ORDER[i]));
      placed+=members.length;
      ordered=ordered.concat(members);
    }
    var body="";
    for(i=0;i<ordered.length;i++)body+=reclaimRow(ordered[i]);
    rec.innerHTML='<div class="sy-tblwrap sy-reclaim-scroll"><table class="sy-table">'
      +"<thead><tr><th>Status</th><th>What it is</th><th>Path</th>"
      +'<th style="text-align:right">Size</th></tr></thead><tbody>'+body+"</tbody></table></div>"
      +(placed<list.length
        ?'<div class="sy-liner">'+esc(fmtNum(list.length-placed))+" row(s) carried no safety tier "
          +"and are not shown.</div>":"");
    if(note){
      // Totals by status, still never added together — that is the one thing
      // this panel's accounting must not do.
      var regen=tiers.regenerable,rev=tiers.review;
      var regenN=(regen&&regen.rowCount)||0,revN=(rev&&rev.rowCount)||0;
      note.innerHTML='<span class="tag regen">regenerable</span> <b>'
        +(regen?mhtml(regen.bytes,fmtBytes):unkHtml("no tier total in this snapshot",false))
        +"</b> across "+esc(fmtNum(regenN))+" row"+(regenN===1?"":"s")
        +' <span class="g">\u00b7</span> <span class="tag review">review</span> '
        +esc(fmtNum(revN))+" row"+(revN===1?"":"s")+" to check"
        // The missing review total is the load-bearing part, so it is explained
        // rather than labelled: "no total — pointers, not a sum" told a reader
        // what was absent without ever saying why they should be glad it is.
        +'<div class="why">No combined total, on purpose \u2014 only the regenerable figure is '
        +"safe to count on. Review rows are a to-do list, not a number.</div>";
    }
  }

  // Categories that dominate every other series by orders of magnitude and are
  // therefore reported on their own, not mixed into a shared chart. Presentation
  // only — the collector measures all four and the CLI still emits all four.
  export var CHART_EXCLUDED_CATEGORIES={"learning-stores":true};

  /** The id /api/session/<id> answers to, derived from a storage row, or null
   *  when the row cannot be addressed.
   *
   *  Storage identifies a session by its FILE BASENAME; Usage identifies it by
   *  a stripped id. Claude: "<uuid>.jsonl" -> "<uuid>". Codex:
   *  "rollout-<iso-ts>-<uuid>.jsonl" -> "<uuid>", mirroring usage-index's
   *  codexIdFromName. OpenCode has no transcript route at all — its whole
   *  store is one database file, not a session per file — so it returns null
   *  and the row renders unlinked rather than as a link that 404s. */
  export function transcriptIdOf(row){
    if(!row||row.host==="opencode")return null;
    var name=String(row.session||"");
    if(name.slice(-6)===".jsonl")name=name.slice(0,-6);
    if(name.indexOf("rollout-")===0){
      name=name.slice(8);
      // strip a leading YYYY-MM-DDTHH-MM-SS- timestamp (19 chars + separator)
      if(name.length>20&&name.charAt(10)==="T")name=name.slice(20);
    }
    // The same shape AKDashboardOpenTranscript validates; checking here keeps a
    // malformed id from ever reaching the DOM as a control.
    if(!name||name.length>128)return null;
    for(var i=0;i<name.length;i++){
      var c=name.charAt(i);
      if(!((c>="A"&&c<="Z")||(c>="a"&&c<="z")||(c>="0"&&c<="9")||c==="."||c==="_"||c==="-"))return null;
    }
    return name;
  }
