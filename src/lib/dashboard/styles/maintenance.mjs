export const MAINTENANCE_CSS = `
/* Maintenance is one inspection ledger, not another analytics card grid. The
   outer System card supplies the established surface; hairlines and selection
   state carry the hierarchy within it. */
.mt-card{gap:0;padding:0;overflow:hidden}
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
.mt-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) minmax(130px,auto) minmax(110px,auto);gap:7px;align-items:center;padding:0 14px 11px}
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
.mt-change{grid-area:change;align-self:center;color:var(--ink-2);font-size:11.5px;line-height:1.4}
.mt-detail{max-height:min(62vh,620px);overflow:auto;padding:15px 16px;background:color-mix(in srgb,var(--panel) 96%,var(--ink) 4%)}
.mt-detail-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.mt-detail-head .mt-state{grid-area:auto}
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
  .mt-banner{flex-direction:column;gap:2px}.mt-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
  .mt-summary>div:nth-child(2){border-right:0}.mt-summary>div:nth-child(-n+2){border-bottom:1px solid var(--line)}
  .mt-toolbar{grid-template-columns:1fr 1fr}.mt-toolbar input{grid-column:1/-1}.mt-results{grid-column:1/-1}
  .mt-row{grid-template-columns:1fr;grid-template-areas:"state" "identity" "change" "owner";gap:5px;min-height:44px;padding:11px 13px}
  .mt-facts{grid-template-columns:1fr}.mt-detail{padding:14px}.mt-buckets{padding-left:12px;padding-right:12px}
  .mt-action-bar{align-items:flex-start;flex-direction:column}.mt-confirm-head,.mt-confirm-body,.mt-confirm-actions{padding-left:14px;padding-right:14px}.mt-confirm-status{margin-left:14px;margin-right:14px}
}
`;
