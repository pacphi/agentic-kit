export const MAINTENANCE_CSS = `
/* Maintenance is one inspection ledger, not another analytics card grid. The
   outer System card supplies the established surface; hairlines and selection
   state carry the hierarchy within it. */
.mt-card{gap:0;padding:0;overflow:hidden}
.mt-scanbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 14px;border-bottom:1px solid var(--line);color:var(--ink-2);font-size:11.5px;line-height:1.45}
.mt-scan-copy{display:flex;align-items:baseline;gap:7px;min-width:0;max-width:82ch}.mt-scan-copy b{flex:none;color:var(--ink)}.mt-scan-copy span{color:var(--ink-2)}.mt-scan-elapsed{flex:none;font-family:var(--mono);color:var(--ink-dim)!important}
.mt-scanbar[data-state="running"]{box-shadow:inset 2px 0 var(--accent)}.mt-scanbar[data-state="failed"]{box-shadow:inset 2px 0 var(--warn)}
.mt-banner{display:flex;align-items:flex-start;gap:9px;padding:10px 14px;border-bottom:1px solid var(--line);font-size:11.5px;line-height:1.45}
.mt-banner b{flex:none;color:var(--ink);font-weight:650}
.mt-banner span{color:var(--ink-2)}
.mt-banner.readonly{border-left:2px solid var(--accent);background:var(--accent-soft)}
.mt-banner.enabled{border-left:2px solid var(--ok);background:var(--ok-soft)}
.mt-banner.unavailable{border-left:2px solid var(--warn);background:color-mix(in srgb,var(--warn) 7%,transparent)}
.mt-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;padding:0 14px;border-bottom:1px solid var(--line)}
.mt-summary>div{min-width:0;padding:11px 12px;border-right:1px solid var(--line)}
.mt-summary>div:first-child{padding-left:0}.mt-summary>div:last-child{border-right:0}
.mt-summary dt{color:var(--ink-dim);font-size:10.5px}.mt-summary dd{margin:0;color:var(--ink);font-family:var(--mono);font-size:17px;font-weight:700;line-height:1.25}
.mt-buckets{display:flex;gap:6px;align-items:center;overflow-x:auto;padding:11px 14px 7px;scrollbar-width:none}
.mt-buckets::-webkit-scrollbar{display:none}.mt-buckets .chipf{flex:none}
.mt-buckets .chipf .mono{margin-left:3px;color:var(--ink-dim)}
.mt-buckets .chipf.on .mono{color:inherit}
.mt-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) repeat(3,minmax(120px,auto));gap:7px;align-items:center;padding:0 14px 11px}
.mt-toolbar input,.mt-toolbar select{min-width:0;height:34px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--ink);font:12px var(--sans);padding:0 10px}
.mt-toolbar input::placeholder{color:var(--ink-dim)}
.mt-toolbar input:focus-visible,.mt-toolbar select:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.mt-results{grid-column:1/-1;color:var(--ink-dim);font-size:10.5px;min-height:16px}
.mt-workbench{display:grid;grid-template-columns:minmax(0,7fr) minmax(310px,5fr);min-height:390px;border-top:1px solid var(--line)}
.mt-ledger{max-height:min(62vh,620px);overflow:auto;border-right:1px solid var(--line);outline:none}
.mt-ledger:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.mt-ledger ul{list-style:none;margin:0;padding:0}
.mt-ledger li{margin:0;border-bottom:1px solid var(--line)}
.mt-ledger li:last-child{border-bottom:0}
.mt-row{position:relative;display:grid;grid-template-columns:minmax(118px,.72fr) minmax(150px,1fr) minmax(190px,1.35fr);grid-template-areas:"state identity change" "state owner change";gap:2px 12px;width:100%;min-height:66px;padding:9px 13px;border:0;background:transparent;color:var(--ink-2);font:inherit;text-align:left;cursor:pointer}
.mt-row:hover{background:var(--panel-2)}
.mt-row[aria-current="true"]{background:var(--panel-2);box-shadow:inset 3px 0 var(--accent)}
.mt-row:focus,.mt-row:focus-visible{outline:2px solid var(--accent);outline-offset:-3px;z-index:1}
.mt-state{grid-area:state;align-self:start;justify-self:start;display:inline-block;white-space:nowrap;border:1px solid var(--line-2);border-radius:100px;padding:2px 7px;color:var(--ink-2);font-size:9.5px;font-weight:700;line-height:1.45}
.mt-row[data-tone="ready"] .mt-state,.mt-state[data-tone="ready"]{color:var(--ok);background:var(--ok-soft);border-color:transparent}
.mt-row[data-tone="review"] .mt-state,.mt-state[data-tone="review"]{color:var(--warn);background:color-mix(in srgb,var(--warn) 9%,transparent);border-color:color-mix(in srgb,var(--warn) 28%,transparent)}
.mt-row[data-tone="blocked"] .mt-state,.mt-state[data-tone="blocked"]{color:var(--fail);background:color-mix(in srgb,var(--fail) 8%,transparent);border-color:color-mix(in srgb,var(--fail) 25%,transparent)}
.mt-row[data-tone="incomplete"] .mt-state,.mt-state[data-tone="incomplete"]{color:var(--ink-2);background:transparent;border-style:dashed}
.mt-identity{grid-area:identity;display:flex;flex-direction:column;min-width:0}
.mt-identity b{color:var(--ink);font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-identity small,.mt-owner{color:var(--ink-dim);font-size:10.5px}
.mt-owner{grid-area:owner;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-change{grid-area:change;align-self:center;display:flex;flex-direction:column;gap:3px;color:var(--ink-2);font-size:11.5px;line-height:1.4}
.mt-change small{color:var(--ink-dim);font-size:10px;line-height:1.35}
.mt-detail{max-height:min(62vh,620px);overflow:auto;padding:15px 16px;background:color-mix(in srgb,var(--panel) 96%,var(--ink) 4%)}
.mt-detail-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.mt-detail-head .mt-state{grid-area:auto}
.mt-detail-head>.mt-action{margin-left:auto}
.mt-detail h3{flex:1 1 180px;margin:0;color:var(--ink);font-size:15px;letter-spacing:-.01em}
.mt-detail h3:focus{outline:none}.mt-explanation{margin:10px 0 12px;color:var(--ink-2);font-size:12px;line-height:1.55;max-width:70ch}
.mt-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin:0}
.mt-facts>div{min-width:0}.mt-facts dt{color:var(--ink-dim);font-size:9.5px}.mt-facts dd{margin:2px 0 0;color:var(--ink);font-size:11.5px;overflow-wrap:anywhere}
.mt-facts.compact{gap:6px 12px}
.mt-detail-section,.mt-technical{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.mt-detail-section h4{margin:0 0 7px;color:var(--ink);font-size:11.5px}.mt-detail-section p{margin:0 0 8px;color:var(--ink-2);font-size:11.5px;line-height:1.5}
.mt-evidence-gap{margin-top:12px;padding:9px 10px;border-left:2px solid var(--warn);background:color-mix(in srgb,var(--warn) 7%,transparent);font-size:11px;color:var(--ink-2)}
.mt-evidence-gap b{color:var(--ink)}.mt-evidence-gap ul{margin:5px 0 0;padding-left:17px}
.mt-next code{display:block;max-width:100%;overflow:auto;margin:8px 0;padding:7px 9px;border-radius:6px;background:var(--bg);color:var(--accent);font-size:10.5px;white-space:nowrap}
.mt-next small,.mt-report-only{display:block;color:var(--ink-dim);font-size:10.5px;line-height:1.45}
.mt-next h5{margin:9px 0 0;color:var(--ink);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}
.mt-steps{margin:7px 0 9px;padding-left:20px;color:var(--ink-2);font-size:11.5px;line-height:1.55}
.mt-steps li+li{margin-top:3px}.mt-preserved,.mt-blocked-reason{font-size:10.5px!important;color:var(--ink-dim)!important}
.mt-preserved b{color:var(--ok)}.mt-blocked-reason b{color:var(--warn)}
.mt-action-title{color:var(--ink)!important;font-weight:650}.mt-action-reason{max-width:68ch}
.mt-procedure{margin:8px 0;color:var(--ink-2);font-size:11px}.mt-procedure summary{width:max-content;cursor:pointer;color:var(--accent);font-weight:650}
.mt-copy-scroll{max-width:100%;overflow-x:auto;outline:none}.mt-copy-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mt-copy-table{width:100%;min-width:440px;border-collapse:collapse;text-align:left;font-size:10.5px}
.mt-copy-table th,.mt-copy-table td{padding:6px 7px;border-bottom:1px solid var(--line);vertical-align:top}
.mt-copy-table thead th{color:var(--ink-dim);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.mt-copy-table tbody th{color:var(--ink);font-weight:600}.mt-copy-table td{color:var(--ink-2)}
.mt-table-note{margin-top:6px!important;color:var(--ink-dim)!important;font-size:10px!important}
.mt-action-bar{display:flex;align-items:center;gap:9px;margin-top:10px}.mt-action-bar small{max-width:40ch}
.mt-action{flex:none;border:1px solid var(--line-2);border-radius:7px;background:transparent;color:var(--ink);font:600 11.5px var(--sans);padding:6px 10px;cursor:pointer}
.mt-action.primary{border-color:transparent;background:var(--accent);color:#fff}.mt-action:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.mt-action.primary:hover:not(:disabled){color:#fff}.mt-action:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.mt-action:disabled{cursor:not-allowed;opacity:.45}
.mt-technical summary{color:var(--ink-2);font-size:11px;cursor:pointer}.mt-technical summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mt-technical[open] summary{margin-bottom:9px;color:var(--ink)}
.mt-empty,.mt-detail-empty{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:180px;padding:22px;color:var(--ink-dim);font-size:12px;line-height:1.55}
.mt-detail-empty{height:100%}.mt-detail-empty b{color:var(--ink-2);font-weight:600}.mt-detail-empty span{max-width:42ch}
.mt-confirm{width:min(590px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;border:1px solid var(--line-2);border-radius:var(--r);background:var(--panel);color:var(--ink);padding:0;box-shadow:var(--shadow)}
.mt-confirm::backdrop{background:rgba(0,0,0,.68)}.mt-confirm[aria-busy="true"]{cursor:progress}.mt-confirm [hidden]{display:none}
.mt-confirm-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 17px 12px;border-bottom:1px solid var(--line)}
.mt-confirm-head h2{margin:0;font-size:16px;letter-spacing:-.01em}.mt-confirm-head button{border:0;background:transparent;color:var(--ink-2);font:11.5px var(--sans);cursor:pointer}
.mt-confirm-head button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.mt-confirm-head button:disabled{opacity:.4;cursor:not-allowed}
.mt-confirm-body{padding:15px 17px 4px}.mt-confirm-summary{margin:0 0 12px;color:var(--ink-2);font-size:12px;line-height:1.55}
.mt-confirm-list{padding:10px 0;border-top:1px solid var(--line)}.mt-confirm-list h3{margin:0 0 5px;font-size:11.5px}.mt-confirm-list ul{margin:0;padding-left:18px;color:var(--ink-2);font-size:11.5px;line-height:1.5}
.mt-confirm-list.change h3{color:var(--warn)}.mt-confirm-list.preserve h3{color:var(--ok)}
.mt-confirm-facts{padding-top:10px;border-top:1px solid var(--line)}.mt-expiry{margin:11px 0;color:var(--ink-dim);font-size:10.5px;line-height:1.5}
.mt-typed{display:grid;gap:6px;margin:13px 0}.mt-typed span{color:var(--ink-2);font-size:11px}.mt-typed code{color:var(--accent);font-size:11px;overflow-wrap:anywhere}
.mt-typed input{width:100%;height:35px;border:1px solid var(--line-2);border-radius:7px;background:var(--panel-2);color:var(--ink);font:12px var(--mono);padding:0 9px}
.mt-typed input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.mt-confirm-error{padding:10px;border-left:2px solid var(--fail);background:color-mix(in srgb,var(--fail) 7%,transparent);color:var(--ink-2);font-size:12px;line-height:1.55}
.mt-confirm-status{min-height:17px;margin:7px 17px;color:var(--ink-dim);font-size:10.5px}.mt-confirm-actions{display:flex;justify-content:flex-end;gap:8px;padding:11px 17px 15px;border-top:1px solid var(--line)}
@media(max-width:900px){
  .mt-workbench{grid-template-columns:1fr}.mt-ledger{max-height:420px;border-right:0;border-bottom:1px solid var(--line)}
  .mt-detail{max-height:none}.mt-row{grid-template-columns:minmax(112px,.7fr) minmax(140px,1fr) minmax(180px,1.3fr)}
}
@media(max-width:600px){
  .mt-scanbar,.mt-banner,.mt-scan-copy{align-items:flex-start;flex-direction:column;gap:6px}.mt-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
  .mt-summary>div:nth-child(2){border-right:0}.mt-summary>div:nth-child(-n+2){border-bottom:1px solid var(--line)}
  .mt-toolbar{grid-template-columns:1fr 1fr}.mt-toolbar input{grid-column:1/-1}.mt-results{grid-column:1/-1}
  .mt-row{grid-template-columns:1fr;grid-template-areas:"state" "identity" "change" "owner";gap:5px;min-height:44px;padding:11px 13px}
  .mt-facts{grid-template-columns:1fr}.mt-detail{padding:14px}.mt-buckets{padding-left:12px;padding-right:12px}
  .mt-action-bar{align-items:flex-start;flex-direction:column}.mt-confirm-head,.mt-confirm-body,.mt-confirm-actions{padding-left:14px;padding-right:14px}.mt-confirm-status{margin-left:14px;margin-right:14px}
}

/* ── ADR-0048 Maintenance workspace: Inventory | Guidance | Discovery |
   Activity. Built on the same mt-card surface and mt-action/mt-confirm
   primitives above (the apply/undo/reconcile dialog is reused verbatim);
   mnt-* is this workspace's own namespace. ── */
.mnt-card{position:relative}
.mnt-skip-link{position:absolute;left:8px;top:-40px;z-index:5;padding:7px 12px;border-radius:8px;background:var(--accent);color:#fff;font:600 12px var(--sans);text-decoration:none;transition:top .12s}
.mnt-skip-link:not(:focus){width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.mnt-skip-link:focus{top:8px}
.mnt-tabs{display:flex;gap:2px;padding:10px 14px 0;border-bottom:1px solid var(--line)}
.mnt-tabs .segbadge{margin-left:5px;color:var(--ink-dim);font-family:var(--mono);font-size:10px}
.mnt-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.mnt-providers-bar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--line);color:var(--ink-2);font-size:11px}
.mnt-panel{padding:12px 14px 16px}
.mnt-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}
.mnt-toolbar input[type="search"],.mnt-toolbar input[type="text"]{flex:1 1 220px;min-width:0;height:34px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--ink);font:12px var(--sans);padding:0 10px}
.mnt-toolbar input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.mnt-scope{display:flex;flex-wrap:wrap;gap:6px}
.mnt-filters-toggle{display:none}
.mnt-body{display:grid;grid-template-columns:200px minmax(0,1fr) minmax(0,340px);gap:14px;align-items:start}
.mnt-side{display:flex;flex-direction:column;gap:14px;min-width:0}
.mnt-views h3,.mnt-facet-group legend{margin:0 0 6px;color:var(--ink-dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
.mnt-views ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.mnt-view-btn{display:block;width:100%;text-align:left;border:0;border-radius:7px;background:transparent;color:var(--ink-2);font:12px var(--sans);padding:6px 8px;cursor:pointer}
.mnt-view-btn:hover{background:var(--panel-2)}
.mnt-view-btn.on{background:var(--accent-soft);color:var(--accent);font-weight:650}
.mnt-view-btn:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.mnt-facet-group{border:0;border-top:1px solid var(--line);margin:0;padding:10px 0 0}
.mnt-facet-opt{display:flex;align-items:center;gap:6px;padding:3px 0;color:var(--ink-2);font-size:11.5px;cursor:pointer}
.mnt-facet-opt .mono{margin-left:auto;color:var(--ink-dim)}
.mnt-main{min-width:0}
.mnt-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.mnt-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line-2);border-radius:100px;padding:3px 5px 3px 9px;color:var(--ink-2);font-size:11px}
.mnt-chip button{border:0;background:transparent;color:var(--ink-dim);cursor:pointer;font-size:13px;line-height:1;padding:2px}
.mnt-chip button:hover{color:var(--fail)}
.mnt-clear-all{border:0;background:transparent;color:var(--accent);font:600 11px var(--sans);cursor:pointer;padding:3px 4px}
.mnt-partial{margin-bottom:8px;padding:8px 10px;border-left:2px solid var(--info);background:var(--panel-2);color:var(--ink-2);font-size:11.5px;line-height:1.5}
.mnt-legend-list{display:flex;flex-wrap:wrap;gap:8px 14px;list-style:none;margin:0 0 10px;padding:0;color:var(--ink-dim);font-size:10.5px}
.mnt-legend-list li{white-space:nowrap}
.mnt-legend-list .mono{color:var(--ink-2)}
.mnt-groups{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.mnt-group{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.mnt-group-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;padding:9px 12px;background:var(--panel-2);border-bottom:1px solid var(--line)}
.mnt-group-name{color:var(--ink);font-weight:650;font-size:12.5px}
.mnt-group-kind,.mnt-group-counts{color:var(--ink-dim);font-size:10.5px}
.mnt-group-outcome{color:var(--ink-2);font-size:11px;flex-basis:100%}
.mnt-placements{list-style:none;margin:0;padding:0}
.mnt-placements li+li{border-top:1px solid var(--line)}
.mnt-row{display:grid;grid-template-columns:minmax(140px,1.2fr) minmax(90px,.6fr) minmax(120px,1fr) auto;align-items:center;gap:4px 12px;width:100%;min-height:46px;padding:9px 12px;border:0;background:transparent;color:var(--ink-2);font:inherit;text-align:left;cursor:pointer}
.mnt-row:hover{background:var(--panel-2)}
.mnt-row:focus-visible{outline:2px solid var(--accent);outline-offset:-3px;z-index:1}
.mnt-row-name{color:var(--ink);font-weight:600;font-size:12px}
.mnt-row-scope,.mnt-row-crumb,.mnt-row-versions,.mnt-row-consumers{color:var(--ink-dim);font-size:10.5px}
.mnt-lane-badge{justify-self:start;border:1px solid var(--line-2);border-radius:100px;padding:2px 7px;color:var(--ink-2);font-size:9.5px;font-weight:650}
.mnt-row-action{justify-self:end;color:var(--accent);font-size:11px;font-weight:600;white-space:nowrap}
.mnt-empty{padding:24px 10px;color:var(--ink-dim);font-size:12px}
.mnt-paging{display:flex;align-items:center;gap:10px;margin-top:10px;color:var(--ink-dim);font-size:10.5px}
.mnt-inspector{border:1px solid var(--line);border-radius:10px;padding:14px;background:color-mix(in srgb,var(--panel) 96%,var(--ink) 4%);max-height:min(74vh,720px);overflow:auto}
.mnt-inspector h3{margin:6px 0 2px;color:var(--ink);font-size:14px}
.mnt-inspector h3:focus{outline:none}
.mnt-inspector-kind{color:var(--ink-dim);font-size:10.5px;margin:0 0 8px}
.mnt-q{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
.mnt-q h4{margin:0 0 6px;color:var(--ink);font-size:11px}
.mnt-q p{margin:0 0 6px;color:var(--ink-2);font-size:11.5px;line-height:1.5}
.mnt-conditions{margin:0 0 8px;padding-left:18px;color:var(--ink-2);font-size:11px}
.mnt-no-action{color:var(--ink-dim);font-style:normal}
.mnt-warning{padding:6px 8px;border-left:2px solid var(--warn);background:color-mix(in srgb,var(--warn) 8%,transparent);color:var(--ink-2);font-size:11px}
.mnt-conflicts{list-style:none;margin:0;padding:0}
.mnt-conflicts li{margin-bottom:8px}
.mnt-conflicts b{color:var(--ink);font-size:11.5px}
.mnt-dep-graph{padding-left:18px}
.mnt-revealed code{display:block;overflow-x:auto;padding:6px 8px;border-radius:6px;background:var(--bg);color:var(--accent);font-size:10.5px;white-space:nowrap;margin-bottom:6px}
.mnt-guidance-entry{margin-top:6px}
.mnt-guidance-entry h5{margin:0 0 3px;color:var(--ink);font-size:11.5px}
.mnt-choices{list-style:none;margin:0;padding:0}
.mnt-choices li{padding:6px 0;border-top:1px solid var(--line)}
.mnt-dispositions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.mnt-snooze-label{display:inline-flex;align-items:center;gap:5px;color:var(--ink-2);font-size:11px}
.mnt-snooze-label input[type="date"]{height:28px;border:1px solid var(--line);border-radius:6px;background:var(--panel-2);color:var(--ink);font:11px var(--sans)}
.mnt-disposition-confirm{flex-basis:100%;padding:8px 0 0;color:var(--ink-2);font-size:11px}
.mnt-lanes{display:flex;flex-wrap:wrap;gap:8px}
.mnt-lanes .seg-btn{border:1px solid var(--line-2);border-radius:999px;background:var(--panel-2);padding:7px 14px}
.mnt-lanes .seg-btn[aria-selected="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.mnt-lanes .seg-btn:hover{border-color:var(--accent)}
#mnt-guidance-coverage{margin-bottom:14px;color:var(--ink-2);font-size:12px}
#mnt-guidance-coverage li{margin:8px 0;line-height:1.5}
.mnt-guidance-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.mnt-guidance-rows>li{border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.mnt-guidance-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,320px);gap:14px;align-items:start}
.mnt-procedure{border:1px solid var(--line);border-radius:12px;padding:24px;background:var(--panel);color:var(--text);width:min(640px,calc(100vw - 48px));max-height:80vh;overflow:auto}
.mnt-procedure::backdrop{background:rgba(0,0,0,.55)}
.mnt-procedure pre{overflow-x:auto;padding:8px 9px;border-radius:6px;background:var(--bg);color:var(--accent);font-size:10.5px}
.mnt-discovery-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,300px);gap:14px;align-items:start}
.mnt-discovery-main section{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.mnt-discovery-main h3{margin:0 0 6px;font-size:11.5px;color:var(--ink)}
.mnt-activity-overview{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;margin-bottom:28px}
.mnt-activity-overview>.mnt-activity-group{grid-column:span 2;margin:0;padding:18px;border:1px solid var(--line);border-radius:12px;min-width:0}
.mnt-activity-overview>.mnt-activity-group:nth-child(-n+2){grid-column:span 3}
.mnt-activity-overview>.mnt-activity-group h3{font-size:13px;margin-bottom:12px}
.mnt-activity-overview>.mnt-activity-group p{font-size:12px;line-height:1.5;color:var(--ink-2);margin:0}
.mnt-activity-overview>.mnt-activity-group li{overflow-wrap:anywhere}
.mnt-activity-group{margin-bottom:14px}
@media(max-width:1000px){.mnt-activity-overview{grid-template-columns:repeat(2,minmax(0,1fr))}.mnt-activity-overview>.mnt-activity-group,.mnt-activity-overview>.mnt-activity-group:nth-child(-n+2){grid-column:span 1}.mnt-activity-overview>.mnt-activity-group:last-child{grid-column:1/-1}}
@media(max-width:600px){.mnt-activity-overview{grid-template-columns:minmax(0,1fr);gap:10px}.mnt-activity-overview>.mnt-activity-group{padding:14px}}
.mnt-activity-group h3{margin:0 0 6px;font-size:11.5px;color:var(--ink)}
.mnt-activity-group ul{list-style:none;margin:0;padding:0}
.mnt-activity-group li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line)}
.mnt-facets-sheet,.mt-confirm.mnt-audit-dialog{width:min(520px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;border:1px solid var(--line-2);border-radius:var(--r);background:var(--panel);color:var(--ink);padding:0;box-shadow:var(--shadow)}
.mnt-facets-sheet::backdrop,.mt-confirm.mnt-audit-dialog::backdrop{background:rgba(0,0,0,.68)}
.mnt-sheet-body{padding:12px 17px 17px}

/* Option A: context and progressive filters; the inspector consumes space only when open. */
#panel-sys-maintenance .view-heading{margin-bottom:18px}
#panel-sys-maintenance .view-heading p{max-width:70ch}
.mnt-card{overflow:visible}
.mnt-tabs{gap:16px;padding:12px 18px 0}
.mnt-tabs .seg-btn{border-radius:0;padding:10px 4px;border-bottom:2px solid transparent}
.mnt-tabs .seg-btn.on,.mnt-tabs .seg-btn[aria-selected="true"]{background:transparent;color:var(--accent);border-bottom-color:var(--accent)}
.mnt-providers-bar{padding:12px 18px;gap:10px;flex-wrap:wrap;min-height:58px}
.mnt-providers-bar .chipf{border-radius:7px;white-space:nowrap;min-height:34px;font-size:12px}
.mnt-providers-status{margin-left:auto;max-width:55ch;font-size:12px;line-height:1.5}
.mnt-providers-status[data-state="running"]::before{content:"";display:inline-block;width:9px;height:9px;margin-right:8px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:mnt-spin 1s linear infinite}
.mnt-providers-status[data-state="failed"]{color:var(--warn)}
.mnt-operation-elapsed{font:11px var(--mono);color:var(--ink-2);white-space:nowrap}
@keyframes mnt-spin{to{transform:rotate(360deg)}}
.mnt-panel{padding:16px 18px 20px}
.mnt-toolbar{padding-bottom:14px;border-bottom:1px solid var(--line);gap:12px}
.mnt-scope{gap:2px;border:1px solid var(--line);border-radius:8px;padding:3px}
.mnt-scope .chipf{border:0;border-radius:5px;display:inline-flex;align-items:center;gap:6px;padding:6px 9px;font-size:12px}
.mnt-icon{width:18px;height:18px;flex:none;vertical-align:middle}
.mnt-body{grid-template-columns:210px minmax(0,1fr);gap:20px}
.mnt-body:has(>.mnt-inspector:not([hidden])){grid-template-columns:190px minmax(0,1fr) minmax(270px,320px)}
.mnt-inspector[hidden]{display:none}
.mnt-side{border-right:1px solid var(--line);padding-right:16px;gap:14px}
.mnt-refine-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.mnt-refine-heading h3{margin:0;font-size:13px;color:var(--ink);text-transform:none;letter-spacing:0}
.mnt-view-btn{display:flex;gap:8px;align-items:center;min-height:34px;font-size:12px}
.mnt-filter-disclosure{border-top:1px solid var(--line);padding:10px 0}
.mnt-filter-disclosure summary{cursor:pointer;color:var(--ink-2);font-size:12px;font-weight:600;padding:3px 0}
.mnt-filter-disclosure[open]>summary{margin-bottom:8px;color:var(--ink)}
.mnt-filter-disclosure .mnt-filter-disclosure{margin-left:5px}
.mnt-facet-group{border:0;padding:0;min-width:0}
.mnt-facet-options{max-height:180px;overflow:auto;scrollbar-width:thin}
.mnt-facet-opt{align-items:flex-start;padding:5px 0;line-height:1.4;font-size:12px}
.mnt-facet-opt[hidden]{display:none}
.mnt-facet-opt input{accent-color:var(--accent);flex:none;margin-top:2px}
.mnt-facet-opt>span:not(.mono){overflow-wrap:anywhere}
.mnt-facet-search{width:100%;min-width:0;background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:7px 8px;font:12px var(--sans);margin-bottom:6px}
.mnt-results-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}
.mnt-results-heading h3{margin:0 0 5px;font-size:14px;color:var(--ink);overflow-wrap:anywhere}
#mnt-result-count{font-size:11px;color:var(--ink-2)}
.mnt-sort{display:flex;align-items:center;gap:6px;color:var(--ink-2);font-size:11px}
.mnt-sort select{max-width:145px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px}
.mnt-partial{display:flex;gap:8px;align-items:start;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--ink-2)}
.mnt-partial[hidden]{display:none}
.mnt-groups{gap:8px}
.mnt-group-head{align-items:center;padding:12px;background:transparent}
.mnt-group-name{font-size:13px}
.mnt-group-counts{margin-left:auto;font-size:11px}
.mnt-group-single .mnt-row{border-radius:9px}
.mnt-row{display:flex;align-items:center;gap:12px;min-height:66px;padding:12px 14px}
.mnt-row-copy{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0;text-align:left}
.mnt-row-name{font-size:13px;overflow-wrap:anywhere}
.mnt-language-list{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.mnt-language-badge{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:#fff;flex:none}
.mnt-language-icon{display:block;width:24px;height:24px;object-fit:contain;flex:none}
.mnt-resource-description{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mnt-row-context{font-size:11.5px;line-height:1.5;color:var(--ink-2);overflow-wrap:anywhere}
.mnt-row-action{margin-left:auto;display:flex;flex:none}
.mnt-row.selected{box-shadow:inset 0 0 0 1px var(--accent);background:var(--accent-soft)}
.mnt-group-toggle{margin:8px 12px}
.mnt-inspector{position:sticky;top:16px;max-height:calc(100vh - 40px);padding:16px;border-radius:10px;min-width:0}
.mnt-inspector-toolbar{display:flex;align-items:center;justify-content:space-between;color:var(--accent);font-size:12px;margin-bottom:14px}
.mnt-icon-button{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:6px;color:var(--ink-2);background:transparent;cursor:pointer}
.mnt-icon-button:hover{background:var(--panel-2)}
.mnt-inspector h3{font-size:18px;overflow-wrap:anywhere}
.mnt-inspector .mt-facts{grid-template-columns:1fr}
.mnt-inspector dd,.mnt-inspector p,.mnt-inspector li{overflow-wrap:anywhere}
.mnt-inspector li{font-size:12px;line-height:1.6}
.mnt-q{margin-top:16px;padding-top:14px}
.mnt-q h4,.mnt-q summary{font-size:12px;cursor:pointer}
.mnt-q p{font-size:12px;line-height:1.6}
.mnt-guidance-body{grid-template-columns:minmax(0,1fr)}
.mnt-guidance-body:has(>.mnt-procedure:not([hidden])){grid-template-columns:minmax(0,1fr) minmax(250px,320px)}
.mnt-procedure[hidden]{display:none}
.mnt-active-operation{padding:12px;border:1px solid var(--accent);border-radius:8px;color:var(--ink);font-size:13px;margin-bottom:16px}
.mnt-coverage-table{width:100%;border-collapse:collapse;font-size:12px}
.mnt-coverage-table th,.mnt-coverage-table td{padding:9px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:anywhere}
.mnt-coverage-table td small{display:block;color:var(--ink-2);margin-top:4px}
.mnt-history-scroll{max-height:244px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--line);border-radius:10px}
.mnt-history-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.mnt-history-table{min-width:520px;border-collapse:separate;border-spacing:0}
.mnt-history-table thead th{position:sticky;top:0;z-index:1;background:var(--panel);height:40px;box-sizing:border-box}
.mnt-history-table tbody tr:not(.mnt-history-day){height:40px}
.mnt-history-table .mnt-history-day th{background:var(--panel);font-weight:600;height:44px;box-sizing:border-box}
.mnt-history-table tbody tr:not(.mnt-history-day) td:first-child{padding-left:18px;white-space:nowrap;color:var(--ink-2)}
.mnt-history-toggle{display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:4px 0}
.mnt-history-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.mnt-history-chevron{width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);flex:none;margin:0 3px}
.mnt-history-toggle[aria-expanded="true"] .mnt-history-chevron{transform:rotate(45deg)}
.mnt-history-table tr[hidden]{display:none}
.mnt-history-table tbody th[scope="row"]{font-weight:400}
.mnt-history-table td:last-child,.mnt-history-table thead th:last-child{text-align:right;font-variant-numeric:tabular-nums}
.mnt-scan-section{margin-bottom:20px}
.mnt-scan-section h3{font-size:13px!important}
.mnt-scan-section p{font-size:12px;line-height:1.6;color:var(--ink-2)}
.mnt-side :is(button,input,summary,select):focus-visible,.mnt-main select:focus-visible,.mnt-inspector :is(button,summary):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.mnt-providers-status[data-state="running"]::before{animation:none}}
@media(max-width:900px){
  .mnt-body,.mnt-body:has(>.mnt-inspector:not([hidden])){grid-template-columns:1fr}
  .mnt-side{display:none}
  .mnt-filters-toggle{display:inline-flex}
  .mnt-inspector[hidden]{display:none}
  .mnt-inspector:not([hidden]){position:fixed;inset:0;z-index:20;max-height:none;border-radius:0;padding:16px}
  .mnt-guidance-body,.mnt-guidance-body:has(>.mnt-procedure:not([hidden])){grid-template-columns:1fr}
  .mnt-discovery-body{grid-template-columns:1fr}
}
@media(max-width:600px){
  .mnt-tabs{flex-wrap:wrap}
  .mnt-row{flex-wrap:wrap;text-align:left}
  .mnt-results-heading{align-items:flex-start;flex-wrap:wrap}
  .mnt-providers-status{margin-left:0;flex-basis:80%}
  .mnt-scope{flex-wrap:wrap}
  .mnt-panel{padding:12px}
  .mnt-group-counts{flex-basis:100%;margin-left:30px}
  .mnt-row-action{justify-self:start}
}
@media(max-width:340px){
  .mnt-toolbar{flex-direction:column;align-items:stretch}
  .mnt-scope{justify-content:flex-start}
}

/* Both themes and forced-colors keep focus, selection, boundaries, and lane
   distinctions (MNT-UX-009): every mnt-* interactive element gets an explicit
   focus outline above, and forced-colors mode additionally asks for system
   colors so Windows High Contrast never loses a boundary a background color
   alone was carrying. */
@media(forced-colors:active){
  .mnt-group,.mnt-inspector,.mnt-procedure,.mnt-discovery-main section,.mnt-facet-group,.mnt-lane-badge{border:1px solid CanvasText}
  .mnt-row:focus-visible,.mnt-view-btn:focus-visible,.mnt-row-action{forced-color-adjust:none;outline:2px solid Highlight}
  .mnt-view-btn.on{forced-color-adjust:none;background:Highlight;color:HighlightText}
  .mnt-warning{forced-color-adjust:none;border-left-color:Highlight}
}

/* The Maintenance toolbar owns measurement actions in this destination. */
body:has(#panel-sys-maintenance:not([hidden])) #sys-rescan{display:none}
.mnt-project-section{list-style:none;margin:0 0 24px}
.mnt-project-section>h4{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;margin:8px 0 12px;color:var(--ink)}
.mnt-inspector:not([hidden]){animation:mnt-inspector-enter .16s ease-out}
@keyframes mnt-inspector-enter{from{opacity:.6;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}
@media(prefers-reduced-motion:reduce){.mnt-inspector:not([hidden]){animation:none}}

.mnt-project-kind{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:400;color:var(--ink-2);white-space:nowrap;margin-left:8px}
.mnt-project-kind .mnt-icon{width:13px;height:13px}
.mnt-facet-opt .mnt-project-kind{display:flex;margin:3px 0 0}
.mnt-filter-note{font-size:11px;color:var(--ink-2);line-height:1.5}

/* Focus browser: a single level, then details below the selected list. */
.mnt-breadcrumbs{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;margin:12px 0;color:var(--ink-2)}
.mnt-breadcrumbs button{border:0;background:none;padding:3px 0;color:var(--accent);font:inherit;cursor:pointer}
.mnt-breadcrumbs button:focus-visible,.mnt-focus-list button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mnt-focus-help{font-size:12px;color:var(--ink-2);margin:8px 0 16px}
.mnt-focus-list{display:grid;gap:8px;list-style:none;margin:0;padding:0}
.mnt-focus-list>.mnt-row,.mnt-focus-list>li>.mnt-row{border:1px solid var(--line);border-radius:10px;min-height:68px;padding:14px 16px}
.mnt-focus-list .mnt-row-name{overflow-wrap:anywhere}
.mnt-project-title{display:flex;align-items:center;gap:7px}
.mnt-project-title>.mnt-icon{width:16px;height:16px;flex:none}
.mnt-focus-node .mnt-project-kind{display:flex;margin:5px 0 0}
.mnt-node-count{font-size:11px;color:var(--ink-2);margin-left:auto;white-space:nowrap}
.mnt-main>.mnt-inspector:not([hidden]){position:static;inset:auto;max-height:none;margin-top:20px;border-radius:12px;padding:20px;overflow:visible}
.mnt-relationships{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:10px;margin-top:12px}
.mnt-relationship{border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel-2);min-width:0}
.mnt-relationship summary{cursor:pointer;font-size:12px}.mnt-relationship summary>span{color:var(--ink-2)}
.mnt-relationship summary>strong{display:block;margin-top:5px;color:var(--ink);font-size:13px;overflow-wrap:anywhere}
.mnt-relationship ul{list-style:none;margin:10px 0 0;padding:0}
.mnt-relationship-link{border:0;background:none;color:var(--accent);font:inherit;text-align:left;padding:7px 0;cursor:pointer;overflow-wrap:anywhere}
.mnt-relationship-link span{display:block;color:var(--ink-2);font-size:11px}
.mnt-related-context{border-left:2px solid var(--accent);padding-left:10px}

.mnt-repository-group { margin:0 0 18px; }
.mnt-repository-group h3 { font-size:13px; color:var(--ink-2); margin:12px 0 8px; overflow-wrap:anywhere; }
.mnt-project-origins { display:block; font-size:11px; color:var(--ink-2); margin:3px 0; }
`;
