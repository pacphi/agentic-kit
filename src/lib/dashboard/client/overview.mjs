// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { LEVEL_WORD, catOf, esc, gridHtml, groupRows, root, stagger } from './bootstrap.mjs';
import { intelSource } from './intelligence.mjs';
import { fmtNum } from './usage.mjs';

  function renderSummary(groups){
    var el=document.getElementById("summary");
    var f=0,w=0,g=0;
    for(var i=0;i<groups.length;i++){var L=groups[i].level;if(L==="fail")f++;else if(L==="warn")w++;else g++;}
    if(!groups.length){el.hidden=true;el.innerHTML="";return;}
    var pills=[];
    if(f)pills.push('<span class="pill" data-level="fail"><span class="dot" data-level="fail"></span><b>'+f+"</b> failing</span>");
    if(w)pills.push('<span class="pill" data-level="warn"><span class="dot" data-level="warn"></span><b>'+w+"</b> warning"+(w>1?"s":"")+"</span>");
    pills.push('<span class="pill" data-tone="calm"><span class="dot" data-level="ok"></span><b>'+g+"</b> nominal</span>");
    el.innerHTML=pills.join("");
    el.hidden=false;
  }

  function renderBadges(cats){
    var affected=0,aggregateFail=false;
    for(var c in cats){
      var el=document.getElementById("badge-"+c);
      if(!el)continue;
      var f=0,w=0;
      for(var i=0;i<cats[c].length;i++){
        var L=cats[c][i].level;
        if(L==="fail")f++; else if(L==="warn")w++;
      }
      var n=f+w;
      if(n){affected++;if(f)aggregateFail=true;}
      if(!n){el.hidden=true;el.textContent="";el.removeAttribute("data-tone");}
      else{el.hidden=false;el.textContent=String(n);el.setAttribute("data-tone",f?"fail":"warn");}
    }
    var aggregate=document.getElementById("badge-overview");
    if(aggregate){aggregate.hidden=!affected;aggregate.textContent=affected?String(affected):"";aggregate.title=affected?affected+" Overview section"+(affected===1?"":"s")+" need attention":"";aggregate.setAttribute("aria-label",aggregate.title);if(affected)aggregate.setAttribute("data-tone",aggregateFail?"fail":"warn");else aggregate.removeAttribute("data-tone");}
  }

  function tile(g){
    return '<button class="tile" type="button" data-go="'+esc(catOf(g.subsystem))+'" title="open in its tab">'
      +'<span class="dot" data-level="'+esc(g.level)+'"></span>'
      +esc(g.subsystem)
      +'<span class="tile-go">&rsaquo;</span>'
    +"</button>";
  }

  export function renderPanels(rows){
    var groups=groupRows(rows||[]);
    renderSummary(groups);

    // Overview: every attention card, in full, regardless of category.
    var attn=groups.filter(function(x){return x.level==="fail"||x.level==="warn";});
    var ael=document.getElementById("attention");
    if(!groups.length){
      ael.innerHTML='<div class="empty">no subsystem rows reported.</div>';
    }else if(attn.length){
      ael.innerHTML=gridHtml(attn); stagger(ael);
    }else{
      ael.innerHTML='<div class="allclear"><span class="dot" data-level="ok"></span>All systems nominal — nothing needs attention.</div>';
    }

    // Overview: compact status map of every subsystem; tiles jump to the tab.
    var mh=document.getElementById("map-head");
    document.getElementById("statusmap").innerHTML=groups.map(tile).join("");
    mh.hidden=!groups.length;

    // Category panels.
    var cats={hosts:[],providers:[],runtime:[],intel:[]};
    for(var i=0;i<groups.length;i++)cats[catOf(groups[i].subsystem)].push(groups[i]);
    for(var c in cats){
      var el=document.getElementById("cards-"+c);
      if(!el)continue;
      if(cats[c].length){el.innerHTML=gridHtml(cats[c]); stagger(el);}
      else{el.innerHTML='<div class="empty">nothing reported here.</div>';}
    }
    renderBadges(cats);
  }

  export function renderVerdict(overall){
    var dot=document.getElementById("verdict-dot");
    var txt=document.getElementById("verdict-text");
    dot.setAttribute("data-level",overall||"unknown");
    dot.className="dot";
    txt.textContent=LEVEL_WORD[overall]||LEVEL_WORD.unknown;
  }

  // Update drift renders as a quiet notice line in Overview — no banner. The
  // versions cards still carry the per-tool detail. (noticeHtml: ./groups.mjs.)
  function noticeHtml(drift) { return String(drift); } // PLACEHOLDER:noticeHtml
  export function renderNotice(drift){
    var b=document.getElementById("update-notice");
    var html=noticeHtml(drift);
    if(!html){b.hidden=true;b.innerHTML="";return;}
    b.innerHTML=html;
    b.hidden=false;
  }

  // ── sparkline (pure SVG) ──
  function accent(){return getComputedStyle(root).getPropertyValue("--accent").trim()||"#0a84ff";}
  function sparkline(values){
    var W=100,H=32,pad=3;
    if(!values.length)return "";
    var min=Math.min.apply(null,values),max=Math.max.apply(null,values);
    var span=max-min||1;
    var n=values.length;
    var x=function(i){return pad+(n===1?0:(i/(n-1))*(W-2*pad));};
    var y=function(v){return H-pad-((v-min)/span)*(H-2*pad);};
    var d="",area="";
    for(var i=0;i<n;i++){d+=(i?" L":"M")+x(i).toFixed(1)+" "+y(values[i]).toFixed(1);}
    area="M"+x(0).toFixed(1)+" "+(H-pad)+" L"+x(0).toFixed(1)+" "+y(values[0]).toFixed(1)
        +d.replace(/^M[^L]*/,"")+" L"+x(n-1).toFixed(1)+" "+(H-pad)+" Z";
    var col=accent(),lastX=x(n-1).toFixed(1),lastY=y(values[n-1]).toFixed(1);
    var gid="g"+Math.random().toString(36).slice(2,8);
    return '<svg viewBox="0 0 '+W+" "+H+'" preserveAspectRatio="none" role="img">'
      +'<defs><linearGradient id="'+gid+'" x1="0" x2="0" y1="0" y2="1">'
        +'<stop offset="0" stop-color="'+col+'" stop-opacity="0.28"/>'
        +'<stop offset="1" stop-color="'+col+'" stop-opacity="0"/>'
      +"</linearGradient></defs>"
      +'<path d="'+area+'" fill="url(#'+gid+')"/>'
      +'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      +'<circle cx="'+lastX+'" cy="'+lastY+'" r="1.9" fill="'+col+'"/>'
    +"</svg>";
  }
  function flat(msg){return '<div class="empty" style="padding:14px 0">'+esc(msg)+"</div>";}

  // renderHistory was one CC-63 function mixing four independent data-shaping
  // computations (patterns/deltas, pattern-store series, graph series, curve
  // values -- each dense with ternaries/&&/||, which is what drove the count)
  // with five independent sparkline renders. Split by concern; every
  // computation and every render keeps its original logic verbatim, so the
  // rendered DOM is unchanged.
  function historySeriesAndDeltas(data,series){
    var pats=[],deltas=[];
    for(var i=0;i<series.length;i++){
      var s=series[i];
      if(typeof s.patternsLearned==="number")pats.push(s.patternsLearned);
      var dp=(typeof s.deltaPP==="number")?s.deltaPP:(s.improvement&&typeof s.improvement.deltaPP==="number"?s.improvement.deltaPP:null);
      if(dp!=null)deltas.push(dp);
    }
    // fall back to a single improvement snapshot for the Δpp spark
    if(!deltas.length&&data.improvement&&typeof data.improvement.deltaPP==="number"){deltas=[data.improvement.deltaPP];}

    return {pats:pats,deltas:deltas};
  }

  function historyPatternStoreSeries(data){
    // ── neural pattern store: entries CURRENTLY on disk
    // (.claude-flow/neural/patterns.json), shipped un-bucketed — bucketed and
    // summed by day-of-creation here. A point-in-time inventory of the
    // store's live contents, NOT the same figure as the patternsLearned
    // lifetime counter charted above (that counter only ever climbs; this
    // store can be pruned/compacted). See intel-history.mjs's header comment.
    var byDay={},storeEntries=Array.isArray(data.patternStore)?data.patternStore:[];
    for(var j=0;j<storeEntries.length;j++){
      var entry=storeEntries[j];
      var day=entry&&typeof entry.createdAt==="string"?entry.createdAt.slice(0,10):null;
      if(!day)continue;
      byDay[day]=(byDay[day]||0)+1;
    }
    var days=Object.keys(byDay).sort();
    var storeSeries=[],storeTotal=0;
    for(var d=0;d<days.length;d++){storeTotal+=byDay[days[d]];storeSeries.push(storeTotal);}

    return {storeSeries:storeSeries,storeTotal:storeTotal};
  }

  function historyGraphSeries(data){
    // ── reasoning graph: point-in-time size samples
    // (.claude-flow/data/intelligence-snapshot.json) — a structural-growth
    // series independent of the pattern-count metrics above.
    var graphArr=Array.isArray(data.graph)?data.graph:[];
    var nodesSeries=graphArr.map(function(g){return Number(g&&g.nodes)||0;});
    var lastGraph=graphArr.length?graphArr[graphArr.length-1]:null;

    return {nodesSeries:nodesSeries,lastGraph:lastGraph};
  }

  function historyCurveValues(imp){
    var curveArr=(imp&&Array.isArray(imp.curve))?imp.curve:[];
    var curveVals=curveArr.map(function(c){return Number(c&&c.acc)||0;});
    return curveVals;
  }

  function renderPatternsSpark(pats){
    document.getElementById("spark-patterns").innerHTML=pats.length>1?sparkline(pats):flat(pats.length?String(pats[0])+" (one sample)":"no data");
  }

  function renderPatternStoreSpark(storeSeries,storeTotal){
    document.getElementById("spark-pattern-store").innerHTML=storeSeries.length>1?sparkline(storeSeries):flat(storeSeries.length?String(storeTotal)+" entries (one day)":"no data");
  }

  function renderGraphSpark(nodesSeries,lastGraph){
    document.getElementById("spark-graph").innerHTML=nodesSeries.length>1?sparkline(nodesSeries):flat(nodesSeries.length?String(nodesSeries[0])+" nodes (one sample)":"no data");
    var graphMeta=document.getElementById("graph-meta");
    if(graphMeta)graphMeta.textContent=lastGraph?("latest: "+fmtNum(lastGraph.nodes)+" nodes · "+fmtNum(lastGraph.edges)+" edges"):"";
  }

  function renderDeltaSpark(deltas,imp){
    document.getElementById("spark-delta").innerHTML=deltas.length>1?sparkline(deltas):flat(deltas.length?(deltas[0]>=0?"+":"")+deltas[0]+"pp (one sample)":"no data");
    var deltaMeta=document.getElementById("delta-meta");
    if(deltaMeta){
      var verdict=imp&&typeof imp.verdict==="string"?imp.verdict:null;
      var pVal=imp&&typeof imp.pValue==="number"?imp.pValue:null;
      var dVal=imp&&typeof imp.cohensD==="number"?imp.cohensD:null;
      if(!verdict&&pVal==null&&dVal==null){deltaMeta.hidden=true;deltaMeta.innerHTML="";}
      else{
        var lvl=verdict==="PASS"?"ok":"warn";
        var pTxt=pVal==null?"—":(pVal<0.001?"<.001":"="+pVal);
        var dTxt=dVal==null?"—":dVal.toFixed(2);
        deltaMeta.hidden=false;
        deltaMeta.innerHTML=(verdict?'<span class="pill" data-level="'+lvl+'"><span class="dot" data-level="'+lvl+'"></span><b>'+esc(verdict)+"</b></span>":"")
          +'<span class="mono" style="margin-left:8px;color:var(--ink-dim)">p'+esc(pTxt)+" · d="+esc(dTxt)+"</span>";
      }
    }
  }

  function renderCurveSpark(curveVals){
    document.getElementById("spark-curve").innerHTML=curveVals.length>1?sparkline(curveVals):flat(curveVals.length?(curveVals[0]*100).toFixed(0)+"% (one sample)":"no data");
  }

  export function renderHistory(data){
    var strip=document.getElementById("history");
    var note=document.getElementById("strip-note");
    var series=[];
    if(data.health&&data.health.length){series=data.health;}
    var sd=historySeriesAndDeltas(data,series),pats=sd.pats,deltas=sd.deltas;
    var ps=historyPatternStoreSeries(data),storeSeries=ps.storeSeries,storeTotal=ps.storeTotal;
    var gs=historyGraphSeries(data),nodesSeries=gs.nodesSeries,lastGraph=gs.lastGraph;
    var imp=data.improvement||null;
    var curveVals=historyCurveValues(imp);

    // The project PICKER lives in this strip's head, so the strip itself must
    // stay visible even when the selected project has nothing to chart —
    // hiding it would strand the user on an empty project with no control to
    // pick a different one. Only the charts collapse.
    var sparkRow=document.getElementById("spark-row");
    var emptyEl=document.getElementById("history-empty");
    var nothing=!pats.length&&!deltas.length&&!storeSeries.length&&!nodesSeries.length&&!curveVals.length;
    strip.hidden=false;
    if(sparkRow)sparkRow.hidden=nothing;
    if(emptyEl){
      emptyEl.hidden=!nothing;
      if(nothing)emptyEl.textContent="no learning history recorded for "+(selectedProjectLabel||"this project")+" yet.";
    }
    if(nothing){note.textContent="";return;}
    note.textContent=(series.length?series.length+" samples":"snapshot")+(intelSource?" · live":"");

    renderPatternsSpark(pats);
    renderPatternStoreSpark(storeSeries,storeTotal);
    renderGraphSpark(nodesSeries,lastGraph);
    renderDeltaSpark(deltas,imp);
    renderCurveSpark(curveVals);
  }

