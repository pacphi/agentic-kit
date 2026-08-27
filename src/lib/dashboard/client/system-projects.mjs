// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { authHeaders, esc } from './bootstrap.mjs';
import { ago } from './intelligence.mjs';
import { CHART_EXCLUDED_CATEGORIES, KIND_LABEL, KIND_PLURAL, NOT_SCANNED, SERIES, bytesPair, catColor, dayTick, fmtBytes, fmtDur, hostColor, mhtml, mval, renderSysConsumers, renderSysReclaim, renderSysSummary, storageHostTotals, svgArea, svgDonut, svgRadar, sysEmpty, transcriptIdOf, unkHtml } from './system-readout.mjs';
import { fmtNum, fmtTok, limAge, pct } from './usage.mjs';

  // The per-host split answers "which HOST is holding this". The project and
  // agentic-kit keys are not hosts: project is the learning-stores pseudo-host
  // (now its own card) and agentic-kit is ak's own state. Both are accounted
  // for in the panel's footnote rather than dropped silently.
  var REAL_HOSTS={claude:true,codex:true,opencode:true};

  function renderSysStorage(d){
    var s=d.storage,i,j;

    // ── learning stores, lifted out of the shared charts ──
    var learn=document.getElementById("sys-learning");
    if(learn){
      if(!s){learn.innerHTML=sysEmpty(NOT_SCANNED);}
      else{
        var lcat=null,lcats=s.categories||[];
        for(i=0;i<lcats.length;i++)if(lcats[i].key==="learning-stores")lcat=lcats[i];
        var lv=lcat?mval(lcat.bytes):null;
        if(lv==null){learn.innerHTML=sysEmpty(lcat?"learning-store bytes were not measured.":"no learning store was measured.");}
        else{
          // The category's direct children are HOSTS (a single pseudo-host
          // named project); the projects are a level below that. Counting the
          // children would report "1 project store" on a machine with dozens.
          var lkids=0,lh=lcat.children||[];
          for(var li=0;li<lh.length;li++)lkids+=((lh[li]&&lh[li].children)||[]).length;
          learn.innerHTML='<div class="sy-solo"><div class="sy-solo-v">'+esc(fmtBytes(lv))+"</div>"
            +'<div class="sy-solo-l">'+(lkids?"across "+esc(fmtNum(lkids))+" project store"+(lkids===1?"":"s"):"in your projects")+"</div>"
            +'<p class="sy-liner">ruflo, agentic-qe and swarm state written into your projects '
            +"(.claude-flow, .agentic-qe, .swarm). Reported on its own because it dwarfs every "
            +"other category &mdash; mixed in, it flattens them to nothing.</p></div>";
        }
      }
    }

    var donut=document.getElementById("sys-donut");
    if(donut){
      if(!s){donut.innerHTML=sysEmpty(NOT_SCANNED);}
      else{
        var slices=[],legend="",total=0;
        for(i=0;i<(s.categories||[]).length;i++){
          if(CHART_EXCLUDED_CATEGORIES[s.categories[i].key])continue;
          var v=mval(s.categories[i].bytes);
          if(v==null)continue;
          slices.push({label:s.categories[i].label,value:v,color:catColor(s.categories[i].key)});
          total+=v;
        }
        for(i=0;i<slices.length;i++){
          legend+='<span><i style="background:'+slices[i].color+'"></i>'+esc(slices[i].label)+" <b>"
            +esc(fmtBytes(slices[i].value))+" \u00b7 "+(total>0?pct(slices[i].value,total).toFixed(0):"0")+"%</b></span>";
        }
        donut.innerHTML=slices.length
          ?('<div class="sy-donut">'+svgDonut(slices,total,fmtBytes(total)+" excluding learning stores")
            +'<div class="sy-legend" style="flex-direction:column;gap:7px">'+legend+"</div></div>"
            +'<p class="sy-liner">Learning stores are counted on their own card, not here.</p>')
          :sysEmpty("no storage category could be measured.");
      }
    }
    var split=document.getElementById("sys-hostsplit");
    if(split){
      if(!s){split.innerHTML=sysEmpty(NOT_SCANNED);}
      else{
        var byHost={},order=[],cats=s.categories||[],otherBytes=0,otherKeys={};
        for(i=0;i<cats.length;i++){
          var kids=cats[i].children||[];
          for(j=0;j<kids.length;j++){
            var b=mval(kids[j].bytes);
            if(b==null)continue;
            // Everything not a real host is summed into the footnote instead of
            // being dropped: the panel must still account for the whole donut.
            if(!REAL_HOSTS[kids[j].key]){
              if(!CHART_EXCLUDED_CATEGORIES[cats[i].key]){otherBytes+=b;otherKeys[kids[j].key]=true;}
              continue;
            }
            if(CHART_EXCLUDED_CATEGORIES[cats[i].key])continue;
            if(!byHost[kids[j].key]){byHost[kids[j].key]={key:kids[j].key,parts:[],total:0};order.push(kids[j].key);}
            byHost[kids[j].key].parts.push({color:catColor(cats[i].key),bytes:b,
              label:kids[j].key+" \u00b7 "+cats[i].label+" "+fmtBytes(b)});
            byHost[kids[j].key].total+=b;
          }
        }
        order.sort(function(a,b2){return byHost[b2].total-byHost[a].total;});
        var scale=order.length?byHost[order[0]].total:0,rowsHtml="";
        for(i=0;i<order.length;i++){
          var row=byHost[order[i]],seg="";
          for(j=0;j<row.parts.length;j++){
            seg+='<i class="sy-fill" style="width:'+(scale>0?(row.parts[j].bytes/scale)*100:0).toFixed(2)
              +"%;background:"+row.parts[j].color+'" title="'+esc(row.parts[j].label)+'"></i>';
          }
          rowsHtml+='<div class="sy-bar"><span class="n">'+esc(row.key)+"</span>"
            +'<div class="sy-track tall">'+seg+"</div>"
            +'<span class="v">'+esc(fmtBytes(row.total))+"</span></div>";
        }
        var catLegend="";
        for(i=0;i<cats.length;i++){
          if(CHART_EXCLUDED_CATEGORIES[cats[i].key])continue;
          catLegend+='<span><i style="background:'+catColor(cats[i].key)+'"></i>'+esc(cats[i].label)+"</span>";
        }
        // Name what is NOT in the rows, with its figure. Dropping the non-host
        // rows silently would leave the bars failing to add up to the donut
        // beside them, with nothing on screen explaining the gap.
        var otherNames=[];
        for(var ok in otherKeys)if(Object.prototype.hasOwnProperty.call(otherKeys,ok))otherNames.push(ok);
        otherNames.sort();
        var footnote=otherNames.length
          ?'<p class="sy-liner">Hosts only. A further <b>'+esc(fmtBytes(otherBytes))+"</b> belongs to "
            +esc(otherNames.join(" and "))+" &mdash; ak's own state, not a host's. Learning stores are on their own card.</p>"
          :'<p class="sy-liner">Learning stores are on their own card, not counted here.</p>';
        split.innerHTML=order.length
          ?('<div class="sy-bars">'+rowsHtml+'</div><div class="sy-legend" style="margin-top:10px">'+catLegend+"</div>"+footnote)
          :sysEmpty("no per-host storage node could be measured.");
      }
    }
    var growth=document.getElementById("sys-growth");
    if(growth){
      var g=s&&s.growth;
      if(!g||!g.hosts||!g.hosts.length){growth.innerHTML=sysEmpty(s?"no growth series was measured.":NOT_SCANNED);}
      else{
        var panels="";
        // No cap: the series are the storage roots' own hosts, a fixed small
        // set. The old i<6 guard silently dropped whichever came last.
        for(i=0;i<g.hosts.length;i++){
          var h=g.hosts[i],days=h.days||[];
          var vals=days.map(function(x){return Number(x&&x.bytes)||0;});
          var avg=mval(h.perDayAvgBytes),tot=mval(h.totalBytes);
          var peak=vals.length?Math.max.apply(null,vals):0;
          panels+='<div><div class="sy-legend" style="margin-bottom:4px"><span><i style="background:'
            +hostColor(h.host)+'"></i>'+esc(h.host)+"</span></div>"
            +svgArea(vals,hostColor(h.host),h.host+" \u00b7 "+(tot==null?"total unmeasured":fmtBytes(tot)+" over "+g.windowDays+"d")
              +(avg==null?"":" \u00b7 "+fmtBytes(avg)+"/day avg"),
              {peakLabel:fmtBytes(peak),
               firstDay:dayTick(days.length?days[0].day:null),
               lastDay:dayTick(days.length?days[days.length-1].day:null)})
            +'<div class="sy-liner">'+(tot==null?"total unmeasured":esc(fmtBytes(tot))+" over "+esc(String(g.windowDays))+"d")
            +(avg==null?"":" \u00b7 "+esc(fmtBytes(avg))+"/day")+"</div>"
            +"</div>";
        }
        growth.innerHTML='<div class="sy-spark">'+panels+"</div>"
          +'<div class="sy-legend" style="margin-top:8px"><span class="sy-approx">approximate \u00b7 '
          +esc(String(g.basis||"file mtime and size only"))+"</span></div>";
      }
    }
    renderSysReclaim(s);
    var top=document.getElementById("sys-topsessions");
    if(top){
      var sess=(s&&s.topSessions)||null;
      if(!s){top.innerHTML=sysEmpty(NOT_SCANNED);}
      else if(!sess||!sess.length){top.innerHTML=sysEmpty("no session files were measured.");}
      else{
        // Attributable rows only. A row whose project cannot be named is not a
        // useful entry in a list whose whole job is "which project is holding
        // these bytes" — the unattributable ones are counted in the liner
        // instead, so they are excluded rather than hidden.
        var attributable=[],unattributable=0;
        for(i=0;i<sess.length;i++){
          if(sess[i]&&sess[i].project)attributable.push(sess[i]);else unattributable++;
        }
        if(!attributable.length){
          top.innerHTML=sysEmpty("no session file could be attributed to a project.");
        }else{
        var hostTotals=storageHostTotals(s),body="";
        for(i=0;i<attributable.length;i++){
          var x=attributable[i],ht=hostTotals[x.host],share=ht>0?(x.bytes/ht)*100:null;
          // Link to the transcript the same way Usage does, through the public
          // bridge it already exposes. The id has to be normalised first:
          // Storage's session is the FILE BASENAME, while /api/session wants
          // Usage's form. A row we cannot address renders as plain text — a
          // dead link is worse than no link.
          var sid=transcriptIdOf(x);
          // Strip the extension rather than truncating mid-id: a uuid cut at 34
          // characters reads as a corrupted value.
          var sname=String(x.session||"");
          if(sname.slice(-6)===".jsonl")sname=sname.slice(0,-6);
          var cell=esc(sname);
          body+="<tr>"
            +'<td class="mono" title="'+esc(x.path||"")+'">'
            +(sid?'<button class="sy-link" type="button" data-transcript="'+esc(sid)+'" title="open transcript">'+cell+"</button>":cell)
            +"</td>"
            +'<td><span class="sy-dot" style="background:'+hostColor(x.host)+'"></span>'+esc(x.host||"\u2014")+"</td>"
            // An undecoded name says WHICH reason. "deleted project" is a
            // claim, and on Windows it would be a false one for every row: the
            // encoding there carries a drive prefix that the decoder refuses by
            // design, so nothing is decodable and nothing has been deleted.
            +"<td>"+(x.projectResolved===false
              ?'<span class="sy-unk" title="'+esc(x.projectReason==="encoding"
                ? "this name is not a POSIX-rooted transcript directory, so it cannot be decoded to a project path: "+String(x.project||"")
                : "this project directory no longer exists, so its name cannot be decoded from "+String(x.project||""))
                +'">'+(x.projectReason==="encoding"?"name not decodable":"deleted project")+"</span>"
              :esc(x.projectLabel||x.project))+"</td>"
            +'<td class="num">'+esc(fmtBytes(x.bytes))+"</td>"
            +"<td>"+(share==null
              ?unkHtml("this host's retained total was not measured",false)
              :('<div class="sy-inbar" title="'+share.toFixed(1)+'% of '+esc(x.host)+' retained bytes"><i class="sy-fill" style="width:'
                +Math.max(1,Math.min(100,share)).toFixed(1)+"%;background:"+hostColor(x.host)+'"></i></div>'))
            +"</td></tr>";
        }
        top.innerHTML='<div class="sy-tblwrap"><table class="sy-table"><thead><tr><th>Session</th><th>Host</th>'
          +'<th>Project</th><th style="text-align:right">Size</th><th>Share of host</th></tr></thead><tbody>'
          +body+"</tbody></table></div>"
          +(unattributable?'<div class="sy-liner">'+esc(fmtNum(unattributable))
            +" larger session file"+(unattributable===1?"":"s")+" could not be attributed to a project "
            +"and "+(unattributable===1?"is":"are")+" not listed.</div>":"");
        }
      }
    }
  }

  function renderSysRuntime(d){
    var rt=d.runtime||{},i;
    var procs=document.getElementById("sys-procs");
    if(procs){
      var pm=rt.processes;
      if(!pm||pm.status==="unknown"||!Array.isArray(pm.value)){
        procs.innerHTML=sysEmpty((pm&&pm.reason)||"the process census is unavailable.");
      }else if(!pm.value.length){
        procs.innerHTML=sysEmpty("no host process is running right now \u2014 a measured zero.");
      }else{
        var rows=pm.value,maxRss=0,body="";
        for(i=0;i<rows.length;i++){var rv=mval(rows[i].rssBytes);if(rv!=null&&rv>maxRss)maxRss=rv;}
        for(i=0;i<rows.length;i++){
          var p=rows[i],rss=mval(p.rssBytes);
          // The project cell is the honest-degradation surface: the census
          // states WHY a process could not be attributed (including the Windows
          // reasons), and that sentence is what renders. Never blank, never a guess.
          var proj=p.project&&p.project.status!=="unknown"&&p.project.value
            ? esc(p.project.value.label||p.project.value.path)
            : '<span class="sy-unk" title="'+esc((p.project&&p.project.reason)||"not attributable")+'">'
              +esc(String((p.project&&p.project.reason)||"not attributable").split("\u2014")[0].trim())+"</span>";
          body+='<tr><td><span class="sy-dot" style="background:'+hostColor(p.host)+'"></span>'+esc(p.host)+"</td>"
            +'<td class="num">'+esc(String(p.pid))+"</td>"
            +"<td>"+proj+"</td>"
            +'<td class="num">'+mhtml(p.uptimeMs,fmtDur)+"</td>"
            +'<td class="num">'+mhtml(p.cpuPercent,function(v){return v.toFixed(1)+"%";})+"</td>"
            +'<td><div class="sy-rss"><div class="sy-inbar" style="min-width:110px"><i class="sy-fill" style="width:'
              +(rss!=null&&maxRss>0?Math.max(2,(rss/maxRss)*100):0).toFixed(1)+"%;background:"+hostColor(p.host)+'"></i></div>'
            +'<span class="mono" style="font-size:11.5px">'+mhtml(p.rssBytes,fmtBytes)+"</span></div></td></tr>";
        }
        // pid is right-aligned in the body, so its header is too — a numeric
        // column whose header hangs off the far side reads as a different column.
        procs.innerHTML='<div class="sy-tblwrap"><table class="sy-table"><thead><tr><th>Host</th>'
          +'<th style="text-align:right">pid</th>'
          +'<th>Project</th><th style="text-align:right">Uptime</th><th style="text-align:right">CPU</th>'
          +"<th>RSS</th></tr></thead><tbody>"+body+"</tbody></table></div>";
      }
    }
    var mem=document.getElementById("sys-mem");
    if(mem){
      var tot=rt.totals||{},mach=rt.machine||{};
      var rssV=mval(tot.rssBytes),physV=mval(mach.physicalMemoryBytes);
      var pair=rssV==null?null:bytesPair(rssV);
      mem.innerHTML='<div class="val" style="display:flex;align-items:baseline;gap:5px">'
        +(pair?('<span class="od lit" style="font-size:26px">'+esc(pair.n)+'</span><span class="unit">'+pair.u+" resident combined</span>")
          :mhtml(tot.rssBytes,fmtBytes))+"</div>"
        +(rssV!=null&&physV>0
          ?('<div class="sy-meter" title="'+esc(fmtBytes(rssV)+" of "+fmtBytes(physV)+" physical memory")+'"><i style="width:'
            +Math.min(100,(rssV/physV)*100).toFixed(1)+'%"></i></div>'
            +'<div style="font-size:11.5px;color:var(--ink-2)">of '+esc(fmtBytes(physV))+" physical \u00b7 "
            +mhtml(tot.cpuPercent,function(v){return v.toFixed(1)+"%";})+" CPU across "+mhtml(mach.cpuCount)+" cores</div>")
          :'<div style="font-size:11.5px;color:var(--ink-2)">'+unkHtml("the physical-memory denominator was not reported",false)
            +" \u2014 no share of memory can be stated</div>");
    }
    var dae=document.getElementById("sys-daemons");
    if(dae){
      var dm=rt.daemons||{},ttl=Number(dm.ttlSecs)||0,oldest=mval(dm.oldestAgeSecs);
      // Two tiles, both explained. The third — an AI-worker budget — was removed
      // rather than left degraded: no code path could ever populate it, so it
      // was a permanent "unavailable" teaching the reader to ignore unknowns
      // (ADR-0023 SS9).
      var ttlH=ttl?(ttl/3600).toFixed(0):null;
      dae.innerHTML='<div class="sy-tiles">'
        +'<div class="sy-tile"><div class="t-v">'+mhtml(dm.count)+'</div><div class="t-l">running \u00b7 oldest '
          +(oldest==null?unkHtml((dm.oldestAgeSecs&&dm.oldestAgeSecs.reason)||"no start time recorded",false)
            :esc((oldest/3600).toFixed(1)+"h"))
          +(ttlH?" of "+esc(ttlH)+"h TTL":"")+"</div></div>"
        +'<div class="sy-tile"><div class="t-v">'+mhtml(dm.staleCount)+'</div><div class="t-l">past TTL</div></div>'
      +"</div>"
      +'<p class="sy-liner">Daemons are ruflo background workers, one per active project. '
      +"Each carries a time-to-live"+(ttlH?" of "+esc(ttlH)+" hours":"")
      +'; one past it has outlived its lease and is what <span class="mono">ak x daemon-gc</span> reaps. '
      +"Several running at once is normal \u2014 a growing count of stale ones is not.</p>";
    }
  }

  function renderSysCatalog(d){
    var c=d.catalog,i,j;
    var radar=document.getElementById("sys-radar");
    var countsEl=document.getElementById("sys-catcounts");
    var matrix=document.getElementById("sys-matrix");
    if(!c){
      if(radar)radar.innerHTML=sysEmpty(NOT_SCANNED);
      if(countsEl)countsEl.innerHTML="";
      if(matrix)matrix.innerHTML="";
      return;
    }
    var kinds=c.kinds||[],hosts=c.hosts||[];
    if(radar){
      var axes=[],series=[];
      for(j=0;j<kinds.length;j++){
        var max=0;
        for(i=0;i<hosts.length;i++){
          var v=mval(c.perHost&&c.perHost[hosts[i]]&&c.perHost[hosts[i]][kinds[j]]);
          if(v!=null&&v>max)max=v;
        }
        axes.push({label:KIND_LABEL[kinds[j]]||kinds[j],max:max});
      }
      for(i=0;i<hosts.length&&i<3;i++){
        var vals=[],tip=hosts[i];
        for(j=0;j<kinds.length;j++){
          var pv=mval(c.perHost&&c.perHost[hosts[i]]&&c.perHost[hosts[i]][kinds[j]]);
          vals.push(pv);
          tip+=" \u00b7 "+(pv==null?"unmeasured":pv)+" "+(KIND_PLURAL[kinds[j]]||kinds[j]);
        }
        series.push({color:SERIES[i]||"var(--dim)",values:vals,tip:tip});
      }
      var legend="";
      for(i=0;i<series.length;i++)legend+='<span><i style="background:'+series[i].color+'"></i>'+esc(hosts[i])+"</span>";
      radar.innerHTML=svgRadar(axes,series)+'<div class="sy-legend">'+legend+"</div>";
    }
    if(countsEl){
      var tiles="";
      for(j=0;j<kinds.length;j++){
        tiles+='<div class="sy-tile"><div class="t-v">'+mhtml(c.counts&&c.counts[kinds[j]])+"</div>"
          +'<div class="t-l">unique '+esc(KIND_PLURAL[kinds[j]]||kinds[j])+"</div></div>";
      }
      countsEl.innerHTML='<div class="sy-tiles">'+tiles+"</div>";
    }
    if(matrix){
      // The kind heading rows are gone: they told you what you were looking at
      // but gave you no way to look at less of it, and on a 318-row inventory
      // the thing you want is a subset, not a signpost. Two pick lists do that
      // job instead — and unlike headings they compose, so "commands carried by
      // codex" is one click each rather than a scroll.
      renderCatalogFilters(c);
      paintCatalogMatrix(c);
    }
  }

  // Selected kinds/hosts, or null for "everything". Null rather than a full set
  // so the default survives a payload that grows a new kind or host: an unknown
  // option is INCLUDED until the user has expressed an opinion, never silently
  // filtered out.
  var catKinds=null,catHosts=null;

  function catalogChip(group,value,label,on){
    return '<button class="chipf'+(on?" on":"")+'" type="button" data-cat-'+group+'="'+esc(value)
      +'" aria-pressed="'+(on?"true":"false")+'">'+esc(label)+"</button>";
  }

  function renderCatalogFilters(c){
    var kinds=c.kinds||[],hosts=c.hosts||[],i,html;
    var kindsEl=document.getElementById("sys-cat-kinds");
    if(kindsEl){
      html="";
      for(i=0;i<kinds.length;i++){
        html+=catalogChip("kind",kinds[i],KIND_PLURAL[kinds[i]]||kinds[i],
          !catKinds||catKinds.indexOf(kinds[i])>=0);
      }
      kindsEl.innerHTML=html;
    }
    var hostsEl=document.getElementById("sys-cat-hosts");
    if(hostsEl){
      html="";
      for(i=0;i<hosts.length;i++){
        html+=catalogChip("host",hosts[i],hosts[i],!catHosts||catHosts.indexOf(hosts[i])>=0);
      }
      hostsEl.innerHTML=html;
    }
  }

  function paintCatalogMatrix(c){
    var matrix=document.getElementById("sys-matrix");
    if(!matrix)return;
    var all=c.items||[],hosts=c.hosts||[],i,j;
    // The host filter asks "carried by", so a row survives if ANY selected host
    // carries it — intersecting instead would answer a different question
    // ("carried by all of these") and read as a bug the moment two are on.
    var items=[],anyHostFilter=!!catHosts;
    for(i=0;i<all.length;i++){
      var it=all[i];
      if(catKinds&&catKinds.indexOf(it.kind)<0)continue;
      if(anyHostFilter){
        var carried=false,ih=it.hosts||[];
        for(j=0;j<ih.length&&!carried;j++)if(catHosts.indexOf(ih[j])>=0)carried=true;
        if(!carried)continue;
      }
      items.push(it);
    }
    var head="",body="";
    for(i=0;i<hosts.length;i++)head+='<th class="cell">'+esc(hosts[i])+"</th>";
    for(i=0;i<items.length;i++){
      // The kind rides on the row now that the heading rows are gone, so a
      // filtered view never leaves a name unexplained.
      body+='<tr><td class="nm" title="'+esc(items[i].kind+" \u00b7 "+items[i].name)+'">'
        +esc(items[i].name)+'<span class="sy-kindtag">'+esc(KIND_LABEL[items[i].kind]||items[i].kind)+"</span></td>";
      for(j=0;j<hosts.length;j++){
        var on=(items[i].hosts||[]).indexOf(hosts[j])>=0;
        body+='<td class="cell"><i class="'+(on?"on":"off")+'" title="'
          +esc(hosts[j]+(on?" carries":" does not carry")+" "+items[i].name)+'"></i></td>';
      }
      body+="</tr>";
    }
    if(!all.length){matrix.innerHTML=sysEmpty("no catalog item was measured.");return;}
    if(!items.length){
      matrix.innerHTML=sysEmpty("no item matches the current filters \u2014 "
        +fmtNum(all.length)+" measured.");
      return;
    }
    var filtered=items.length!==all.length;
    matrix.innerHTML='<div class="sy-tblwrap sy-catalog-scroll"><table class="sy-table sy-matrix-t">'
      +"<thead><tr><th>Name</th>"+head+"</tr></thead><tbody>"+body+"</tbody></table></div>"
      +'<div class="sy-liner">'
      +(filtered
        ?esc(fmtNum(items.length))+" of "+esc(fmtNum(all.length))+" deduplicated items shown"
        :esc(fmtNum(all.length))+" deduplicated item"+(all.length===1?"":"s")
          +" across user scope and every project on disk")
      +". A dot means that host carries the name.</div>";
  }

  export function wireCatalogFilters(){
    document.addEventListener("click",function(e){
      var t=e.target;
      if(!t||!t.closest)return;
      var btn=t.closest("[data-cat-kind],[data-cat-host]");
      if(!btn)return;
      var isKind=btn.hasAttribute("data-cat-kind");
      var group=isKind?"kind":"host";
      var value=btn.getAttribute("data-cat-"+group);
      var all=(SYSTEM&&SYSTEM.catalog&&(isKind?SYSTEM.catalog.kinds:SYSTEM.catalog.hosts))||[];
      var cur=(isKind?catKinds:catHosts)||all.slice();
      var at=cur.indexOf(value);
      if(at>=0)cur=cur.slice(0,at).concat(cur.slice(at+1));else cur=cur.concat([value]);
      // Turning the last one back on is "no filter", not "a filter that happens
      // to match everything" — so a later payload with a new option still
      // includes it.
      var next=cur.length===all.length?null:cur;
      if(isKind)catKinds=next;else catHosts=next;
      if(SYSTEM&&SYSTEM.catalog){renderCatalogFilters(SYSTEM.catalog);paintCatalogMatrix(SYSTEM.catalog);}
    });
  }

  // ── project stack ──
  // LANGUAGES carry lines and go on the bar. Framework/SDK/tool detection still
  // runs in the collector and still ships on ak system --json; it is no longer
  // RENDERED here, because presence-only chips answered neither question this
  // table asks (how big, and in what) while owning half of every row.
  var LANG_STEPS=[1,.8,.63,.49,.37];
  var LANG_TOP=5;
  /** Ranked languages, from the registry projection when present and from the
   *  older byLanguage map when the snapshot predates it. */
  function locLanguages(loc){
    if(!loc)return [];
    if(loc.languages&&loc.languages.length){
      return loc.languages.map(function(r){
        return {name:r.name||r.id,lines:Number(r.lines)||0};
      });
    }
    var out=[],k;
    for(k in loc.byLanguage||{})out.push({name:k,lines:Number(loc.byLanguage[k])||0});
    return out.sort(function(a,b){return b.lines-a.lines;});
  }
  function langCell(loc){
    var list=locLanguages(loc),total=mval(loc&&loc.total);
    // An unmeasured line count is NOT an empty bar: an empty bar reads as a
    // project with no code, which is a claim nobody made (invariant 2).
    if(total==null)return unkHtml((loc&&loc.total&&loc.total.reason)||"lines were not counted",!loc);
    if(!list.length||total<=0)
      return '<div class="sy-inbar" style="min-width:130px"></div>';
    var bar="",names=[],shown=0,i;
    for(i=0;i<list.length&&i<LANG_TOP;i++){
      bar+='<i class="sy-fill" style="width:'+pct(list[i].lines,total).toFixed(1)
        +"%;background:var(--s1);opacity:"+LANG_STEPS[i]+'" title="'
        +esc(list[i].name+" \u00b7 "+fmtNum(list[i].lines)+" lines")+'"></i>';
      names.push(list[i].name);
      shown+=list[i].lines;
    }
    var rest=list.slice(LANG_TOP),restNames=[];
    for(i=0;i<rest.length;i++)restNames.push(rest[i].name+" "+fmtNum(rest[i].lines));
    if(total>shown)bar+='<i class="sy-fill" style="width:'+pct(total-shown,total).toFixed(1)
      // The remainder is named on hover, so "other" is a list of languages
      // rather than an anonymous slice.
      +'%;background:var(--dim)" title="'+esc(restNames.length
        ?restNames.join(", "):"other \u00b7 "+fmtNum(total-shown)+" lines")+'"></i>';
    return '<div class="sy-inbar" style="min-width:130px">'+bar+"</div>"
      +'<div class="sy-langs" title="'+esc(names.concat(restNames).join(", "))+'">'
      +esc(names.join(" \u00b7 "))+(rest.length?esc(" +"+fmtNum(rest.length)):"")+"</div>";
  }
  /** Frameworks / SDKs / tools as chips. Capped, with the remainder named on
   *  hover rather than dropped. */
  // ── Projects table sorting ──────────────────────────────────────────────
  // One active column at a time, which is what a single aria-sort per table
  // means and what a reader can actually hold in their head. Kept in a module
  // var rather than localStorage: a sort is a question you are asking right
  // now, not a preference — but it does survive the re-renders a rescan or a
  // runtime poll triggers, which an in-function local would not.
  //
  // First click on a column uses that column's NATURAL direction rather than
  // always ascending: nobody opens a size column wanting the smallest project
  // first, or a recency column wanting the stalest.
  export var PROJ_SORT={
    project:   { label:"project",     dir:"asc"  },
    lines:     { label:"lines",       dir:"desc" },
    language:  { label:"by language", dir:"asc"  },
    disk:      { label:"disk",        dir:"desc" },
    active:    { label:"last active", dir:"desc" },
  };
  export var projSort={key:"project",dir:"asc"};

  /** The value a row sorts by, or null when it was never measured. Null is not
   *  zero and not "oldest" — an unmeasured row sorts to the BOTTOM in either
   *  direction, because letting it rank would present an absent figure as a
   *  small one. */
  function projSortValue(pr,key){
    if(key==="project")return String(pr.label||"").toLowerCase();
    if(key==="lines")return mval(pr.loc&&pr.loc.total);
    if(key==="disk")return mval(pr.totalBytes);
    if(key==="active")return mval(pr.lastActivity);
    if(key==="language"){
      var langs=locLanguages(pr.loc);
      return langs.length?String(langs[0].name||"").toLowerCase():null;
    }
    return null;
  }

  function sortProjects(rows,key,dir){
    var mul=dir==="desc"?-1:1;
    return rows.slice().sort(function(a,b){
      var av=projSortValue(a,key),bv=projSortValue(b,key);
      var an=av==null||av==="",bn=bv==null||bv==="";
      // Unmeasured always last, whichever way the column points.
      if(an&&bn)return String(a.label||"").localeCompare(String(b.label||""));
      if(an)return 1;
      if(bn)return -1;
      if(typeof av==="number"&&typeof bv==="number"){
        if(av!==bv)return (av-bv)*mul;
      }else{
        var c=String(av).localeCompare(String(bv));
        if(c!==0)return c*mul;
      }
      // Stable, readable tiebreak so equal figures do not shuffle between renders.
      return String(a.label||"").localeCompare(String(b.label||""));
    });
  }

  function projSortHeader(key,label,numeric){
    var on=projSort.key===key;
    var dir=on?projSort.dir:PROJ_SORT[key].dir;
    var aria=on?(projSort.dir==="asc"?"ascending":"descending"):"none";
    var next=on?(projSort.dir==="asc"?"descending":"ascending"):(PROJ_SORT[key].dir==="asc"?"ascending":"descending");
    return '<th aria-sort="'+aria+'"'+(numeric?' style="text-align:right"':"")+'>'
      +'<button class="sy-sort'+(on?" on":"")+'" type="button" data-proj-sort="'+esc(key)+'"'
      +' title="'+esc("sort by "+PROJ_SORT[key].label+", "+next)+'">'
      +esc(label)+'<span class="sy-arrow" aria-hidden="true">'
      +(on?(projSort.dir==="asc"?"↑":"↓"):(dir==="asc"?"↑":"↓"))
      +"</span></button></th>";
  }

  export function renderSysProjects(d){
    var el=document.getElementById("sys-projects");
    if(!el)return;
    var p=d.projects;
    if(!p){el.innerHTML=sysEmpty(NOT_SCANNED);return;}
    var all=p.projects||[];
    if(!all.length){el.innerHTML=sysEmpty("no project was discovered on this machine.");return;}
    // Repositories, not directories. Two conditions, both required:
    //
    //   a remote — a row with no https remote is, in practice, never a project
    //     you would recognise: it is an ephemeral .claude/worktrees/agent-*
    //     checkout, a sub-directory a session happened to run in
    //     (myrepo/backend), or a home directory someone once launched a session
    //     from. Those sat beside their own parent repo as if they were peers of
    //     it, each with its own multi-gigabyte disk figure.
    //   a session — this table is about projects you have actually worked in
    //     with a host. Discovery is session-derived today, so this holds by
    //     construction; asserting it anyway keeps that true if a future
    //     discovery source is not.
    //
    // The session test excludes only an EMPTY host list, never a missing one. A
    // snapshot written before rows carried a hosts field cannot answer the question,
    // and reading "absent" as "no sessions" would blank the whole table for
    // anyone holding one — treating unmeasured as zero, which is the one thing
    // this area may not do.
    //
    // A genuine local-only repository is excluded too. That is the cost of the
    // rule, and it is why the count is stated below rather than left implied.
    var list=[],excluded=0;
    for(var f=0;f<all.length;f++){
      var cand=all[f],crem=cand.remote||null;
      var linked=!!(crem&&crem.webUrl&&/^https:/.test(String(crem.webUrl)));
      var hosted=!Array.isArray(cand.hosts)||cand.hosts.length>0;
      if(linked&&hosted)list.push(cand);else excluded++;
    }
    if(!list.length){
      el.innerHTML=sysEmpty("no project with a remote and a recorded session was measured \u2014 "
        +fmtNum(excluded)+" measured director"+(excluded===1?"y was":"ies were")+" excluded.");
      return;
    }
    list=sortProjects(list,projSort.key,projSort.dir);
    var body="",i;
    for(i=0;i<list.length;i++){
      var pr=list[i];
      var tree=mval(pr.treeBytes),git=mval(pr.gitBytes),nm=mval(pr.nodeModulesBytes);
      var diskTotal=mval(pr.totalBytes),_diskBar="";
      if(diskTotal>0){
        // One entity's ranked parts — shades of ONE hue, darkest for the part
        // the user wrote, faintest for the reinstallable overhead.
        if(tree!=null)_diskBar+='<i class="sy-fill" style="width:'+pct(tree,diskTotal).toFixed(1)
          +'%;background:var(--s1)" title="'+esc("working tree \u00b7 "+fmtBytes(tree))+'"></i>';
        if(git!=null)_diskBar+='<i class="sy-fill" style="width:'+pct(git,diskTotal).toFixed(1)
          +'%;background:var(--s1);opacity:.55" title="'+esc(".git \u00b7 "+fmtBytes(git))+'"></i>';
        if(nm!=null)_diskBar+='<i class="sy-fill" style="width:'+pct(nm,diskTotal).toFixed(1)
          +'%;background:var(--s1);opacity:.28" title="'+esc("node_modules \u00b7 "+fmtBytes(nm))+'"></i>';
      }
      // The remote sub-line and the stack chips are gone: this table answers
      // "how big is each project and what is it written in". A forge slug and a
      // row of presence-only chips answered neither, and between them they owned
      // half the row's height. The project still LINKS to its remote when it has
      // an https one — the affordance was worth keeping, the metadata was not.
      var rem=pr.remote||null,name;
      if(rem&&rem.status==="linked"&&/^https:/.test(String(rem.webUrl||""))){
        name='<a href="'+esc(rem.webUrl)+'" target="_blank" rel="noreferrer noopener" title="'+esc(rem.raw||"")+'">'
          +esc(pr.label)+"&#8239;&#8599;</a>";
      }else{
        name=esc(pr.label);
      }
      var last=mval(pr.lastActivity);
      body+="<tr><td>"+name+"</td>"
        +'<td class="num">'+mhtml(pr.loc&&pr.loc.total,function(v){return "~"+fmtTok(v);})+"</td>"
        +"<td>"+langCell(pr.loc)+"</td>"
        +'<td class="num">'+mhtml(pr.totalBytes,fmtBytes)+"</td>"
        +'<td class="num">'+(last==null?unkHtml((pr.lastActivity&&pr.lastActivity.reason)||"no readable entry",false)
          :esc(ago(Math.max(0,Math.round((Date.now()-last)/1000)))))+"</td></tr>";
    }
    // Legend covers only what still renders: the language ramp. The disk column
    // is a single figure now, and there are no chips left to explain.
    el.innerHTML='<div class="sy-legend" style="margin-bottom:4px">'
      +'<span>lines: top '+LANG_TOP+' languages, darkest first'
      +'<i style="background:var(--s1);margin-left:8px"></i>'
      +'<i style="background:var(--s1);opacity:.63"></i>'
      +'<i style="background:var(--s1);opacity:.27"></i>'
      +'<i style="background:var(--dim)"></i> the rest</span></div>'
      +'<div class="sy-tblwrap"><table class="sy-table sy-sortable"><thead><tr>'
      +projSortHeader("project","Project",false)
      +projSortHeader("lines","Lines ≈",true)
      +projSortHeader("language","By language",false)
      +projSortHeader("disk","Disk",true)
      +projSortHeader("active","Last active",true)
      +"</tr></thead><tbody>"+body+"</tbody></table></div>"
      // Three numbers now, and the gap between the last two is a filter rather
      // than a fact about the machine — so it is named. Leaving the reader to
      // subtract 25 from 16 and guess is the silent exclusion ADR-0023 forbids.
      +'<div class="sy-liner">'
      +(p.everSeen
        ?mhtml(p.everSeen)+" projects ever seen across all hosts, "
          +(p.onDisk?mhtml(p.onDisk):"some")+" still on disk"
        :mhtml(p.count)+" projects measured (this snapshot predates the ever-seen count)")
      +", "+esc(fmtNum(list.length))+" listed here."
      +(excluded
        ? " Excluded "+esc(fmtNum(excluded))+" measured director"+(excluded===1?"y":"ies")
          +" with no remote or no recorded session \u2014 agent worktrees, sub-folders of a "
          +"repository already listed, and repositories with no remote."
        : "")
      +" Line counts are approximate: extension-bucketed, with node_modules and vendored "
      +"trees excluded. Disk is the whole project directory, .git and node_modules included.</div>";
  }

  // Freshness is a contract, not a caption (ADR-0025 §3): every deep figure on
  // this page was measured at ONE moment, and the label says which. Past the
  // staleness horizon it nudges — but it still never scans on its own.
  export function renderSystemFreshness(){
    var el=document.getElementById("sys-asof"),btn=document.getElementById("sys-rescan");
    if(!el)return;
    var scan=(SYSTEM&&SYSTEM.scan)||null,snap=(SYSTEM&&SYSTEM.snapshot)||null;
    el.removeAttribute("data-stale");
    if(scan&&scan.running){
      el.innerHTML='<span class="sy-scan">scanning\u2026 '+esc(scan.phase||"")
        +(scan.total?" ("+fmtNum(scan.scanned)+"/"+fmtNum(scan.total)+")":"")+"</span>";
      if(btn){btn.disabled=true;btn.title="a deep scan is already running";}
      return;
    }
    if(btn){btn.disabled=false;btn.title="re-measure the deep tier now";}
    if(!SYSTEM){el.textContent="deep scan \u2014 not loaded";return;}
    if(!snap||!snap.measured||snap.asOf==null){
      el.textContent="deep scan \u2014 never run on this machine";
      el.title=(snap&&snap.reason)||"no snapshot has been written yet";
      el.setAttribute("data-stale","1");
      return;
    }
    // limAge, not ago(): a snapshot is a DAYS-scale artifact and the staleness
    // horizon is a week, so "240h ago" is the wrong unit for the one label that
    // has to make "older than seven days" obvious. Reusing the Limits view's
    // formatter keeps one vocabulary for "how old is this figure".
    var age=limAge(Date.now()-Math.max(0,Number(snap.ageMs)||0));
    el.textContent="deep scan \u00b7 "+age+(snap.stale?" \u00b7 stale, rescan":"")
      +(scan&&scan.error?" \u00b7 last scan reported a problem":"");
    el.title=(scan&&scan.error?scan.error+" \u2014 ":"")
      +"deep-tier figures were measured "+age+"; nothing rescans on its own";
    if(snap.stale)el.setAttribute("data-stale","1");
  }

  function renderSystem(){
    if(!SYSTEM)return;
    if(SYSTEM.error){
      var ids=["sys-kpis","sys-gauge","sys-consumers","sys-donut","sys-hostsplit","sys-growth",
        "sys-learning","sys-reclaim","sys-topsessions","sys-procs","sys-mem","sys-daemons","sys-radar",
        "sys-catcounts","sys-matrix","sys-projects"];
      var msg=sysEmpty(SYSTEM.error+(SYSTEM.reason?" \u2014 "+SYSTEM.reason:""));
      for(var i=0;i<ids.length;i++){
        var el=document.getElementById(ids[i]);
        if(el)el.innerHTML=msg;
      }
      // Liner notes qualify figures; with no figures they would qualify nothing.
      var notes=["sys-kpis-note","sys-consumers-note","sys-reclaim-note"];
      for(i=0;i<notes.length;i++){
        var n=document.getElementById(notes[i]);
        if(n)n.innerHTML="";
      }
      renderSystemFreshness();
      return;
    }
    renderSysSummary(SYSTEM);
    renderSysStorage(SYSTEM);
    renderSysRuntime(SYSTEM);
    renderSysCatalog(SYSTEM);
    renderSysProjects(SYSTEM);
    renderSystemFreshness();
  }

  // A deep refresh is a re-MEASUREMENT of local state, which is why it rides a
  // GET (ADR-0025 §5). The server answers immediately with the running scan
  // state; the poll below tracks it to completion and stops the moment it
  // settles. Nothing here starts a scan that the user did not ask for.
  // The trees flag is a SCAN parameter, not a view filter: project trees are
  // only walked when it is set, so changing it means re-measuring. Undefined
  // keeps whatever the running configuration already had.
  export function loadSystem(deep,trees){
    if(systemBusy)return Promise.resolve();
    systemBusy=true;
    if(deep&&SYSTEM&&SYSTEM.scan)SYSTEM.scan.running=true;
    renderSystemFreshness();
    var q=deep?("?refresh=deep"+(trees==null?"":"&trees="+(trees?"1":"0"))):"";
    return fetch("/api/system"+q,{cache:"no-store",headers:authHeaders()})
      .then(function(r){return r.json();})
      .then(function(d){SYSTEM=d;})
      .catch(function(){SYSTEM={error:"the system footprint could not be read",scan:null,snapshot:null};})
      .then(function(){
        systemBusy=false;
        renderSystem();
        scheduleSystemPoll();
      });
  }
  function scheduleSystemPoll(){
    if(systemPollTimer){clearTimeout(systemPollTimer);systemPollTimer=null;}
    if(!SYSTEM||!SYSTEM.scan||!SYSTEM.scan.running)return;
    // Bounded by the scan itself: the timer is only ever re-armed while the
    // server still reports it running, so a finished scan stops the polling
    // without any client-side deadline to get wrong.
    systemPollTimer=setTimeout(function(){loadSystem();},3000);
  }
  export function wireSystem(){
    var btn=document.getElementById("sys-rescan");
    if(btn)btn.addEventListener("click",function(){
      if(btn.disabled)return;
      loadSystem(true);
    });
    var ctl=document.getElementById("sys-cons-ctl");
    if(ctl)ctl.addEventListener("click",function(e){
      var m=e.target.closest?e.target.closest("[data-cons-mode]"):null;
      if(m){
        consMode=m.getAttribute("data-cons-mode");
        var chips=ctl.querySelectorAll("[data-cons-mode]");
        for(var i=0;i<chips.length;i++)
          chips[i].classList.toggle("on",chips[i].getAttribute("data-cons-mode")===consMode);
        if(SYSTEM)renderSysConsumers(SYSTEM);
        return;
      }
      var t=e.target.closest?e.target.closest("#sys-cons-trees"):null;
      if(!t||t.disabled)return;
      // Flipping the scope re-measures; the panel keeps showing the previous
      // scan's figures, correctly labelled, until the new one lands.
      loadSystem(true,t.getAttribute("aria-pressed")!=="true");
    });
  }

