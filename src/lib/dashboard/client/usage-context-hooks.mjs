// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs.
import { authHeaders, esc } from './bootstrap.mjs';

  export var HOOKS=null,hooksBusy=null;

  function ctxTokens(value){
    var n=Number(value);
    if(!Number.isFinite(n))return "unknown";
    if(n>=1000000)return (n/1000000).toFixed(1)+"M";
    if(n>=1000)return Math.round(n/1000)+"K";
    return String(Math.round(n));
  }

  function ctxState(state){
    if(state==="observed")return "Observed";
    if(state==="partial")return "Partial evidence";
    if(state==="not-recorded")return "Not recorded";
    return "Not observed";
  }

  export function contextMeter(label,bps){
    var known=bps!==null&&bps!==undefined&&Number.isFinite(Number(bps));
    var actual=known?Math.max(0,Number(bps)/100):null;
    var bounded=known?Math.min(100,actual):0;
    var valueAttr=known?' aria-valuenow="'+bounded.toFixed(1)+'" aria-valuetext="'+actual.toFixed(1)+' percent"':'';
    return '<div class="ctx-meter" role="meter" aria-label="'+esc(label)+'" aria-valuemin="0" aria-valuemax="100"'+valueAttr+'>'
      +'<span class="ctx-meter-track"><i style="width:'+bounded.toFixed(1)+'%"></i></span>'
      +'<span class="ctx-meter-value mono">'+(known?actual.toFixed(1)+"%":"unknown")+'</span></div>';
  }

  function contextHostCard(host,fold){
    fold=fold||{};
    var coverage=fold.coverage||{},state=coverage.state||"not-observed";
    var peak=fold.pressureBps&&fold.pressureBps.peak&&fold.pressureBps.peak.p90;
    var windowMedian=fold.windowTokens&&fold.windowTokens.median;
    var inputPeak=fold.inputTokens&&fold.inputTokens.peak&&fold.inputTokens.peak.p90;
    return '<article class="ctx-card" data-state="'+esc(state)+'">'
      +'<div class="ctx-card-head"><h2>'+esc(host)+'</h2><span class="ctx-state">'+esc(ctxState(state))+'</span></div>'
      +contextMeter(host+' p90 peak context pressure',peak)
      +'<dl class="ctx-facts"><div><dt>sessions</dt><dd>'+esc(coverage.sessions||0)+'</dd></div>'
      +'<div><dt>paired samples</dt><dd>'+esc(coverage.pressureMeasured||0)+'</dd></div>'
      +'<div><dt>p90 peak input</dt><dd>'+esc(ctxTokens(inputPeak))+'</dd></div>'
      +'<div><dt>median window</dt><dd>'+esc(ctxTokens(windowMedian))+'</dd></div></dl>'
      +'<p class="ctx-caveat">'+(state==="observed"?'Input and window were observed together for every session in this slice.'
        :state==="partial"?'Some input or window evidence exists, but not every session has a paired pressure sample.'
          :'No paired runtime context evidence was recorded for this host in the selected window.')+'</p></article>';
  }

  function contextAttentionAction(state){
    if(state==="over-window")return "Start a new session now";
    if(state==="handoff")return "Start a new session";
    if(state==="compact")return "Compact context";
    if(state==="warn")return "Monitor context";
    if(state==="startup-critical")return "Reduce startup context";
    return "Review context";
  }

  function contextStarted(value){
    if(!value)return "unknown";
    var d=new Date(value);
    if(!Number.isFinite(d.getTime()))return "unknown";
    return d.toISOString().slice(0,10);
  }

  function contextAttentionGroups(rows){
    var groups=[],byKey=Object.create(null);
    for(var i=0;i<rows.length;i++){
      var row=rows[i]||{},project=String(row.project||"unknown").normalize("NFKC").trim().replace(/\s+/g," ")||"unknown";
      var fallback="label:"+project.toLocaleLowerCase("en-US");
      var key=/^project:[a-f0-9]{16}$/.test(String(row.projectKey||""))?String(row.projectKey):fallback,group=byKey[key];
      if(!group){group={key:key,project:project,rows:[]};byKey[key]=group;groups.push(group);}
      group.rows.push(row);
    }
    return groups;
  }

  function contextAttentionTable(group){
    var rows=group.rows.map(function(row){
      var id=String(row.id||"");
      var pressure=row.peakBps==null?"unknown":(Number(row.peakBps)/100).toFixed(1)+"%";
      var started=contextStarted(row.start);
      return '<tr><td>'+esc(row.title||"(untitled conversation)")+'</td>'
        +'<th scope="row"><a class="ctx-session-link mono" href="#usage/'+encodeURIComponent(id)
        +'" data-id="'+esc(id)+'" aria-label="Open session '+esc(row.sessionRef||"reference")+'">'
        +esc(row.sessionRef||"unavailable")+'</a></th>'
        +'<td>'+esc(row.host||"unknown")+'</td>'
        +'<td>'+esc(contextAttentionAction(row.state))+'</td>'
        +'<td class="mono tnum">'+esc(pressure)+'</td>'
        +'<td class="mono tnum">'+esc(ctxTokens(row.peakInputTokens))+'</td>'
        +'<td class="mono tnum">'+esc(ctxTokens(row.windowTokens))+'</td>'
        +'<td><time'+(started!=="unknown"?' datetime="'+esc(row.start)+'"':'')+'>'+esc(started)+'</time></td></tr>';
    }).join("");
    return '<div class="ctx-att-table-wrap" role="region" tabindex="0" aria-label="Sessions needing attention for project '+esc(group.project)+'"><table class="ctx-att-table">'
      +'<caption class="sr-only">Sessions needing attention for '+esc(group.project)+'</caption>'
      +'<thead><tr><th scope="col">Conversation</th><th scope="col">Session</th><th scope="col">Host</th>'
      +'<th scope="col">Recommended action</th><th scope="col">Peak pressure</th>'
      +'<th scope="col">Peak input</th><th scope="col">Context window</th><th scope="col">Started</th>'
      +'</tr></thead><tbody>'+rows+'</tbody></table></div>';
  }

  function contextAttentionMarkup(attention,openGroups){
    return contextAttentionGroups(attention).map(function(group){
      var open=openGroups[group.key]?' open':'';
      return '<details class="ctx-att-group" data-context-group="'+esc(group.key)+'"'+open+'><summary>'
        +'<span class="chev ctx-att-chevron" aria-hidden="true">&rsaquo;</span><span class="ctx-att-project">'+esc(group.project)+'</span></summary>'
        +contextAttentionTable(group)+'</details>';
    }).join("");
  }

  export function renderContext(context){
    var policyEl=document.getElementById("u-ctx-policy"),summaryEl=document.getElementById("u-ctx-summary");
    var hostsEl=document.getElementById("u-ctx-hosts"),attentionEl=document.getElementById("u-ctx-attention");
    if(!policyEl||!summaryEl||!hostsEl||!attentionEl)return;
    var policy=context&&context.policy||{};
    function percent(key){return Number.isFinite(Number(policy[key]))?(Number(policy[key])/100).toFixed(0)+"%":"unknown";}
    policyEl.innerHTML='<span><b>startup</b> target '+percent("startupTargetBps")+' · warning '+percent("startupWarningBps")+' · critical '+percent("startupCriticalBps")+'</span>'
      +'<span><b>dynamic</b> warn '+percent("dynamicWarningBps")+' · compact '+percent("dynamicCompactBps")+' · handoff '+percent("dynamicHandoffBps")+'</span>'
      +'<span><b>reserve</b> '+percent("reserveBps")+'</span>';
    if(!context){
      summaryEl.innerHTML='<div class="empty">Context evidence is unavailable. Pressure remains unknown.</div>';
      hostsEl.innerHTML=["claude","codex","opencode"].map(function(host){return contextHostCard(host,null);}).join("");
      attentionEl.innerHTML='<div class="empty">No context attention list is available.</div>';
      return;
    }
    var coverage=context.summary&&context.summary.coverage||{};
    summaryEl.innerHTML='<p><b>'+esc(ctxState(coverage.state))+'</b> · '+esc(coverage.pressureMeasured||0)+' of '+esc(coverage.sessions||0)
      +' sessions have paired input/window pressure evidence; '+esc(coverage.missingWindow||0)+' lack an observed window.</p>';
    var byHost=context.byHost||{};
    hostsEl.innerHTML=["claude","codex","opencode"].map(function(host){return contextHostCard(host,byHost[host]);}).join("");
    var attention=Array.isArray(context.attention)?context.attention:[];
    var openGroups=Object.create(null),open=attentionEl.querySelectorAll("details[data-context-group][open]");
    for(var i=0;i<open.length;i++)openGroups[open[i].getAttribute("data-context-group")]=true;
    attentionEl.innerHTML=attention.length?contextAttentionMarkup(attention,openGroups)
      :'<div class="empty">No session crossed a configured attention threshold in this window.</div>';
  }

  function hookKpi(label,value,detail){
    return '<div class="hook-kpi"><span>'+esc(label)+'</span><b class="mono">'+esc(value)+'</b><small>'+esc(detail)+'</small></div>';
  }

  function hookTimeout(definition){
    var timeout=definition&&definition.timeout;
    if(!timeout)return "Not declared";
    var declared=timeout.declared==null?"default":String(timeout.declared);
    var effective=timeout.effective==null?"not established":String(timeout.effective);
    return declared+" "+(timeout.units||"")+" declared · "+effective+" effective";
  }

  function hookPlacementMarkup(placement,group){
    var source=placement.source||{},button=source.ref
      ?'<button type="button" class="hook-source-button" data-hook-source="'+esc(source.ref)
        +'" aria-label="Inspect '+esc(group.lifecyclePoint||"hook")+' definition in '+esc(source.label||"configuration source")+'">Inspect source</button>'
      :'<span class="hook-no-source">Location unavailable</span>';
    return '<li><span><b>'+esc(source.label||"Configuration source")+'</b><small>'+esc(placement.owner||"Not established")
      +' · '+esc(placement.authority||"not established")+' · '+esc(placement.selectionState||"not determined")+'</small></span>'+button+'</li>';
  }

  function hookDefinitionTable(groups){
    if(!groups.length)return '<div class="empty">No hook definitions were found in the inspected sources.</div>';
    var rows=groups.map(function(group){
      var placements=Array.isArray(group.placements)?group.placements:[],findingCount=(group.findingIds||[]).length;
      var sources=[];for(var i=0;i<placements.length;i++){var label=placements[i].source&&placements[i].source.label||"Configuration source";if(sources.indexOf(label)<0)sources.push(label);}
      return '<tr><th scope="row">'+esc(group.lifecyclePoint||"unknown")+'</th>'
        +'<td><details class="hook-definition"><summary>'+esc(group.handlerKind||"unknown")+'</summary>'
        +'<div class="hook-definition-body"><p>'+esc(hookTimeout(group.definition))+'</p><ul>'
        +placements.map(function(placement){return hookPlacementMarkup(placement,group);}).join("")+'</ul></div></details></td>'
        +'<td>'+esc(group.host||"unknown")+'</td><td>'+esc(sources.join(", ")||"unknown")+'</td>'
        +'<td class="tnum">'+esc(placements.length)+' placement'+(placements.length===1?'':'s')+'</td>'
        +'<td class="tnum">'+esc(findingCount||"None")+'</td></tr>';
    }).join("");
    return '<div class="hook-table-wrap hook-definition-wrap" role="region" aria-label="Configured hook definitions; five collapsed rows visible before scrolling" tabindex="0"><table class="hook-table">'
      +'<caption class="sr-only">Configured hooks grouped by distinct normalized behavior.</caption><thead><tr>'
      +'<th scope="col">Lifecycle point</th><th scope="col">Definition</th><th scope="col">Host</th>'
      +'<th scope="col">Configured in</th><th scope="col">Placements</th><th scope="col">Findings</th>'
      +'</tr></thead><tbody>'+rows+'</tbody></table></div>';
  }

  function hookFindingTable(findings){
    if(!findings.length)return '<div class="empty">No actionable configuration finding was recorded. This does not prove runtime success.</div>';
    var rows=findings.map(function(finding){
      var action=finding.action?(finding.action.href
        ?'<a class="hook-upstream-link" href="'+esc(finding.action.href)+'" target="_blank" rel="noreferrer">'+esc(finding.action.label||"View upstream issue")+'</a>'
        :'<span class="hook-action"><b>'+esc(finding.action.label||"Preview repair")+'</b>'
          +'<code>ak heal hooks --host '+esc(finding.host||"all")+'</code></span>')
        :'<span class="hook-no-action">'+esc(finding.disposition||"No evidence-backed action")+'</span>';
      return '<tr><td><span class="hook-sev">'+esc(finding.severity||"unknown")+'</span></td>'
        +'<th scope="row"><b>'+esc(finding.title||"Finding")+'</b><small>'+esc(finding.explanation||"")
        +' · code '+esc(finding.code||"unknown")+'</small></th><td>'+esc(finding.lifecyclePoint||"unknown")+'</td>'
        +'<td>'+esc(finding.host||"unknown")+'</td><td class="tnum">'+esc(finding.affectedDefinitions||0)
        +' definition'+(finding.affectedDefinitions===1?'':'s')+'</td><td>'+esc(finding.owner||"Not established")+'</td><td>'+action+'</td></tr>';
    }).join("");
    return '<div class="hook-table-wrap" role="region" aria-label="Hook findings needing attention" tabindex="0"><table class="hook-table hook-findings-table">'
      +'<caption class="sr-only">Static hook configuration findings and evidence-bound next steps.</caption><thead><tr>'
      +'<th scope="col">Importance</th><th scope="col">Finding</th><th scope="col">Lifecycle point</th><th scope="col">Host</th>'
      +'<th scope="col">Affected definitions</th><th scope="col">Owner</th><th scope="col">Next step</th>'
      +'</tr></thead><tbody>'+rows+'</tbody></table></div>';
  }

  function hookRuntimeTable(runtime){
    var rows=runtime&&Array.isArray(runtime.byHost)?runtime.byHost:[];
    if(!runtime||runtime.state!=="observed"||!rows.length)return '<div class="empty">No execution receipts were supplied to this dashboard. Hook successes, failures, and timeouts are therefore unknown.</div>';
    return '<div class="hook-table-wrap" role="region" aria-label="Observed hook runtime outcomes" tabindex="0"><table class="hook-table">'
      +'<caption class="sr-only">Bounded hook execution receipts by host and lifecycle point.</caption><thead><tr>'
      +'<th scope="col">Host</th><th scope="col">Lifecycle point</th><th scope="col">Runs observed</th>'
      +'<th scope="col">Successful</th><th scope="col">Failed</th><th scope="col">Timed out</th></tr></thead><tbody>'
      +rows.map(function(row){return '<tr><th scope="row">'+esc(row.host||"unknown")+'</th><td>'+esc(row.lifecyclePoint||"unknown")
        +'</td><td class="tnum">'+esc(row.executions||0)+'</td><td class="tnum">'+esc(row.successes||0)
        +'</td><td class="tnum">'+esc(row.failures||0)+'</td><td class="tnum">'+esc(row.timeouts||0)+'</td></tr>';}).join("")
      +'</tbody></table></div><p class="hook-runtime-note">'+esc(runtime.receiptsInspected||0)+' retained receipt'
      +(runtime.receiptsInspected===1?'':'s')+(runtime.receiptsTruncated?' · older receipts omitted':'')+'. Configuration findings above are separate evidence.</p>';
  }

  function hookElements(){
    return {
      panel:document.getElementById("v-hooks"),status:document.getElementById("u-hook-status"),
      config:document.getElementById("u-hook-config"),stop:document.getElementById("u-hook-stop"),
      runtime:document.getElementById("u-hook-runtime"),diagnostics:document.getElementById("u-hook-diagnostics")
    };
  }

  function closeHookSourceDialog(){
    var dialog=document.getElementById("u-hook-source-dialog");
    if(!dialog)return;
    if(typeof dialog.close==="function"&&dialog.open)dialog.close();else dialog.removeAttribute("open");
  }

  function requestHookSource(ref){
    return fetch("/api/hooks/source/"+encodeURIComponent(ref),{cache:"no-store",headers:authHeaders()}).then(function(response){
      return response.json().then(function(body){
        if(response.ok)return body;
        var error=new Error(body&&body.error||"Hook source unavailable.");
        error.code=body&&body.code||"HOOK_SOURCE_UNAVAILABLE";
        error.recovery=body&&body.recovery||"Close this view, refresh Hooks, and try again.";
        throw error;
      });
    });
  }

  function renderHookSourceDetail(detail,body){
    var location=body.location||{},definition=body.definition||{},format=String(definition.format||body.format||"text").toUpperCase();
    detail.innerHTML='<p class="hook-source-explanation">'+esc(body.explanation||"This is the masked definition selected from the audited source.")+'</p>'
      +'<dl class="hook-source-facts"><div><dt>Host</dt><dd>'+esc(body.host||"unknown")+'</dd></div>'
      +'<div><dt>Lifecycle point</dt><dd>'+esc(body.lifecyclePoint||"unknown")+'</dd></div>'
      +'<div><dt>Source format</dt><dd>'+esc(format)+'</dd></div>'
      +'<div><dt>Source type</dt><dd>'+esc(body.sourceKind||"unknown")+'</dd></div>'
      +'<div><dt>Physical location</dt><dd><code>'+esc(location.absolutePath||location.displayPath||"unavailable")+'</code></dd></div>'
      +'<div><dt>Definition selector</dt><dd><code>'+esc(location.selector||"whole file")+'</code></dd></div>'
      +'<div><dt>Owner evidence</dt><dd>'+esc(body.owner||"not established")+'</dd></div>'
      +'<div><dt>Presentation</dt><dd>'+(body.redacted?"Masked read-only copy":"Read-only copy")+'</dd></div></dl>'
      +(definition.status==="available"?'<h3>Masked '+esc(format)+' definition</h3><pre aria-label="Masked '+esc(format)+' hook definition"><code data-format="'+esc(String(definition.format||"text"))+'">'+esc(JSON.stringify(definition.value,null,2))+'</code></pre>'
        :'<div class="hook-source-unavailable" role="status"><b>Definition presentation unavailable</b><p>'+esc(body.unavailableReason||"A bounded definition is unavailable for this source format.")+'</p></div>');
  }

  function renderHookSourceError(detail,error){
    detail.innerHTML='<div class="hook-source-unavailable" role="alert"><b>Hook definition unavailable</b><p>'
      +esc(error&&error.message||"The audited source could not be opened.")+'</p><p>'
      +esc(error&&error.recovery||"Close this view, refresh Hooks, and try again.")+'</p></div>';
  }

  function showHookSource(ref){
    var dialog=document.getElementById("u-hook-source-dialog"),detail=document.getElementById("u-hook-source-detail");
    if(!dialog||!detail)return;
    detail.innerHTML='<div class="empty">Loading the audited source.</div>';
    if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");
    requestHookSource(ref).then(function(body){renderHookSourceDetail(detail,body);}).catch(function(error){
      if(error&&error.code==="HOOK_SOURCE_NOT_FOUND"){
        detail.innerHTML='<div class="empty">The audited reference expired. Refreshing hook evidence.</div>';
        return loadHooks(true).then(function(){return requestHookSource(ref);})
          .then(function(body){renderHookSourceDetail(detail,body);})
          .catch(function(retryError){renderHookSourceError(detail,retryError);});
      }
      if(error&&error.code==="HOOK_SOURCE_CHANGED"){
        return loadHooks(true).then(function(){renderHookSourceError(detail,error);});
      }
      renderHookSourceError(detail,error);
    });
  }

  function wireHookSources(elements){
    if(elements.panel.getAttribute("data-hook-source-wired")==="true")return;
    elements.panel.setAttribute("data-hook-source-wired","true");
    elements.panel.addEventListener("click",function(event){
      var button=event.target&&event.target.closest?event.target.closest("[data-hook-source]"):null;
      if(button){event.preventDefault();showHookSource(button.getAttribute("data-hook-source")||"");}
    });
    var close=document.getElementById("u-hook-source-close");if(close)close.addEventListener("click",closeHookSourceDialog);
  }

  function renderHookUnknown(elements,model){
    elements.panel.setAttribute("aria-busy",hooksBusy?"true":"false");
    var reason=model&&model.error?"Hook audit unavailable.":"Hook audit not loaded. Runtime outcomes are unknown.";
    elements.config.innerHTML='<div class="empty">'+esc(reason)+'</div>';
    elements.stop.innerHTML='<div class="empty">Hook definitions are unknown.</div>';
    elements.runtime.innerHTML='<div class="empty">Runtime outcomes are unknown; no bounded receipts are available.</div>';
    elements.diagnostics.innerHTML='<div class="empty">Diagnostic ownership is unknown.</div>';
    if(elements.status)elements.status.textContent=reason;
  }

  function renderHookEvidence(elements,model){
    elements.panel.setAttribute("aria-busy","false");
    var summary=model.summary||{},groups=Array.isArray(model.definitionGroups)?model.definitionGroups:[];
    var findings=Array.isArray(model.findings)?model.findings:[];
    elements.config.innerHTML='<div class="hook-kpis">'
      +hookKpi("configured entries",summary.configuredEntries||0,"physical placements")
      +hookKpi("distinct behaviors",summary.distinctBehaviors||0,"normalized definitions")
      +hookKpi("repeated placements",summary.repeatedPlacements||0,"additional equivalent entries")
      +hookKpi("unreadable sources",summary.unreadableSources||0,(summary.sourcesInspected||0)+" inspected")+'</div>';
    elements.stop.innerHTML=hookDefinitionTable(groups);
    elements.runtime.innerHTML=hookRuntimeTable(model.runtime||null);
    elements.diagnostics.innerHTML=hookFindingTable(findings);
    if(elements.status)elements.status.textContent="Hook configuration evidence loaded. Runtime outcomes are reported separately.";
  }

  export function renderHooks(model){
    var elements=hookElements();
    if(!elements.panel||!elements.config||!elements.stop||!elements.runtime||!elements.diagnostics)return;
    wireHookSources(elements);
    if(!model||model.error)renderHookUnknown(elements,model);else renderHookEvidence(elements,model);
  }

  export function activateUsageEvidenceView(view,usage){
    if(view==="context")renderContext(usage&&usage.context||null);
    if(view==="hooks")loadHooks();
  }

  export function loadHooks(force){
    if(hooksBusy)return hooksBusy;
    if(!force&&HOOKS){renderHooks(HOOKS);return Promise.resolve(HOOKS);}
    var panel=document.getElementById("v-hooks"),status=document.getElementById("u-hook-status");
    if(panel)panel.setAttribute("aria-busy","true");
    if(status)status.textContent="Loading read-only hook configuration evidence.";
    hooksBusy=fetch("/api/hooks?host=all",{cache:"no-store",headers:authHeaders()}).then(function(response){
      return response.json().then(function(body){if(!response.ok)throw new Error(body&&body.error||"unavailable");return body;});
    }).then(function(body){HOOKS=body;return body;}).catch(function(){
      HOOKS={error:"hook audit unavailable"};return HOOKS;
    }).then(function(body){renderHooks(body);return body;}).finally(function(){hooksBusy=null;});
    return hooksBusy;
  }
