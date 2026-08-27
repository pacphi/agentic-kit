// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { esc } from './bootstrap.mjs';
import { fmtBytes } from './system-readout.mjs';
import { MODEL_PAGE, fmtNum, modelFilters, modelRows, modelsBusy } from './usage.mjs';

  export function renderModelSummary(rows){
    var row=(rows||[]).find(function(value){return value&&value.subsystem==="models";});
    var copy=document.getElementById("mli-summary-copy"),state=document.getElementById("mli-summary-state");
    if(!copy||!state)return;
    var level=row&&row.level||"warn";
    copy.textContent=row&&row.message||"No cached inventory yet";
    state.setAttribute("data-level",level);
    state.innerHTML='<span class="dot" data-level="'+esc(level)+'"></span>'+esc(level==="ok"?"current":level==="fail"?"attention":"review");
  }

  function mliEvidence(model,refs,fallback){
    var wanted=new Set(refs||[]),rows=(model&&model.evidence||[]).filter(function(row){return wanted.has(row.id);});
    if(!rows.length)return '<span class="mli-proof-row">'+esc(fallback||"No accepted source established this field.")+'</span>';
    var seen=new Set();
    rows=rows.filter(function(row){
      var summary=JSON.stringify([row.source,row.class,row.capturedAt||"capture unknown",row.freshness,row.completeness]);
      if(seen.has(summary))return false;
      seen.add(summary);return true;
    });
    return rows.map(function(row){return '<span class="mli-proof-row"><b>'+esc(row.source)+'</b> · '+esc(row.class)
      +' · '+esc(row.capturedAt||"capture unknown")+' · '+esc(row.freshness)+' · '+esc(row.completeness)
      +'</span>';}).join("");
  }

  var MLI_UNKNOWN_COPY={
    configured:"No active route or configuration evidence established this field.",
    effective:"No active route or configuration evidence established this field.",
    observed:"No retained successful-use evidence established this field.",
    discoverable:"No accepted provider or local catalogue source established publication or discovery.",
    entitled:"Catalog visibility does not prove account access.",
    policyAllowed:"No policy source established this field.",
    routable:"No complete host, provider, and authentication path evidence established this field."
  };

  function mliState(model,name){
    var dimension=model&&model.dimensions&&model.dimensions[name]||{},value=dimension.value;
    var state=value===true?"yes":value===false?"no":"unknown",refs=dimension.evidenceRefs||[];
    var proof=state==="unknown"
      ?'<span class="mli-proof-row">'+esc(MLI_UNKNOWN_COPY[name]||"No accepted source established this field.")+'</span>'+(refs.length?mliEvidence(model,refs):"")
      :mliEvidence(model,refs);
    return '<details class="mli-proof"><summary class="mli-state" data-state="'+state+'" aria-label="'+esc(name)+': '+state+'. Expand for evidence.">'
      +state+'</summary><span class="mli-proof-body">'+proof+'</span></details>';
  }

  function mliLifecycle(model){
    var life=model.lifecycle||{},replacement=life.replacementName||life.replacementSelector||(life.replacement?'private replacement':null),copy=esc(life.state||"unknown")+(replacement?" → "+esc(replacement):"");
    return '<details class="mli-proof"><summary class="mli-life mono" aria-label="Lifecycle: '+copy+'. Expand for evidence.">'
      +copy+'</summary><span class="mli-proof-body">'+mliEvidence(model,life.evidenceRefs)+'</span></details>';
  }

  function mliIdentity(model){
    var key=model&&model.key||{},identity=model&&model.identity||{};
    return {host:model.host||key.host||"unknown",provider:model.servingProvider||key.provider||"",
      publisher:model.publisher||identity.publisher||"",selector:model.selector||identity.selector||"",
      name:model.humanName||model.displayName||"Model not recorded"};
  }

  function mliLinks(model){
    var raw=model&&model.links||[],links=[];
    if(!Array.isArray(raw))raw=Object.keys(raw).map(function(label){var item=raw[label];return typeof item==="string"?{label:label,url:item}:Object.assign({label:label},item||{});});
    raw.forEach(function(item){
      if(!item)return;var url=typeof item==="string"?item:(item.url||item.href),label=typeof item==="string"?"source":(item.label||item.kind||"source");
      try{if(new URL(String(url||"")).protocol==="https:")links.push('<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+'</a>');}catch(e){}
    });
    return links.length?'<small class="mli-links">'+links.join(" · ")+'</small>':"";
  }

  function mliIdentityHtml(model){
    var id=mliIdentity(model),parts=[id.host];
    if(id.provider&&id.provider!==id.host)parts.push(id.provider);
    if(id.publisher&&parts.indexOf(id.publisher)<0)parts.push(id.publisher);
    var detail='<small>'+parts.map(esc).join(" · ")+'</small>';
    if(id.selector&&id.selector!==id.name)detail+='<small class="mli-selector">'+esc(id.selector)+'</small>';
    return '<span class="mli-id"><b>'+esc(id.name)+'</b>'+detail+mliLinks(model)+'</span>';
  }

  function mliPlanUse(host){
    if(!LIMITS)return 'plan utilization loading';
    if(LIMITS.error)return 'plan utilization unavailable';
    if(host==='claude'){
      var windows=LIMITS.claude&&LIMITS.claude.windows||[];
      return windows.length?'Claude plan '+windows.map(function(w){return (w.label||w.id||'window')+' '+Math.round(Number(w.usedPercent)||0)+'%';}).join(', '):'Claude plan not reported';
    }
    if(host==='codex'){
      var lanes=LIMITS.codex&&LIMITS.codex.lanes||[],values=[];
      lanes.forEach(function(lane){(lane.windows||[]).forEach(function(w){values.push((w.label||lane.name||'window')+' '+Math.round(Number(w.usedPercent)||0)+'%');});});
      return values.length?'Codex plan '+values.join(', '):'Codex plan not reported';
    }
    return 'plan utilization not reported by this host';
  }

  function mliPrice(pricing,host){
    var rate='API rate not published',source='No verified API list rate for this selector.';
    if(pricing){
      if(pricing.input===0&&pricing.output===0)rate='No API charge evidenced';
      else {
        var currency=pricing.currency||'USD',unit=pricing.basis==='per-million-tokens'?' / 1M tokens':' / token';
        rate='in $'+String(pricing.input)+' · out $'+String(pricing.output)+' '+currency+unit;
      }
      source=pricing.source||'catalogue evidence';
      if(pricing.asOf)source+=' · rates as of '+pricing.asOf;
    }
    var cited=esc(source);
    if(pricing&&pricing.sourceUrl){
      try{var sourceUrl=new URL(String(pricing.sourceUrl));if(sourceUrl.protocol==="https:"&&["developers.openai.com","platform.claude.com"].indexOf(sourceUrl.hostname)>=0)cited='<a href="'+esc(sourceUrl.href)+'" target="_blank" rel="noopener noreferrer">'+esc(source)+'</a>';}catch(e){}
    }
    return '<span class="mli-rate"><b>'+esc(rate)+'</b><small>'+cited+' · '+esc(mliPlanUse(host))+'</small></span>';
  }

  function mliCapabilities(model){
    var cap=model&&model.capabilities||{},names=[];
    if(cap.toolcall||cap.tools)names.push('Tools');
    if(cap.reasoning)names.push('Reasoning');
    if(cap.embedding)names.push('Embeddings');
    if(cap.input&&cap.input.image)names.push('Vision');
    if(cap.structuredOutput)names.push('Structured output');
    if(cap.contextLimit)names.push('Context '+fmtNum(cap.contextLimit));
    if(cap.outputLimit)names.push('Output '+fmtNum(cap.outputLimit));
    return names.length?names.join(' · '):'No capability metadata recorded';
  }

  function mliProviderName(value){
    var names={openai:'OpenAI',anthropic:'Anthropic',ollama:'Ollama',lmstudio:'LM Studio',
      'openrouter':'OpenRouter','github-copilot':'GitHub Copilot','claude-code':'Claude Code'};
    return value?(names[String(value).toLowerCase()]||String(value)):'Not recorded';
  }

  function mliHostName(value){
    var names={claude:'Claude',codex:'Codex',opencode:'OpenCode',ollama:'Ollama'};
    return value?(names[String(value).toLowerCase()]||String(value)):'Not recorded';
  }

  function mliDetectedAt(value){
    var when=new Date(String(value||''));
    return isNaN(when)?'Time not recorded':when.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  function mliChangeRows(changes){
    if(!changes.length)return '<div class="empty">No same-scope model changes.</div>';
    return '<div class="mli-history-scroll" role="region" aria-label="Model change history table" tabindex="0">'
      +'<table class="mli-history-table"><caption class="sr-only">Changes detected between retained model inventory snapshots.</caption>'
      +'<thead><tr><th scope="col">Change</th><th scope="col">Model</th><th scope="col">Model provider</th><th scope="col">Host</th><th scope="col">What changed</th><th scope="col">Evidence</th></tr></thead><tbody>'
      +changes.map(function(change){
        var status=change.provisional?'Needs confirmation':'Confirmed';
        return '<tr data-change="'+esc(change.kind||'changed')+'"><th scope="row">'+esc(change.label||'Model changed')+'</th>'
          +'<td><span class="mli-history-model"><b>'+esc(change.modelName||'Model not recorded')+'</b>'
          +(change.selector&&change.selector!==change.modelName?'<small>'+esc(change.selector)+'</small>':'')+'</span></td>'
          +'<td>'+esc(mliProviderName(change.modelProvider))+'</td><td>'+esc(mliHostName(change.host))+'</td>'
          +'<td>'+esc(change.detail||'A model inventory fact changed.')+'</td>'
          +'<td><span class="mli-history-evidence" data-state="'+(change.provisional?'provisional':'confirmed')+'"><b>'+esc(status)+'</b><small>'+esc(mliDetectedAt(change.detectedAt))+'</small></span></td></tr>';
      }).join('')+'</tbody></table></div>';
  }

  function mliRouteValue(binding,field){
    if(field==="model")return binding.modelName||binding.selector||binding.configured||null;
    if(field==="provider")return binding.modelProvider||binding.provider||null;
    if(field==="used")return (binding.activity||"")+" "+(binding.role||"");
    if(field==="lastUsed"){
      var when=Date.parse(String(binding.lastUsed||""));return Number.isFinite(when)?when:null;
    }
    if(field==="rate"){
      var pricing=binding.pricing||{},input=Number(pricing.input),output=Number(pricing.output);
      return Number.isFinite(input)?{input:input,output:Number.isFinite(output)?output:null}:null;
    }
    return null;
  }

  function mliRouteCompare(a,b){
    var av=mliRouteValue(a,modelRouteSort),bv=mliRouteValue(b,modelRouteSort),aUnknown=av===null,bUnknown=bv===null;
    if(aUnknown||bUnknown)return aUnknown===bUnknown?0:(aUnknown?1:-1);
    var order;
    if(modelRouteSort==="rate"){
      order=av.input-bv.input;
      if(!order){
        var aOutput=av.output===null?Infinity:av.output,bOutput=bv.output===null?Infinity:bv.output;
        order=aOutput-bOutput;
      }
    }else if(typeof av==="number")order=av-bv;
    else order=String(av).localeCompare(String(bv),undefined,{sensitivity:"base"});
    if(!order){
      var aName=String(a.modelName||a.selector||a.configured||""),bName=String(b.modelName||b.selector||b.configured||"");
      order=aName.localeCompare(bName,undefined,{sensitivity:"base"});
    }
    return modelRouteDirection==="desc"?-order:order;
  }

  export function mliRouteRows(bindings){
    var rows=(bindings||[]).filter(function(binding){return binding&&binding.role&&binding.role!=="Configured consumer";}).sort(mliRouteCompare);
    return rows.map(function(binding){
      var used=(binding.activity||'Unclassified')+' · '+(binding.role||'configured');
      return '<tr><th scope="row"><span class="mli-id"><b>'+esc(binding.modelName||'Model not recorded')+'</b>'
        +(binding.selector?'<small class="mli-selector">'+esc(binding.selector)+'</small>':'')+'</span></th>'
        +'<td>'+esc(mliProviderName(binding.modelProvider))+'</td><td>'+esc(used)+'</td>'
        +'<td>'+esc(binding.lastUsed?String(binding.lastUsed).replace('T',' ').replace('.000Z','Z'):'Not observed')+'</td>'
        +'<td>'+mliPrice(binding.pricing,binding.host)+'</td></tr>';
    }).join('')||'<tr><td colspan="5"><div class="empty">No configured routes are recorded. Catalog availability does not create a route.</div></td></tr>';
  }

  function mliObservedRows(windowed){
    var models=windowed&&Array.isArray(windowed.models)?windowed.models:[];
    if(windowed&&windowed.status==='unavailable')return '<tr><td colspan="5"><div class="empty">Observed-use evidence is unavailable. Configured routes and catalog evidence remain available.</div></td></tr>';
    return models.map(function(model){
      return '<tr><th scope="row"><span class="mli-id"><b>'+esc(model.modelName||model.selector||'Model not recorded')+'</b>'
        +(model.selector&&model.selector!==model.modelName?'<small class="mli-selector">'+esc(model.selector)+'</small>':'')+'</span></th>'
        +'<td>'+esc(mliProviderName(model.modelProvider))+'</td><td>'+esc(model.host||'unknown')+'</td>'
        +'<td>'+esc(fmtNum(model.sessions||0))+'</td><td>'+esc(model.lastUsed?String(model.lastUsed).replace('T',' ').replace('.000Z','Z'):'Not recorded')+'</td></tr>';
    }).join('')||'<tr><td colspan="5"><div class="empty">No model use was observed in this window. This does not mean no models are installed or available.</div></td></tr>';
  }

  // mliDetail was one CC-44 function computing several dense ternary-chain
  // text fields (published/access/routable/next-step status text, the
  // lifecycle-scope/availability/retirement fields, and the ollama-only
  // "local install" block) and then building the whole detail-panel DOM in
  // one shot. Split the pure text/HTML computations out; each keeps its
  // original logic verbatim, so the rendered DOM is unchanged.
  function mliDetailStatusText(dimensions){
    var published=dimensions.discoverable||{},entitled=dimensions.entitled||{},routable=dimensions.routable||{},configured=dimensions.configured||{};
    var publishedText=published.value===true?'Published by an accepted source':published.value===false?'Not published by the accepted source':'Not established';
    var accessText=entitled.value===true?'Established for the observed account and path':entitled.value===false?'Not entitled in the accepted evidence':'Not established; public metadata is not account access';
    var routableText=routable.value===true?'Observed working on this exact path':routable.value===false?'Not routable in the accepted evidence':'Not established on this host/provider/account path';
    var nextStep=routable.value===true?'No evidence step needed; this exact path was observed working at capture time.'
      :(configured.value===true?'Complete one successful invocation on this exact path, then run ak models refresh.'
        :'Configure the exact model on an intended route, authenticate its serving provider, complete one successful invocation, then run ak models refresh.');
    return {publishedText:publishedText,accessText:accessText,routableText:routableText,nextStep:nextStep};
  }

  function mliDetailVariantFields(variants){
    var lifecycleScope=variants.lifecycleScope?'<div><dt>Lifecycle scope</dt><dd>'+esc(variants.lifecycleScope)+'</dd></div>':'';
    var availability=variants.availability?'<div><dt>Published availability</dt><dd>'+esc(variants.availability)+'</dd></div>':'';
    var retirement=variants.retiredAt?'<div><dt>Retired</dt><dd>'+esc(variants.retiredAt)+'</dd></div>'
      :(variants.retirementNotBefore?'<div><dt>Retirement commitment</dt><dd>Not before '+esc(variants.retirementNotBefore)+'</dd></div>':'');
    return {lifecycleScope:lifecycleScope,availability:availability,retirement:retirement};
  }

  function mliDetailLocalBlock(id,variants){
    return id.provider==='ollama'?'<div><dt>Local installation</dt><dd>Installed'+(variants.modifiedAt?' · updated '+esc(variants.modifiedAt):'')+'</dd></div>'
      +'<div><dt>Loaded now</dt><dd>'+esc(variants.loaded?'Yes':'No')+(variants.expiresAt?' · expires '+esc(variants.expiresAt):'')+'</dd></div>'
      +'<div><dt>Local model build</dt><dd>'+esc([variants.parameterSize,variants.quantizationLevel,variants.format].filter(Boolean).join(' · ')||'Not exposed')+'</dd></div>'
      +'<div><dt>Local memory</dt><dd>'+esc(variants.memoryBytes!=null?fmtBytes(variants.memoryBytes)+(variants.vramBytes!=null?' · VRAM '+fmtBytes(variants.vramBytes):''):'Not loaded')+'</dd></div>':'';
  }

  export function mliDetail(model){
    var detail=document.getElementById('mli-detail'),body=document.getElementById('mli-detail-body'),title=document.getElementById('mli-detail-title');
    if(!detail||!body||!title||!model)return;
    var id=mliIdentity(model),life=model.lifecycle||{},variants=model.variant||{},dimensions=model.dimensions||{},observed=dimensions.observed||{};
    var status=mliDetailStatusText(dimensions);
    var fields=mliDetailVariantFields(variants);
    var local=mliDetailLocalBlock(id,variants);
    title.textContent=id.name;
    body.innerHTML='<dl class="mli-detail-grid">'
      +'<div><dt>Exact selector</dt><dd>'+esc(id.selector||'Not recorded')+'</dd></div>'
      +'<div><dt>Model provider</dt><dd>'+esc(id.provider||'Not recorded')+'</dd></div>'
      +'<div><dt>Publisher</dt><dd>'+esc(id.publisher||'Not independently proven')+'</dd></div>'
      +'<div><dt>Lifecycle</dt><dd>'+esc(life.state||'unknown')+(life.replacementName?' → '+esc(life.replacementName):'')+'</dd></div>'
      +fields.lifecycleScope+fields.availability+fields.retirement
      +'<div><dt>Observed use</dt><dd>'+esc(observed&&observed.value===true?'Observed locally':'Not observed')+'</dd></div>'
      +'<div><dt>Published / discovered</dt><dd>'+esc(status.publishedText)+'</dd></div>'
      +'<div><dt>Account access</dt><dd>'+esc(status.accessText)+'</dd></div>'
      +'<div><dt>Local routability</dt><dd>'+esc(status.routableText)+'</dd></div>'
      +'<div><dt>What you need to do</dt><dd>'+esc(status.nextStep)+'</dd></div>'
      +'<div><dt>Context limit</dt><dd>'+esc(variants.contextWindow||model.capabilities&&model.capabilities.contextLimit||'Not established by accepted sources')+'</dd></div>'
      +'<div><dt>Capabilities</dt><dd>'+esc(mliCapabilities(model))+'</dd></div>'
      +'<div><dt>API rate / plan use</dt><dd>'+mliPrice(model.pricing,id.host)+'</dd></div>'
      +local
      +'</dl><h3>Evidence and limitations</h3><div class="mli-proof-body">'+mliEvidence(model,(model.evidence||[]).map(function(row){return row.id;}),'No evidence is available.')+'</div>';
    if(typeof detail.showModal==='function')detail.showModal(); else detail.setAttribute('open','');
  }

  export function renderModelSort(){
    var heads=document.querySelectorAll(".mli-ledger .mli-table thead th");
    for(var i=0;i<heads.length;i++){
      var button=heads[i].querySelector("[data-mli-sort]"),active=button&&button.getAttribute("data-mli-sort")===modelSort;
      heads[i].setAttribute("aria-sort",active?(modelDirection==="desc"?"descending":"ascending"):"none");
      if(button){
        var mark=button.querySelector("[aria-hidden]");if(mark)mark.textContent=active?(modelDirection==="desc"?"↓":"↑"):"↕";
        button.title=active?"Sorted "+(modelDirection==="desc"?"descending":"ascending")+"; activate to reverse":"Sort by "+button.textContent.replace(/[↕↑↓]/g,"").trim();
      }
    }
  }

  export function renderModelRouteSort(){
    var heads=document.querySelectorAll(".mli-routes-table thead th");
    for(var i=0;i<heads.length;i++){
      var button=heads[i].querySelector("[data-mli-route-sort]"),active=button&&button.getAttribute("data-mli-route-sort")===modelRouteSort;
      heads[i].setAttribute("aria-sort",active?(modelRouteDirection==="desc"?"descending":"ascending"):"none");
      if(button){
        var mark=button.querySelector("[aria-hidden]");if(mark)mark.textContent=active?(modelRouteDirection==="desc"?"↓":"↑"):"↕";
        button.title=active?"Sorted "+(modelRouteDirection==="desc"?"descending":"ascending")+"; activate to reverse":"Sort by "+button.textContent.replace(/[↕↑↓]/g,"").trim();
      }
    }
  }

  export function renderModelInventory(){
    var body=document.getElementById("mli-models"),count=document.getElementById("mli-result-count"),more=document.getElementById("mli-load-more");
    if(!body)return;
    if(!MODEL_PAGE){
      body.innerHTML='<tr><td colspan="6"><div class="empty">Loading model inventory…</div></td></tr>';
      if(count)count.textContent="Loading inventory…";
      if(more)more.hidden=true;
      renderModelSort();return;
    }
    body.innerHTML=modelRows.map(function(model){
      return '<tr><th scope="row" tabindex="-1">'+mliIdentityHtml(model)+"</th>"
        +"<td>"+mliState(model,"configured")+"</td><td>"+mliState(model,"observed")
        +"</td><td>"+mliState(model,"discoverable")+"</td><td>"+mliLifecycle(model)
        +'</td><td><button type="button" class="mli-detail-open" data-mli-detail="'+esc(model.identity||'')+'">Details</button></td></tr>';
    }).join("")||'<tr><td colspan="6"><div class="empty">No models match these filters.</div></td></tr>';
    var page=MODEL_PAGE||{},filtered=Number(page.filteredTotal)||0,total=Number(page.total)||filtered,relevant=Number(page.relevantTotal)||0;
    if(count){
      var mode=modelFilters().relevance;
      count.textContent=modelRows.length+" shown · "+filtered+(mode==="relevant"?" relevant":" matching")+" of "+total+" discovered"+(relevant&&mode!=="relevant"?" · "+relevant+" relevant":"");
    }
    if(more){more.hidden=!page.hasMore;more.disabled=modelsBusy;}
    renderModelSort();
  }

  export function renderModelFacets(){
    var facets=MODEL_PAGE&&MODEL_PAGE.facets||{};
    function values(name,read){
      var fromApi=facets[name];
      if(Array.isArray(fromApi))return fromApi;
      var out=[];modelRows.forEach(function(model){var value=read(mliIdentity(model));if(value&&out.indexOf(value)<0)out.push(value);});
      return out.sort();
    }
    function options(id,all,items){
      var el=document.getElementById(id);if(!el)return;var selected=el.value;
      var vals=items.map(function(item){return item&&typeof item==="object"?item:{value:item,count:null};})
        .filter(function(item){return item&&item.value;});
      if(selected&&!vals.some(function(item){return String(item.value)===selected;}))vals.unshift({value:selected,count:null});
      el.innerHTML='<option value="">'+esc(all)+'</option>'+vals.map(function(item){var label=String(item.value)+(Number.isFinite(Number(item.count))?' ('+String(item.count)+')':'');return '<option value="'+esc(item.value)+'">'+esc(label)+'</option>';}).join("");
      el.value=selected;
      var field=el.closest&&el.closest('.mli-filter');if(field)field.hidden=vals.length<2&&!selected;
    }
    options("mli-host","All hosts",values("hosts",function(id){return id.host;}));
    options("mli-provider","All providers",values("providers",function(id){return id.provider;}));
    options("mli-lifecycle","Any lifecycle",values("lifecycles",function(){return null;}));
    var dimensions=facets.dimensions||{},labels={configured:'Configured',effective:'Effective',observed:'Observed',discoverable:'Catalogued',entitled:'Entitled',policyAllowed:'Policy',routable:'Routable'};
    var fields=Object.keys(labels).filter(function(name){return Array.isArray(dimensions[name])&&dimensions[name].length>=2;});
    var field=document.getElementById('mli-evidence-field'),selected=field&&field.value;
    if(field){
      field.innerHTML='<option value="">Any evidence</option>'+fields.map(function(name){return '<option value="'+esc(name)+'">'+esc(labels[name])+'</option>';}).join('');
      field.value=fields.indexOf(selected)>=0?selected:'';
      var fieldWrap=field.closest&&field.closest('.mli-filter');if(fieldWrap)fieldWrap.hidden=fields.length===0;
    }
    var evidenceValue=document.getElementById('mli-evidence-value'),states=field&&field.value&&dimensions[field.value]||[];
    if(evidenceValue){
      var stateSelected=evidenceValue.value;
      evidenceValue.innerHTML='<option value="">Any value</option>'+states.map(function(item){var label=String(item.value)+(Number.isFinite(Number(item.count))?' ('+String(item.count)+')':'');return '<option value="'+esc(item.value)+'">'+esc(label)+'</option>';}).join('');
      evidenceValue.value=states.some(function(item){return item.value===stateSelected;})?stateSelected:'';
      evidenceValue.disabled=!field||!field.value;
      var valueWrap=evidenceValue.closest&&evidenceValue.closest('.mli-filter');if(valueWrap)valueWrap.hidden=fields.length===0;
    }
  }

  // renderModelLifecycle was one CC-27 function writing to ~10 unrelated DOM
  // targets (badge/asof, attention list, routes+observed, history, consumers+
  // impact) in sequence. Split by target group; each keeps its original logic
  // verbatim, so the rendered DOM and its ordering are unchanged.
  function mliRenderBadgeAndAsof(empty,snap,attention){
    var badge=document.getElementById("mli-attention-n");
    if(badge){badge.hidden=!attention.length;badge.textContent=attention.length?String(attention.length):"";}
    document.getElementById("mli-asof").textContent=empty?"not captured":("captured "+String(snap.capturedAt||"").replace("T"," ").replace(".000Z","Z"));
  }

  function mliRenderAttention(empty,attention){
    document.getElementById("mli-attention").innerHTML=empty
      ?'<div class="empty">'+esc(MODELS.error||"No model inventory yet. Run ak models refresh explicitly.")+"</div>"
      :attention.map(function(item){
        var migration=item.kind==='migration',routes=(item.affectedRoutes||[]).map(function(route){return (route.activity||route.consumer||'Route')+(route.role?' · '+route.role:'');});
        var title=migration?(routes.length?'Route needs attention':'Model needs attention'):item.kind==='source'?'Source needs attention':'Route needs attention';
        var detail=migration
          ? '<span><b>Current:</b> '+esc(item.currentModel||'Model not recorded')+' · <b>recommended:</b> '+esc(item.replacementModel||'Not recorded')+'</span>'
            +(routes.length?'<br><span><b>Affects:</b> '+esc(routes.join(', '))+'</span>':'')
            +'<br><span>'+esc(item.reason||'A cited lifecycle change requires review.')+'</span>'
            +(item.documentationUrl?'<br><a href="'+esc(item.documentationUrl)+'" target="_blank" rel="noopener noreferrer">Read the provider lifecycle notice</a>':'')
            +'<br><span><b>Next step:</b> <span class="mono">'+esc(item.action||'ak models plan')+'</span></span>'
          : '<span>'+esc(item.reason||'Evidence needs review')+'. Run <span class="mono">ak models refresh --all</span> for current evidence.</span>';
        return '<div class="mli-alert" data-level="'+esc(item.severity||"warn")+'"><b>'+esc(title)+'</b><br>'+detail+'</div>';
      }).join("");
  }

  function mliRenderRoutesAndObserved(bindings){
    document.getElementById('mli-routes').innerHTML=mliRouteRows(bindings);
    var observed=MODELS.observedWindow||{days:usageDays,models:[]};
    document.getElementById('mli-observed').innerHTML=mliObservedRows(observed);
    document.getElementById('mli-observed-note').textContent=observed.status==='unavailable'
      ? String(observed.days||usageDays)+' days · use unavailable'
      : String(observed.days||usageDays)+' days · '+String((observed.models||[]).length)+' model'+((observed.models||[]).length===1?'':'s');
  }

  function mliRenderHistory(snap){
    var changes=snap.changes||[];
    var snapshotCount=(MODELS.history||[]).length;
    document.getElementById("mli-history-note").textContent=changes.length+" change"+(changes.length===1?"":"s")+' · '+snapshotCount+" retained snapshot"+(snapshotCount===1?"":"s");
    document.getElementById("mli-history").innerHTML=mliChangeRows(changes);
  }

  function mliRenderConsumersAndImpact(bindings){
    var routeBindings=bindings.filter(function(binding){return binding.role&&binding.role!=="Configured consumer";});
    document.getElementById("mli-consumers").innerHTML='<div class="mli-consumer-scroll"><div class="mli-list">'+(routeBindings.map(function(binding){var model=binding.modelName||binding.configured||'Model not pinned';return '<div class="mli-row"><span><b>'+esc(binding.consumer)+'</b><br><small>'+esc(model)+' · '+esc(mliProviderName(binding.modelProvider||binding.provider))+'</small></span><small>'+esc(binding.lastUsed?'last used '+String(binding.lastUsed).replace('T',' ').replace('.000Z','Z'):'not observed in this window')+'</small></div>';}).join("")||'<div class="empty">No configured model routes.</div>')+"</div></div>";
    document.getElementById("mli-impact").innerHTML=routeBindings.length
      ?'<div class="note"><span class="i">→</span><span><b>'+routeBindings.length+' route consumer'+(routeBindings.length===1?"":"s")+'</b> may be affected by a concrete model swap. Run <span class="mono">ak models plan --activity ACTIVITY --to HOST:MODEL</span> for evidence-backed compatibility and a copyable action.</span></div>'
      :'<div class="empty">No bound consumers to assess. A plan will remain read-only and report the missing binding.</div>';
  }

  export function renderModelLifecycle(){
    if(!MODELS)return;
    var empty=MODELS.error||MODELS.status==="empty"||!MODELS.snapshot;
    var snap=MODELS.snapshot||{},attention=snap.attention||[],bindings=snap.bindings||[];
    mliRenderBadgeAndAsof(empty,snap,attention);
    mliRenderAttention(empty,attention);
    mliRenderRoutesAndObserved(bindings);
    renderModelRouteSort();
    renderModelInventory();
    mliRenderHistory(snap);
    mliRenderConsumersAndImpact(bindings);
  }

