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
    attentionEl.innerHTML=attention.length?attention.map(function(row){
      return '<div class="ctx-att-row"><span class="ctx-att-state">'+esc(row.state||"attention")+'</span>'
        +'<span><b>'+esc(row.host||"unknown")+'</b> · '+esc(row.project||"unknown")+'</span>'
        +'<span class="mono">peak '+esc(row.peakBps==null?"unknown":(Number(row.peakBps)/100).toFixed(1)+"%")
        +' · '+esc(ctxTokens(row.peakInputTokens))+' / '+esc(ctxTokens(row.windowTokens))+'</span></div>';
    }).join(""):'<div class="empty">No session crossed a configured attention threshold in this window.</div>';
  }

  function hookKpi(label,value,detail){
    return '<div class="hook-kpi"><span>'+esc(label)+'</span><b class="mono">'+esc(value)+'</b><small>'+esc(detail)+'</small></div>';
  }

  function hookDiagnosticRows(rows){
    return rows.length?rows.map(function(row){
      return '<div class="hook-row"><span class="hook-sev">'+esc(row.severity||"unknown")+'</span>'
        +'<span><b>'+esc(row.event||"unknown")+'</b> · '+esc(row.code||"unknown")+'</span>'
        +'<span class="mono">'+esc(row.host||"unknown")+' × '+esc(row.count||0)+'</span></div>';
    }).join(""):'<div class="empty">No sanitized diagnostic codes were recorded.</div>';
  }

  function hookElements(){
    return {
      panel:document.getElementById("v-hooks"),status:document.getElementById("u-hook-status"),
      config:document.getElementById("u-hook-config"),stop:document.getElementById("u-hook-stop"),
      runtime:document.getElementById("u-hook-runtime"),diagnostics:document.getElementById("u-hook-diagnostics")
    };
  }

  function renderHookUnknown(elements,model){
    elements.panel.setAttribute("aria-busy",hooksBusy?"true":"false");
    var reason=model&&model.error?"Hook audit unavailable.":"Hook audit not loaded. Runtime outcomes are unknown.";
    elements.config.innerHTML='<div class="empty">'+esc(reason)+'</div>';
    elements.stop.innerHTML='<div class="empty">Stop configuration is unknown.</div>';
    elements.runtime.innerHTML='<div class="empty">Runtime outcomes are unknown; no bounded receipts are available.</div>';
    elements.diagnostics.innerHTML='<div class="empty">Diagnostic ownership is unknown.</div>';
    if(elements.status)elements.status.textContent=reason;
  }

  function renderHookEvidence(elements,model){
    elements.panel.setAttribute("aria-busy","false");
    var summary=model.summary||{},actions=model.actions||{},rows=Array.isArray(model.diagnostics)?model.diagnostics:[];
    elements.config.innerHTML='<div class="hook-kpis">'
      +hookKpi("configured hooks",summary.configuredHooks||0,"occurrences")
      +hookKpi("unique behavior",summary.uniqueBehaviors||0,"normalized definitions")
      +hookKpi("configuration issues",summary.configurationIssues||0,"static evidence")+'</div>';
    var stopRows=rows.filter(function(row){return String(row.event||"").toLowerCase()==="stop";});
    elements.stop.innerHTML=stopRows.length?hookDiagnosticRows(stopRows)
      :'<div class="empty">No Stop-specific diagnostic code was recorded. This does not prove runtime success.</div>';
    var receipts=model.runtime&&Array.isArray(model.runtime.recent)?model.runtime.recent:[];
    var stopReceipts=receipts.filter(function(row){return String(row.verb||"").toLowerCase()==="stop";});
    elements.runtime.innerHTML=receipts.length?'<div class="hook-kpis">'
      +hookKpi("executions",summary.executions||0,"bounded receipts")
      +hookKpi("failures",summary.failures||0,"all hook verbs")
      +hookKpi("timeouts",summary.timeouts||0,"all hook verbs")+'</div>'
      +'<div class="hook-runtime-note">Stop runtime receipts: <b>'+esc(stopReceipts.length)+'</b> of '+esc(receipts.length)
      +' retained. Configuration findings above are not runtime outcomes.</div>'
      :'<div class="empty">Runtime outcomes are unknown; no bounded execution receipts were available.</div>';
    elements.diagnostics.innerHTML='<div class="hook-actions">'
      +hookKpi("automatic",actions.automaticEligible||0,"eligible")
      +hookKpi("approval",actions.approvalRequired||0,"required")
      +hookKpi("prohibited",actions.prohibited||0,"never automatic")
      +hookKpi("upstream",actions.upstreamRequired||0,"owner action")+'</div>'+hookDiagnosticRows(rows);
    if(elements.status)elements.status.textContent="Hook configuration evidence loaded. Runtime outcomes are reported separately.";
  }

  export function renderHooks(model){
    var elements=hookElements();
    if(!elements.panel||!elements.config||!elements.stop||!elements.runtime||!elements.diagnostics)return;
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
