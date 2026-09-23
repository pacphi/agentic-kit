// @ts-nocheck — browser bundle source (never node-imported; client.mjs reads it as text).
// ADR-0058: read-only "ruflo components" panel for Overview > Runtime. Every
// card carries the state's badge BESIDE its plain-language meaning (and
// action, when the state has one) — never a bare label. Data comes from
// GET /api/ruflo-components, a cache-only read (dashboard-server.mjs never
// probes ruflo from this route); this file never POSTs anything.
import { authHeaders, esc } from './bootstrap.mjs';
import { formatLocalDateTimeLong } from './datetime.mjs';

  var RC_LEVEL={active:"ok","user-managed":"ok",unknown:"unknown","applied-unverified":"warn","needs-ruflo":"warn","not-applied":"warn",drifted:"warn",partial:"warn",blocked:"fail"};

  function rcCard(c){
    var options=c.options?'<ul class="rc-options">'+c.options.map(function(o){
      return '<li'+(o.value===c.value?' class="rc-current"':'')+'><b>'+esc(o.value)+'</b> — '+esc(o.detail)+'</li>';}).join("")+"</ul>":"";
    var evidence=c.evidence.length?c.evidence.map(function(e){
      return '<div class="rc-evidence"><b>'+esc(e.source)+'</b> · '+esc(formatLocalDateTimeLong(e.capturedAt)||"time unknown")+'<br>'+esc(e.detail)+'</div>';}).join("")
      :'<div class="rc-evidence">No evidence collected yet — run <code>ak status --refresh</code>.</div>';
    return '<article class="rc-card" data-level="'+esc(RC_LEVEL[c.state.id]||"unknown")+'">'
      +'<header><h3>'+esc(c.label)+'</h3><span class="rc-badge"><span class="dot" data-level="'+esc(RC_LEVEL[c.state.id]||"unknown")+'"></span>'+esc(c.state.label)+'</span></header>'
      +'<p class="rc-meaning">'+esc(c.state.meaning)+(c.state.action?' <span class="rc-action">'+esc(c.state.action)+'</span>':'')+'</p>'
      +'<p class="rc-value">Value: <b>'+esc(c.value)+'</b> · controlled by '+(c.managed?"agentic-kit":"you")+'</p>'
      +'<details><summary>What it does</summary><p>'+esc(c.explain.does)+'</p><p><b>Benefit:</b> '+esc(c.explain.benefit)+'</p>'
      +'<p><b>Cost:</b> '+esc(c.explain.cost)+'</p><p><b>Change it:</b> '+esc(c.explain.change)+'</p>'+options+'</details>'
      +evidence+'</article>';
  }

  export function renderRufloComponents(payload){
    var el=document.getElementById("ruflo-components");
    if(!el)return;
    if(!payload||!Array.isArray(payload.components)){el.innerHTML='<div class="empty">ruflo components unavailable.</div>';return;}
    el.innerHTML='<header class="rc-head"><h3>ruflo components</h3><span>'+esc(payload.summary.active)+' of '+esc(payload.summary.total)
      +' active · ruflo '+esc(payload.rufloVersion||"not installed")+' · evidence '+esc(formatLocalDateTimeLong(payload.capturedAt)||"not collected")+'</span></header>'
      +'<div class="rc-grid">'+payload.components.map(rcCard).join("")+"</div>";
  }

  export function loadRufloComponents(){
    return fetch("/api/ruflo-components",{cache:"no-store",headers:authHeaders()}).then(function(r){return r.ok?r.json():null;})
      .then(renderRufloComponents).catch(function(){renderRufloComponents(null);});
  }
