export const USAGE_CSS = `
/* ── Usage tab (ADR-0009) ───────────────────────────────────────────────────
   Same Apple system motif as the rest of the panel: hairline-separated rows,
   soft-shadowed strips, systemBlue for magnitude and systemPurple as the second
   series. Nothing here fetches; every figure below is rendered from /api/usage. */
.usage-bar{display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px}
.subseg{gap:2px}
.subseg .seg-btn[aria-selected="true"]{
  background:var(--thumb); box-shadow:0 1px 4px rgba(0,0,0,.18),0 0 0 .5px rgba(0,0,0,.04);
}
.seg-n{opacity:.6; font-size:11px}
.segbadge{
  min-width:16px; height:16px; padding:0 5px; border-radius:8px; background:var(--warn);
  color:#000; font-size:10.5px; font-weight:700; display:inline-flex;
  align-items:center; justify-content:center;
}
.segbadge[hidden]{display:none}
@media(max-width:720px){
  .secondary-shell{padding-top:9px}
  .secondary-group{align-items:flex-start; overflow-x:auto; scrollbar-width:none}
  .secondary-group::-webkit-scrollbar{display:none}
  .secondary-actions{position:sticky; right:0; background:var(--bg); padding-left:8px}
  .view-heading{min-height:70px}
}
.filters{display:flex; gap:8px; flex-wrap:wrap; margin-left:auto}
.chipf{
  font-size:12px; padding:4px 11px; border-radius:100px; border:1px solid var(--line);
  background:var(--panel); color:var(--ink-2); cursor:pointer; font-family:inherit;
}
.chipf.on{border-color:var(--accent); color:var(--accent); background:var(--accent-soft)}
.chipf:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.chipf:disabled{opacity:.5; cursor:not-allowed}
/* Usage panes are independent products. The !important guard is intentional here:
   a broad future section rule must never let the Models operator panels leak
   into Scorecard, Limits, Findings, Sessions, or Transcript. */
#panel-usage > .view[hidden]{display:none!important}

/* Model lifecycle intelligence: an evidence ledger, intentionally denser than
   the Usage charts because each column is an independent provenance claim. */
.mli-summary{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:12px 0 18px;
  padding:13px 15px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel);
  color:var(--ink);text-decoration:none;box-shadow:var(--shadow)}
.mli-summary:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.mli-summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mli-summary span:first-child{display:flex;flex-direction:column;gap:3px}.mli-summary small{color:var(--mli-muted)}
.mli-copy{margin:0 0 12px;color:var(--mli-muted);font-size:12px}.mli-ledger>summary{display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;list-style:none}.mli-ledger>summary::-webkit-details-marker{display:none}.mli-ledger-title{display:flex;align-items:baseline;gap:8px}.mli-ledger>summary:hover .chev{color:var(--accent)}.mli-ledger[open]>summary .chev{transform:rotate(90deg);color:var(--accent)}.mli-ledger>summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}.mli-ledger>summary small{display:block;margin-top:3px;color:var(--mli-muted);font-size:11px}.mli-catalog-body{padding-top:14px}
.mli-attention{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin-bottom:16px}
.mli-alert{padding:10px 12px;border-left:3px solid var(--warn);border-radius:0 var(--r-sm) var(--r-sm) 0;
  background:color-mix(in srgb,var(--warn) 9%,var(--panel));font-size:12px;color:var(--ink)}
.mli-alert[data-level="fail"]{border-left-color:var(--fail);background:color-mix(in srgb,var(--fail) 8%,var(--panel))}
.mli-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;align-items:end;
  margin-bottom:10px;padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel-2)}
.mli-filter{display:grid;gap:4px;min-width:0;color:var(--mli-muted);font-size:9.5px;font-weight:650;
  letter-spacing:.055em;text-transform:uppercase}
.mli-filter input,.mli-filter select{width:100%;min-width:0;min-height:34px;padding:6px 8px;border:1px solid var(--line);
  border-radius:7px;background:var(--panel);color:var(--ink);font:11px var(--sans);color-scheme:dark}
[data-theme="light"] .mli-filter input,[data-theme="light"] .mli-filter select{color-scheme:light}
.mli-filter input::placeholder{color:var(--ink-dim)}
.mli-filter input:focus-visible,.mli-filter select:focus-visible,.mli-reset:focus-visible,.mli-load-more:focus-visible,
.mli-table th button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mli-reset,.mli-load-more{min-height:34px;padding:6px 12px;border:1px solid var(--line);border-radius:7px;
  background:var(--panel);color:var(--ink-2);font:600 11px var(--sans);cursor:pointer}
.mli-reset:hover,.mli-load-more:hover{border-color:var(--accent);color:var(--accent)}
.mli-reset:disabled,.mli-load-more:disabled{opacity:.55;cursor:wait}
.mli-results{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:0 2px 8px;
  color:var(--mli-muted);font-size:10.5px}.mli-results .mono{font-size:9.5px}
.mli-table-wrap{position:relative;max-height:min(58vh,540px);overflow:auto;overscroll-behavior:contain;
  scrollbar-gutter:stable both-edges;scroll-padding-top:36px}
.mli-table-wrap:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.mli-table{width:100%;border-collapse:collapse;min-width:920px;font-size:11.5px}
.mli-table thead{position:sticky;top:0;z-index:3}
.mli-table thead th{text-align:left;padding:0 9px 9px;color:var(--mli-muted);font-size:10px;text-transform:uppercase;
  letter-spacing:.06em;border-bottom:1px solid var(--line);background:var(--panel)}
.mli-table th button{display:flex;align-items:center;gap:4px;width:100%;min-height:32px;padding:7px 0 3px;border:0;
  background:transparent;color:inherit;font:inherit;letter-spacing:inherit;text-transform:inherit;text-align:left;cursor:pointer;white-space:nowrap}
.mli-table th[aria-sort="ascending"],.mli-table th[aria-sort="descending"]{color:var(--accent)}
.mli-table th button [aria-hidden]{font:700 10px var(--mono)}
.mli-table td,.mli-table tbody th{padding:10px 9px;border-bottom:1px solid var(--line);vertical-align:middle}
.mli-table tbody th{text-align:left;color:inherit;font:inherit;text-transform:none}
.mli-table tbody th:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.mli-table tbody tr:last-child td{border-bottom:0}.mli-id{display:flex;flex-direction:column;gap:2px}
.mli-id b{font-size:12px}.mli-id small{color:var(--mli-muted);font-family:var(--mono)}
.mli-id .mli-selector{color:var(--ink-2)}
.mli-id .mli-links{display:flex;gap:5px;margin-top:2px}.mli-id .mli-links a{color:var(--accent);text-decoration:none}
.mli-id .mli-links a:hover{text-decoration:underline}.mli-id .mli-links a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mli-state{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;color:var(--mli-muted);cursor:pointer}
.mli-state::before{content:"?";display:grid;place-items:center;width:15px;height:15px;border-radius:50%;
  background:var(--panel-2);font:700 9px var(--mono)}
.mli-state[data-state="yes"]{color:var(--mli-ok)}.mli-state[data-state="yes"]::before{content:"✓";background:color-mix(in srgb,var(--mli-ok) 13%,var(--panel))}
.mli-state[data-state="no"]{color:var(--mli-fail)}.mli-state[data-state="no"]::before{content:"×";background:color-mix(in srgb,var(--mli-fail) 12%,var(--panel))}
.mli-proof{position:relative}.mli-proof summary{list-style:none}.mli-proof summary::-webkit-details-marker{display:none}
.mli-proof summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.mli-life{cursor:pointer;color:var(--ink)}.mli-life::after{content:" · evidence";color:var(--mli-muted);font-family:var(--sans);font-size:10px}
.mli-proof-body{display:grid;gap:3px;min-width:220px;margin-top:6px;padding:7px 8px;border:1px solid var(--line-2);
  border-radius:8px;background:var(--panel-2);color:var(--ink);font-size:10.5px;line-height:1.45}
.mli-proof-row{display:block}.mli-proof-row b{color:var(--ink)}
.mli-list{display:grid;gap:8px}.mli-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
  padding:8px 0;border-bottom:1px solid var(--line);font-size:12px}.mli-row:last-child{border-bottom:0}
.mli-row small{color:var(--mli-muted);text-align:right}.mli-history-scroll{max-height:420px;overflow:auto;
  overscroll-behavior:contain;scrollbar-gutter:stable both-edges}.mli-history-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.mli-history-table{width:100%;min-width:780px;border-collapse:collapse;font-size:11px}.mli-history-table thead{position:sticky;top:0;z-index:2}
.mli-history-table th,.mli-history-table td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.mli-history-table thead th{background:var(--panel);color:var(--mli-muted);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase}
.mli-history-table tbody th{font-size:11.5px;white-space:nowrap}.mli-history-table tbody tr:last-child>*{border-bottom:0}
.mli-history-model,.mli-history-evidence{display:grid;gap:2px}.mli-history-model b,.mli-history-evidence b{font-size:11px}
.mli-history-model small,.mli-history-evidence small{color:var(--mli-muted);font:9.5px/1.35 var(--mono);white-space:nowrap}
.mli-history-evidence[data-state="confirmed"] b{color:var(--mli-ok)}.mli-history-evidence[data-state="provisional"] b{color:var(--warn)}
.mli-consumer-scroll{max-height:420px;overflow:auto;
  overscroll-behavior:contain;scrollbar-gutter:stable}.mli-rate{display:grid;gap:3px;min-width:190px}.mli-rate b{font:600 11px var(--mono)}
.mli-rate small{color:var(--mli-muted);font:10px/1.35 var(--sans)}
.mli-pager{display:flex;justify-content:center;padding-top:10px}.mli-load-more[hidden]{display:none}
.mli-detail-open{border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--accent);padding:5px 8px;cursor:pointer}.mli-detail-open:focus-visible,.mli-detail-dialog button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.mli-detail-dialog{width:min(680px,calc(100vw - 32px));max-height:min(80vh,720px);overflow:auto;border:1px solid var(--line);border-radius:var(--r);background:var(--panel);color:var(--ink);padding:18px;box-shadow:0 20px 70px #0008}.mli-detail-dialog::backdrop{background:#0009}.mli-detail-head{display:flex;justify-content:space-between;gap:16px;align-items:center}.mli-detail-head h2{margin:0}.mli-detail-head button{border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--ink);padding:6px 9px}.mli-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:18px 0}.mli-detail-grid div{border:1px solid var(--line);border-radius:8px;padding:9px}.mli-detail-grid dt{font-size:10px;text-transform:uppercase;color:var(--mli-muted)}.mli-detail-grid dd{margin:4px 0 0}.mli-detail-dialog h3{font-size:13px}
@media(min-width:1100px){.mli-filter-search{grid-column:span 2}}
@media(max-width:720px){.mli-summary{align-items:flex-start}.mli-attention{grid-template-columns:1fr}
  .mli-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.mli-filter-search{grid-column:1/-1}
  .mli-results{align-items:flex-start;flex-direction:column;gap:3px}.mli-table-wrap{max-height:min(62vh,480px)}}

/* hero KPIs */
.hero{display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); margin-bottom:14px}
.kpi{background:var(--panel); border:1px solid var(--line); border-radius:var(--r); padding:15px 16px; box-shadow:var(--shadow)}
.kpi .k{font-size:10.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-dim)}
.kpi .v{font-size:27px; font-weight:700; letter-spacing:-.028em; margin-top:5px; line-height:1.05}
.kpi .d{font-size:11.5px; color:var(--ink-2); margin-top:5px}
/* A parenthetical qualifier belongs on its own line, not wrapped mid-phrase.
   "297h summed (sessions" / "overlap)" split the caveat across the break and
   made the number harder to read than no caveat at all. */
.kpi .d-note{display:block; color:var(--ink-dim); font-size:11px; margin-top:2px}
.kpi.accent .v{color:var(--accent)}
.kpi.warnv .v{color:var(--warn)}
/* The tile footer carries the change against the previous equal-length window
   and the per-day trend for the same figure. space-between rather than a gap,
   so the chip stays left and the sparkline anchors to the tile's right edge
   instead of drifting with the chip's width. Each line is scaled to its OWN
   min/max and the tiles do not all cover the same day set (Engaged time is
   drawn from days worked, the rest from days billed), so these are shape
   readings one tile at a time — not a row to compare across. Both halves
   self-suppress when their data is absent, and the row is omitted entirely
   when neither renders — so a tile never grows an empty band. */
.kpi-foot{display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:9px; min-height:24px}
/* The chip is the reading; the line is the shape. So the chip never shrinks or
   wraps — a unit-suffixed delta ("0 pp") broke across two lines once the cache
   tile gained a trend to share the row with — and the sparkline gives up width
   instead, scaling inside its own viewBox. */
.kpi-foot .dchip{flex:none; white-space:nowrap}
.kpi-foot .spark{flex:0 1 auto; min-width:0; max-width:100%}
/* The second KPI row is a continuation of the hero, not a new section: same
   grid, pulled up so the two read as one block, and quieter numbers because
   these are derived rates rather than the measured totals above them. */
.hero-2{margin-top:-4px}
.hero-2 .kpi{background:var(--panel-2); box-shadow:none}
.hero-2 .kpi .v{font-size:22px}
.note{
  display:flex; gap:9px; padding:10px 14px; margin-bottom:16px; border-radius:var(--r-sm);
  background:var(--accent-soft); color:var(--ink-2); font-size:12.5px; align-items:baseline;
}
.note b{color:var(--ink)}
.note .i{color:var(--accent); font-weight:700}
/* local-source pills — sit right-aligned in the sticky tabbar, one per host */
.tabbar .source-health{
  display:flex; align-items:stretch; gap:6px; margin-left:auto;
  color:var(--ink-2); font-size:11.5px;
}
.source-health[hidden]{display:none}
.source-pill{
  display:inline-flex; align-items:stretch; border-radius:999px;
  background:var(--panel-2); overflow:hidden;
}
.source-pill .sp-icon{display:flex; align-items:center; padding:4px 10px 4px 5px}
.tabbar .source-pill .live-host{
  width:32px; height:32px; display:grid; place-items:center;
  border-radius:50%; background:var(--bg); border:1px solid var(--line);
}
.tabbar .source-pill .live-host-icon{width:20px; height:20px; stroke-width:1.8}
.source-pill .sp-status{
  display:flex; align-items:center; padding:5px 14px 5px 10px; font-size:13px;
  font-weight:600; letter-spacing:-.006em; text-transform:lowercase; color:var(--ink-2);
}
.source-pill[data-status="ok"] .sp-status{color:var(--ok)}
.source-pill[data-status="degraded"]{background:color-mix(in srgb,var(--warn) 16%,var(--panel-2))}
.source-pill[data-status="degraded"] .sp-status{color:var(--warn)}
.source-pill[data-status="absent"] .sp-status,.source-pill[data-status="not-read"] .sp-status{color:var(--ink-dim)}
.sh{display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px}
.sh h2{font-size:15px; font-weight:600; letter-spacing:-.014em; margin:0}
.sh .n{color:var(--ink-dim); font-size:11.5px}
/* A qualifier that must not share a line with the caption it qualifies: as an
   inline tail it wrapped mid-phrase, leaving "· 4" dangling at the end of one
   line and "dropped/errored turns excluded" orphaned on the next — the count
   read as part of the caption rather than as its own fact. */
.sh .n-sub{display:block}
.sh .n-sub:empty{display:none}
.two{display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
#panel-usage .strip{margin-top:0; margin-bottom:16px}

/* day bars */
.days{display:flex; gap:5px; align-items:flex-end; height:118px}
.daybar{flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%}
.db-fill{
  width:100%; border-radius:5px 5px 2px 2px;
  background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 35%,transparent));
  transition:filter .15s ease;
}
.daybar:hover .db-fill{filter:brightness(1.35)}
.db-lab{font-family:var(--mono); font-size:9.5px; color:var(--ink-dim); margin-top:6px}

/* punchcard */
.pc-row{display:flex; align-items:center; gap:3px; margin-bottom:3px}
.pc-day{font-family:var(--mono); font-size:10px; color:var(--ink-dim); width:28px; flex:none}
.pc{flex:1; height:13px; border-radius:3px; background:color-mix(in srgb,var(--accent) calc(var(--v)*100%),var(--panel-2))}
.pc-axis{display:flex; gap:3px; margin-left:31px; margin-top:5px}
.pc-axis span{flex:1; font-family:var(--mono); font-size:8.5px; color:var(--ink-dim); text-align:center}

/* magnitude rows (models / projects / categories) */
.mrow{
  display:grid; grid-template-columns:minmax(120px,1.5fr) 2fr 62px minmax(96px,auto);
  gap:11px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line);
}
.mrow:last-child{border-bottom:0}
.mname{font-size:12.5px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.mbar{height:7px; border-radius:4px; background:var(--panel-2); overflow:hidden}
.mbar i{display:block; height:100%; border-radius:4px; background:var(--accent)}
.mbar i.alt{background:var(--purple)}
.mval{font-size:12.5px; text-align:right; color:var(--ink)}
.msub{font-size:10.5px; color:var(--ink-dim); text-align:right}
.crow{
  display:grid; grid-template-columns:minmax(140px,1.4fr) 2fr 62px minmax(128px,auto);
  gap:11px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line);
  cursor:pointer; font-family:inherit; text-align:left; background:transparent; border-left:0; border-right:0; border-top:0; width:100%; color:inherit;
}
.crow:last-child{border-bottom:0}
.crow:hover{background:var(--panel-2)}
.crow:focus-visible{outline:2px solid var(--accent); outline-offset:-2px}
.crow.uncl{opacity:.6}
.c-name{font-size:12.5px; display:flex; align-items:center; gap:7px; color:var(--ink)}
.conf{width:6px; height:6px; border-radius:50%; background:var(--ok); flex:none; display:inline-block}

/* provider split */
.psplit{display:flex; gap:10px; flex-wrap:wrap}
.pcard{flex:1; min-width:130px; border:1px solid var(--line); border-radius:var(--r-sm); padding:13px 15px; background:var(--panel-2)}
.pcard .ph{display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; margin-bottom:9px}
.pdot{width:9px; height:9px; border-radius:50%}
.pdot.c{background:var(--warn)}
.pdot.x{background:var(--accent)}
.pdot.o{background:var(--purple)}
.pcard .pv{font-size:21px; font-weight:700; letter-spacing:-.02em}
.pcard .pl{font-size:11.5px; color:var(--ink-dim); margin-top:4px}
.pcard.idle{opacity:.55}
.provider-analytics-models{margin-top:14px}
.tokbar{display:flex; height:9px; border-radius:5px; overflow:hidden; margin-top:11px}
.tokbar i{display:block; height:100%}
.legend{display:flex; gap:14px; flex-wrap:wrap; margin-top:9px; font-size:11px; color:var(--ink-dim)}
.legend b{color:var(--ink); font-weight:600}
.lg{display:inline-flex; align-items:center; gap:5px}
.lg i{width:8px; height:8px; border-radius:2px; display:inline-block}

/* findings */
.ins-grid{display:grid; gap:11px; margin-bottom:11px}
/* Findings scrolls in place too, so the window keeps a fixed frame across all
   three list views instead of each one growing the document to a different
   height. Padding-right keeps the scrollbar off the card border. */
#u-insights{
  max-height:var(--listh);
  min-height:200px;
  overflow-y:auto;
  overscroll-behavior:contain;
  padding-right:4px;
  scrollbar-width:thin;
  scrollbar-color:var(--thumb) transparent;
}
#u-insights::-webkit-scrollbar{width:10px}
#u-insights::-webkit-scrollbar-thumb{background:var(--thumb); border-radius:6px; border:3px solid transparent; background-clip:content-box}
#u-insights::-webkit-scrollbar-track{background:transparent}

.icard{
  background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--sv,var(--accent));
  border-radius:var(--r-sm); padding:13px 15px; box-shadow:var(--shadow);
}
.icard[data-sev="warn"]{--sv:var(--warn)}
.icard[data-sev="info"]{--sv:var(--accent)}
.icard[data-sev="ok"]{--sv:var(--ok)}
.i-top{display:flex; align-items:center; gap:9px; margin-bottom:7px; flex-wrap:wrap}
.i-n{
  width:19px; height:19px; border-radius:50%; background:var(--sv); color:#000;
  font-size:11px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; flex:none;
}
.i-title{font-size:14px; font-weight:600; letter-spacing:-.012em; color:var(--ink)}
.i-kind{font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink-dim); border:1px solid var(--line); border-radius:100px; padding:1px 7px}
.i-imp{margin-left:auto; font-size:12.5px; font-weight:600; color:var(--sv); white-space:nowrap}
.i-imp.soft{color:var(--ink-dim); font-weight:400; font-size:11px}
.i-find{margin:0 0 5px; font-size:12.5px; color:var(--ink-2); line-height:1.52}
.i-ev{margin:0 0 9px; font-size:11.5px; color:var(--ink-dim); line-height:1.5}
.i-act{display:flex; gap:8px; font-size:12.5px; color:var(--ink); align-items:baseline; border-top:1px solid var(--line); padding-top:9px}
.i-arrow{color:var(--sv); font-weight:700}
.i-cmd{font-family:var(--mono); font-size:11.5px; color:var(--accent); background:var(--accent-soft); border-radius:5px; padding:1px 6px; white-space:nowrap}
.i-src{margin-top:9px; border-top:1px solid var(--line); padding-top:8px}
.i-src summary{font-size:11.5px; color:var(--ink-dim); cursor:pointer; list-style:none}
.i-src summary::-webkit-details-marker{display:none}
.i-src summary::before{content:"\\25B8 "; color:var(--accent)}
.i-src[open] summary::before{content:"\\25BE "}
.i-src ul{margin:8px 0 0; padding-left:16px}
.i-src li{font-size:11.5px; color:var(--ink-2); margin-bottom:4px}
.i-src a{color:var(--accent); text-decoration:none}
.i-src a:hover{text-decoration:underline}

/* tiered project tree */
.ptree{display:flex; flex-direction:column; gap:8px}
.pgroup{border:1px solid var(--line); border-radius:var(--r-sm); overflow:hidden; background:var(--panel)}
.phead{
  display:grid; grid-template-columns:16px minmax(120px,1.1fr) minmax(150px,1.6fr) 64px 44px 58px 66px;
  gap:10px; align-items:center; width:100%; padding:11px 13px; background:var(--panel-2);
  border:0; color:var(--ink); font-family:inherit; font-size:13px; cursor:pointer; text-align:left;
}
.phead:hover{background:var(--raised)}
.phead:focus-visible{outline:2px solid var(--accent); outline-offset:-2px}
.chev{color:var(--ink-dim); transition:transform .18s ease; display:inline-block}
.pgroup[data-open] .chev{transform:rotate(90deg); color:var(--accent)}
.pname{font-weight:600; letter-spacing:-.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.pchips{display:flex; gap:5px; flex-wrap:wrap; overflow:hidden}
.pchip{font-size:10px; color:var(--ink-dim); border:1px solid var(--line); border-radius:100px; padding:1px 7px; white-space:nowrap}
.pchip b{color:var(--ink-2); font-weight:600}
.pn{font-size:11.5px; color:var(--ink-dim); text-align:right}
.pcost{font-size:13px; font-weight:600; text-align:right; color:var(--ink)}
.pbody{display:none; background:var(--line); gap:1px; flex-direction:column}
/* Each expanded project scrolls INSIDE its own group. A project with 108
   sessions otherwise pushes every project below it off-screen and forces the
   whole window to scroll, so you lose the group headers you were comparing. */
.pgroup[data-open] .pbody{
  display:flex;
  max-height:var(--listh);
  overflow-y:auto;
  overscroll-behavior:contain;   /* reaching the end must not scroll the page */
  scrollbar-width:thin;
  scrollbar-color:var(--thumb) transparent;
}
.smore{background:var(--panel); padding:9px 13px; font-size:11.5px; color:var(--ink-dim)}
.smore button{background:transparent; border:0; color:var(--accent); cursor:pointer; font-family:inherit; font-size:11.5px; padding:0}
.cat{
  font-size:10px; border-radius:100px; padding:1px 8px; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; border:1px solid color-mix(in srgb,var(--ok) 30%,transparent);
  color:var(--ok); background:color-mix(in srgb,var(--ok) 11%,transparent);
}
.cat[data-w="0"]{
  border-color:color-mix(in srgb,var(--warn) 30%,transparent);
  color:var(--warn); background:color-mix(in srgb,var(--warn) 10%,transparent);
}
.cat.uncl{border-color:var(--line); color:var(--ink-dim); background:transparent}

/* session rows */
/* The LEADING 18px column is the detail expander. It is deliberately first, so
   the caret sits outside the row's content and reads as an affordance on the
   row rather than on any one cell. Both grids below must carry it — a column
   added here and forgotten in the breakpoint shifts every mobile cell by one,
   which is silent: the row still renders, it just renders the wrong data under
   each heading. */
.srow{
  display:grid; grid-template-columns:18px 82px minmax(150px,2fr) minmax(80px,.55fr) minmax(155px,1.35fr) 106px 46px 60px 62px 68px 20px;
  gap:10px; align-items:center; padding:9px 13px; background:var(--panel); font-size:12.5px; cursor:pointer;
}
.srow:hover{background:var(--panel-2)}
.s-host{font-size:10px; font-weight:600; text-align:center; padding:2px 6px; border-radius:100px; border:1px solid var(--line-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.s-claude{color:var(--warn); background:color-mix(in srgb,var(--warn) 12%,transparent); border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.s-codex{color:var(--accent); background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.s-title{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
/* Per-session evidence chips, in their OWN column rather than crowded into
   .s-title — the title is the row's identifier and must not be truncated to
   make room for its annotations. Each chip renders only when the transcript
   established that fact, so an absent chip is the signal that it was never
   recorded; the cell overflows hidden rather than wrapping, which would give
   this row a second line and halve the list's density.
   The track is sized (155px floor) from the widest chip set measured across a
   real 100-row corpus, which was 170px — so the common row does not truncate
   at all. The rarer wider set still has to degrade somehow, and .s-mode is the
   one chip that shrinks: the numbers beside it are short and must stay whole,
   while a posture ellipsised to "unrestric…" is the same treatment .cat and
   .s-title already get in this table, with the full value in its tooltip. */
.s-chips{display:flex; gap:4px; overflow:hidden; min-width:0}
.s-chip{
  font-family:var(--mono); font-size:9.5px; color:var(--ink-dim); white-space:nowrap; flex:none;
  border:1px solid var(--line); border-radius:100px; padding:1px 6px; background:var(--panel-2);
}
/* The posture chip always spells the posture out, so its tint is a second
   channel and never the only one carrying "this session had a wide mandate". */
.s-chip.s-mode{color:var(--ink-2); flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis}
.s-chip.s-mode[data-mode="plan"]{color:var(--purple); border-color:color-mix(in srgb,var(--purple) 32%,transparent)}
.s-chip.s-mode[data-mode="unrestricted"]{color:var(--warn); border-color:color-mix(in srgb,var(--warn) 32%,transparent)}
.s-proj,.s-when,.s-dur,.s-turns,.s-tok{color:var(--ink-2); font-size:11.5px}
.s-cost{text-align:right; color:var(--ink); font-size:12px}
.s-tx{background:transparent; border:0; color:var(--ink-dim); font-size:14px; cursor:pointer; padding:0; border-radius:5px}
.s-tx:hover{color:var(--accent); background:var(--accent-soft)}

/* row expander — a real <button>, so it is tab-reachable and announced. The
   chevron rotation reuses the .phead .chev idiom rather than inventing a
   second vocabulary for "this opens". */
.s-exp{
  background:transparent; border:0; color:var(--ink-dim); font-size:13px; line-height:1; cursor:pointer;
  padding:0; border-radius:4px; transition:transform .18s ease, color .18s ease; display:inline-block;
}
.s-exp:hover{color:var(--accent)}
.s-exp:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.s-exp[aria-expanded="true"]{transform:rotate(90deg); color:var(--accent)}
/* ADR-0009 §4b — the repo answers "which project", this answers "which branch
   of it". Rendered only when there IS one, so its presence is the signal. */
.s-wt{
  margin-left:7px; font-size:9.5px; font-family:var(--mono); color:var(--purple); white-space:nowrap;
  border:1px solid color-mix(in srgb,var(--purple) 30%,transparent);
  background:color-mix(in srgb,var(--purple) 10%,transparent); border-radius:100px; padding:1px 6px;
}
/* The detail strip is a SIBLING of .srow inside .pbody, not a grid child of
   it — so it spans the full width instead of joining the column layout. No
   display is set here: the UA's [hidden] rule must keep working. */
.sdetail{background:var(--panel-2); padding:9px 13px 11px 41px; border-top:1px solid var(--line); font-size:11.5px}
.sdetail[hidden]{display:none}
/* Label and value are INLINE-level, not grid or flex tracks, and that is a
   readability decision rather than a layout one. This markup is divs and
   spans, not a real <dl> — so block-level cells would hand a screen reader two
   unrelated blocks with nothing pairing them, and split the label from its
   value for copy-paste and for anything else reading the rendered text. The
   classifier's reasoning is one statement and should survive as one. The
   fixed-width inline-block keeps the column alignment a grid would have given,
   so nothing is lost visually. */
.sd-line{padding:2px 0}
.sd-k{
  display:inline-block; width:74px; vertical-align:top; color:var(--ink-dim);
  font-size:10px; text-transform:uppercase; letter-spacing:.06em;
}
.sd-v{display:inline-block; vertical-align:top; max-width:calc(100% - 84px); color:var(--ink-2); word-break:break-word}
.sd-conf{color:var(--ink-dim)}

/* transcript reader */
/* The crumb stays put while the turns scroll beneath it — on a 2,216-turn
   session the header is exactly what you lose first when the page scrolls. */
.tcrumb{display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--ink-2); margin-bottom:14px; flex-wrap:wrap}
#u-turns{
  max-height:var(--listh);
  min-height:200px;
  overflow-y:auto;
  overscroll-behavior:contain;
  scrollbar-width:thin;
  scrollbar-color:var(--thumb) transparent;
}
/* WebKit needs its own scrollbar rules; keep them quiet and on-motif. */
#u-turns::-webkit-scrollbar,.pgroup[data-open] .pbody::-webkit-scrollbar{width:10px}
#u-turns::-webkit-scrollbar-thumb,.pgroup[data-open] .pbody::-webkit-scrollbar-thumb{
  background:var(--thumb); border-radius:6px; border:3px solid transparent; background-clip:content-box;
}
#u-turns::-webkit-scrollbar-track,.pgroup[data-open] .pbody::-webkit-scrollbar-track{background:transparent}
@media (max-width:700px){ :root{--listh:clamp(180px, calc(100vh - 340px), 460px)} }
.tcrumb button{
  background:var(--panel); border:1px solid var(--line); color:var(--ink-2); border-radius:100px;
  padding:4px 12px; font-family:inherit; font-size:12px; cursor:pointer;
}
.tcrumb button:hover{border-color:var(--line-2); color:var(--ink)}
.turn{display:grid; grid-template-columns:78px 1fr; gap:14px; padding:13px 0; border-bottom:1px solid var(--line)}
.turn:last-child{border-bottom:0}
.t-who{font-family:var(--mono); font-size:10.5px; color:var(--ink-dim); text-transform:uppercase; letter-spacing:.06em}
.t-user .t-who{color:var(--accent)}
/* Tool results and harness context ride the user ROLE in the Messages API but
   are not the person — purple ties them visually to the tool chips, and the
   accent stays reserved for turns the human actually typed. */
.t-tool .t-who{color:var(--purple)}
/* Harness sentinel markup, restyled (fmtHarness): a slash command renders as
   a chip, and system-reminder / caveat / stdout blocks get a labelled quiet
   panel — the wrapped content stays verbatim, only the XML wrappers go. */
.h-cmd{
  font-family:var(--mono); font-size:12px; color:var(--accent);
  border:1px solid color-mix(in srgb,var(--accent) 32%,transparent);
  background:color-mix(in srgb,var(--accent) 10%,transparent); border-radius:5px; padding:1px 7px;
}
.h-note{display:block; border-left:2px solid var(--line-2); padding:5px 10px; margin:5px 0; color:var(--ink-dim)}
.h-tag{
  display:block; font-style:normal; font-family:var(--mono); font-size:9.5px;
  text-transform:uppercase; letter-spacing:.06em; color:var(--ink-dim); opacity:.8; margin-bottom:2px;
}
.t-meta{display:block; font-size:9.5px; margin-top:3px; text-transform:none; letter-spacing:0}
.t-body{font-size:13px; color:var(--ink-2); white-space:pre-wrap; word-break:break-word; min-width:0}
.t-user .t-body{color:var(--ink)}
.chips{margin-top:8px; display:flex; gap:6px; flex-wrap:wrap}
.tool{
  font-family:var(--mono); font-size:10px; color:var(--purple);
  border:1px solid color-mix(in srgb,var(--purple) 32%,transparent);
  background:color-mix(in srgb,var(--purple) 11%,transparent); border-radius:5px; padding:2px 7px;
}
/* click-to-reveal, never a download: the bytes are already the user's, the risk
   is amplifying them into a screenshare (ADR-0009 §8). */
.masked{background:var(--fail); color:transparent; border-radius:3px; cursor:pointer; opacity:.75; padding:0 3px}
.masked:hover,.masked.shown{color:#fff; opacity:1}
.masked.shown{background:transparent; box-shadow:inset 0 0 0 1px var(--fail); color:var(--ink)}
/* Same "content was withheld" family as .masked, deliberately quieter: masking
   is a security measure, truncation is a designed limit. An alarm colour here
   would teach the reader to distrust a turn that is merely long. */
.t-trunc{
  display:block; margin-top:3px; font-size:9px; line-height:1.35; text-transform:none; letter-spacing:0;
  color:var(--ink-dim); border:1px solid var(--line-2); border-radius:4px; padding:1px 4px;
  background:var(--panel-2); cursor:help;
}

@media(max-width:720px){
  /* Four data columns → five, because .srow above gained a LEADING one.
     .cat joins the hidden set at the same time, and that is a FIX, not a
     side-effect: the shipped rule declared four columns while the row still
     rendered five visible cells, so .cat sat in the cost column, $-figures sat
     in the 20px glyph column and were clipped, and the transcript glyph wrapped
     onto a line of its own. Five columns for five cells is what makes the
     arithmetic close. The category is still reachable — it is on the project
     header chips and on the Scorecard's category rows.
     .s-chips joins the hidden set for the same arithmetic reason: it is an
     ELEVENTH desktop column, and leaving it visible here would put six cells
     into five tracks. Nothing it carries is lost — the row's detail strip
     spells posture and rhythm out in full. */
  .srow{grid-template-columns:18px 58px 1fr 68px 20px}
  .srow .s-proj,.srow .s-when,.srow .s-dur,.srow .s-turns,.srow .s-tok,.srow .cat,.srow .s-chips{display:none}
  .phead{grid-template-columns:16px 1fr 58px 66px}
  .phead .pchips,.phead .p-h,.phead .p-tok{display:none}
}

/* rhythm/mode chart primitives (usage-rhythm.mjs) — a small, self-contained
   component family for the rhythm/mode panels: delta chips, sparklines, a
   latency histogram, a stacked-by-day bar, a two-slice donut, and ranked
   rows. Every numeric figure here carries .tnum (tabular-nums) explicitly,
   same spirit as .mono elsewhere in this file — inherited font-variant-numeric
   from body is not something a reader can see in the markup, so state it. */
.tnum{font-variant-numeric:tabular-nums}

/* delta chip */
.dchip{display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:600}
.dchip-arrow{font-style:normal}
.dchip[data-tone="good"]{color:var(--ok)}
.dchip[data-tone="bad"]{color:var(--fail)}
.dchip[data-tone="flat"]{color:var(--ink-dim)}

/* sparkline */
.spark{overflow:visible; vertical-align:middle}
.spark-line{fill:none; stroke:var(--ink-dim); stroke-width:1.6}
.spark-dot{fill:var(--accent)}

/* histogram — sequential single hue; a positioned element always paints
   above a non-positioned one regardless of DOM order (DOM order only breaks
   ties WITHIN the same paint layer), so .hist-bars must ALSO be positioned —
   not just come after .hist-markers in the markup — for it to paint over the
   dashed marker lines. With both positioned (z-index:auto), DOM order then
   correctly decides between them: markers first, bars second, so bars win.
   The marker's own label sits above the plot box instead, so it is never
   itself covered by a bar. */
.hist-plot{position:relative}
.hist-markers{position:absolute; inset:0; pointer-events:none}
.hist-marker{position:absolute; top:0; bottom:0}
.hist-marker-line{position:absolute; top:0; bottom:0; border-left:1px dashed var(--ink-dim)}
.hist-marker-lab{position:absolute; top:-14px; left:3px; font-style:normal; font-size:9px; font-weight:600; color:var(--ink-dim); white-space:nowrap}
.hist-bars{position:relative; display:flex; align-items:flex-end; gap:6px}
.hist-bar{flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:flex-end}
.hist-val{font-size:9.5px; color:var(--ink-2); margin-bottom:3px}
.hist-fill{display:block; width:100%; border-radius:4px 4px 0 0; background:var(--accent)}
.hist-labs{display:flex; gap:6px; margin-top:6px}
.hist-lab{flex:1; min-width:0; text-align:center; font-size:9.5px; color:var(--ink-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

/* stacked days — order is bottom-up; segments render in a column-reverse
   flex with a 2px gap, so the LAST key in order paints at the top of the
   stack. not-recorded/other are forced to --ink-dim in JS (never a series
   color), same "the uncategorized bucket is de-emphasis, not a hue" rule
   renderScoreCategories already applies to Unclassified above. */
.stackdays{display:flex; align-items:flex-end; gap:6px}
.sday-col{flex:1; min-width:0; display:flex; flex-direction:column; align-items:center}
.sday-bar{width:100%; display:flex; flex-direction:column-reverse; gap:2px}
.sday-seg{display:block; width:100%}
.sday-seg.top{border-radius:4px 4px 0 0}
.sday-lab{margin-top:6px; font-family:var(--mono); font-size:9.5px; color:var(--ink-dim)}

/* two-slice donut — a mask on the RING punches the hole; the center label is
   a sibling, not a descendant, of the masked element, so it is never itself
   clipped. Seams between slices are --line, not bare transparent, so a small
   gap reads as a deliberate seam rather than a rendering gap. */
.donut2-wrap{display:flex; align-items:center; gap:16px}
.donut2{position:relative; width:88px; height:88px; flex:none}
.donut2-ring{
  display:block; width:100%; height:100%; border-radius:50%;
  -webkit-mask:radial-gradient(farthest-side,transparent 61%,#000 62%);
  mask:radial-gradient(farthest-side,transparent 61%,#000 62%);
}
.donut2-center{
  position:absolute; inset:0; display:grid; place-items:center;
  font-style:normal; font-size:13px; font-weight:700; color:var(--ink); text-align:center;
}
.donut2-legend{display:flex; flex-direction:column; gap:8px}
.donut2-item{display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--ink-2)}
.donut2-item i{width:8px; height:8px; border-radius:2px; display:inline-block; flex:none}
.donut2-item b{color:var(--ink); font-weight:600}

/* ranked rows — the same label/track/value grammar as .mrow above, kept as
   its own small component so this file's chart primitives can evolve
   independently of the scorecard's magnitude rows. */
.rrows{display:flex; flex-direction:column; gap:7px}
.rrow{display:grid; grid-template-columns:minmax(90px,1.2fr) 2fr auto; gap:10px; align-items:center}
.rrow-label{font-size:12px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.rrow-track{height:7px; border-radius:4px; background:var(--panel-2); overflow:hidden}
.rrow-fill{display:block; height:100%; border-radius:4px; background:var(--accent)}
.rrow-fill.dim{background:var(--ink-dim)}
.rrow-val{font-size:12px; color:var(--ink); text-align:right}

/* rhythm panel — two histogram cards side by side */
.rhythm-grid{display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.rcard{min-width:0; border:1px solid var(--line); border-radius:var(--r-sm); background:var(--panel-2); padding:12px 14px 13px}
.rcard-h{display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:8px}
.rcard-t{font-size:12px; font-weight:600; color:var(--ink)}
.rcard-n{font-size:10.5px; color:var(--ink-dim)}
/* A marker's label is drawn ABOVE the plot box (top:-14px) so a tall bar can
   never cover it — which means the card has to reserve that strip, or the
   label is clipped by the card instead. Two markers close together would
   collide on one line, so the second sits a row higher; the reserved strip is
   tall enough for both. */
.rcard .hist{padding-top:30px}
.rcard .hist-marker+.hist-marker .hist-marker-lab{top:-27px}

/* how-you-run panel — the by-day posture chart beside the delegation donut.
   The side column holds one 88px ring and its legend, so the stack takes the
   larger share: a wider day chart is more days legible, where extra width in
   the side column would only be padding around a fixed-size ring. */
.howrun{display:grid; gap:18px; grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
.hr-block{min-width:0}
.hr-side{display:flex; flex-direction:column; gap:16px; min-width:0}
.hr-t{font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-dim); margin-bottom:10px}
/* Every chart in this panel carries a sentence saying what its buckets mean
   and what the de-emphasised bucket is holding — the charts split spend by
   things (posture, who drove) whose absence is itself a finding. */
.hr-note{margin:10px 0 0; font-size:11px; line-height:1.5; color:var(--ink-dim)}
.hr-note b{color:var(--ink-2); font-weight:600}
@media(max-width:820px){ .howrun{grid-template-columns:1fr} }

/* reliability strip — a failure rate is a claim about the whole window, so it
   is stated as a figure with its own denominator beside it, not as a gauge. */
.rel{display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.rel-stat{min-width:0; border:1px solid var(--line); border-radius:var(--r-sm); background:var(--panel-2); padding:12px 14px}
.rel-k{display:block; font-size:10px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--ink-dim)}
.rel-v{display:block; font-size:23px; font-weight:700; letter-spacing:-.02em; color:var(--ink); margin-top:5px}
.rel-sub{display:block; font-size:11px; color:var(--ink-2); margin-top:4px}
/* Direction is carried by the glyph and the wording as well as the color: a
   reader who cannot separate --warn from --ok still gets the whole finding. */
.rel-flag{display:inline-flex; align-items:center; gap:5px; margin-top:9px; font-size:11px; font-weight:600}
.rel-flag i{font-style:normal}
.rel-flag[data-sev="warn"]{color:var(--warn)}
.rel-flag[data-sev="ok"]{color:var(--ok)}
.rel-flag[data-sev="flat"]{color:var(--ink-dim)}
/* The per-day exceptions line sits below the two stat cards at full strip
   width, not inside the .rel grid — a third auto-fit cell would have squeezed
   it to a third of the row, which is not enough horizontal room for one point
   per day to read as a shape. max-width keeps it from stretching thin on a
   wide window; the line never scales, so its stroke stays 1.6px everywhere. */
.rel-trend{margin-top:14px}
.rel-trend .spark{display:block; max-width:100%}
.rel-trend .rel-flag{margin-top:2px}

/* limits pace tick — where the window's own clock is, so a meter reads as
   "ahead of pace" or "behind" rather than only as a level. Scoped to .lim so
   the same .mbar the scorecard's magnitude rows use is untouched: the track
   joins the positioned layer only here, and only here does it stop clipping,
   which lets the tick stand 3px proud of a 7px bar instead of being lost
   inside it. The fill already carries its own radius, so nothing else changes.
   The tick overrides .mbar i's block/height/background by carrying a class
   (0,2,1 beats 0,1,1). */
/* A pool label — "GPT-5.3-Codex-Spark · weekly" — needs ~183px, where the
   shared magnitude grid gives 137px and ellipsises the rest. Two rows both
   truncating to something plausible is how one pool reported under two lanes
   went unnoticed, so the limits label column is widened to fit: measured
   1000-1600px, the full string fits with no row overflow. The cap is a MAX,
   not a min — each .mrow is its own grid, so a content-sized track would let
   every row start its meter at a different x and the panel would stop reading
   as a stack of comparable bars. A fixed cap that yields under pressure keeps
   them aligned; below ~950px the ellipsis returns and limRow's title carries
   the full text. */
.lim .mrow{grid-template-columns:minmax(0,190px) minmax(60px,0.9fr) 54px minmax(88px,auto)}
.lim .mbar{position:relative; overflow:visible}
.lim .mbar i.pace{
  position:absolute; top:-3px; bottom:-3px; left:0; width:2px; height:auto;
  border-radius:1px; background:var(--ink-2); transform:translateX(-1px);
}
.lim .legend .pace-key{width:2px; height:11px; border-radius:1px; background:var(--ink-2)}

/* ── Prompts view (METRICS.md §21) ──────────────────────────────────────────
   Reuses the scorecard's own grammar wherever one exists — .kpi for the strip,
   .mbar for magnitude, .strip/.sh for section chrome — so a panel here is the
   same object a reader already knows from Scorecard. Only the shapes with no
   existing equivalent are new: the per-host interplay row, the patterns table,
   and the two "not built yet" placeholders.
   Every colour is a token; nothing below hardcodes a hue, so the view follows
   the viewer's theme with the rest of the panel. */

/* Per-host tap chips inside a KPI's detail line. The tone says how the host
   compares to its OWN trailing baseline, and the italic tail always names what
   it was compared against — a chip that only carried a colour would be a
   judgement with its evidence stripped off.
   One chip per LINE rather than an inline run: "codex 17% your p75 12%" is
   three facts, and inside a ~200px KPI card an inline chip wrapped mid-phrase
   into a 2x2 block where "no baseline" and "yet" landed on separate rows. As a
   full-width row the host and its share sit left, the comparison right, and the
   phrase can no longer break between its own words. */
.pr-chip{
  display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  margin:4px 0 0; padding:2px 7px; border-radius:6px; background:var(--panel-2);
  font-family:var(--mono); font-size:10.5px; white-space:nowrap;
}
.pr-chip i{font-style:normal; color:var(--ink-dim); overflow:hidden; text-overflow:ellipsis}
.pr-chip[data-tone="good"]{color:var(--ok)}
.pr-chip[data-tone="bad"]{color:var(--warn)}
.pr-chip[data-tone="flat"]{color:var(--ink-2)}

/* host interplay — one row per host, each carrying its trend, its p90 length
   and its persona count. auto-fit rather than a fixed column count: two hosts
   is the common case, but a machine with one (or four) must not leave a hole
   or overflow the strip. */
.pr-hosts{display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.pr-host{background:var(--panel-2); border-radius:var(--r-sm); padding:13px 14px}
.pr-host-name{
  display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  font-size:13px; font-weight:600; margin-bottom:9px;
}
.pr-host-n{font-size:10.5px; font-weight:400; color:var(--ink-dim)}
.pr-host-trend,.pr-host-len{display:flex; align-items:center; gap:10px; margin-bottom:8px}
/* The meter STRETCHES and the sparkline does NOT. sparklineSvg emits width/
   height attributes with no viewBox, so its path coordinates are pixels, not a
   scalable space: growing the element widens the box and leaves the line
   drawn at its original size inside a field of empty pixels. Letting it keep
   its natural width and pushing the label away with auto margin puts the line
   where the reader looks first, with no dead gap in front of it. */
.pr-host-len .mbar{flex:1 1 auto; min-width:0; height:8px}
.pr-host-trend .spark{flex:none}
.pr-host-trend .pr-host-lab,.pr-host-trend .pr-none{margin-left:auto}
.pr-host-lab{flex:none; font-size:10.5px; color:var(--ink-2)}
.pr-host-persona{font-size:11.5px; color:var(--ink-2); padding-top:2px}
.pr-host-persona b{color:var(--ink)}
.pr-none{color:var(--ink-dim); font-size:11px; font-style:italic}
.pr-caveat{
  margin-top:12px; padding-top:10px; border-top:1px dashed var(--line);
  font-size:11.5px; color:var(--ink-2);
}
.pr-caveat b{color:var(--ink)}

/* patterns table. Scrolls inside its own region rather than widening the page:
   seven columns do not fit a narrow window, and a horizontally scrolling BODY
   would take the whole dashboard with it. */
.pr-tablewrap{overflow-x:auto}
.pr-tablewrap:focus-visible{outline:2px solid var(--accent); outline-offset:2px; border-radius:8px}
.pr-table{border-collapse:collapse; width:100%; font-size:12.5px}
.pr-table th[scope=col]{
  text-align:left; font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:.08em;
  text-transform:uppercase; color:var(--ink-dim); padding:7px 10px; border-bottom:1px solid var(--line-2);
  white-space:nowrap;
}
.pr-table td,.pr-table th[scope=row]{
  padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; text-align:left;
  font-weight:400;
}
.pr-table tr:last-child td,.pr-table tr:last-child th[scope=row]{border-bottom:0}
.pr-table td.tnum{font-variant-numeric:tabular-nums; white-space:nowrap}
.pr-name{display:block; color:var(--ink)}
/* The label's provenance rides under the name at all times: "characterized"
   means the vocabulary could not name this cluster and the row is showing a
   generic descriptor, which a reader must be able to tell from a curated name
   at a glance. */
.pr-src{display:block; font-size:10px; color:var(--ink-dim); margin-top:2px}
.pr-hostchip{
  display:inline-block; margin:0 4px 2px 0; padding:1px 6px; border-radius:5px;
  background:var(--panel-2); font-family:var(--mono); font-size:10px; color:var(--ink-2);
}
.pr-move{
  display:inline-block; padding:2.5px 8px; border-radius:6px; white-space:nowrap;
  font-family:var(--mono); font-size:10.5px; font-weight:600;
}
.pr-move[data-kind="skill"]{background:var(--ok-soft); color:var(--ok)}
.pr-move[data-kind="instr"]{background:var(--accent-soft); color:var(--accent)}
.pr-move[data-kind="gap"]{background:color-mix(in srgb,var(--warn) 15%,transparent); color:var(--warn)}
.pr-move[data-kind="none"]{background:var(--panel-2); color:var(--ink-dim); font-weight:400}
.pr-sess{
  display:inline-block; margin-right:5px; font-family:var(--mono); font-size:11px;
  color:var(--accent); text-decoration:none;
}
.pr-sess:hover{text-decoration:underline}
.pr-more{font-size:10.5px; color:var(--ink-dim)}

/* A sub-heading inside a strip column, for a second ranked list under the
   first. Sized between .sh h2 and body text so it reads as subordinate to the
   strip's own title rather than competing with it. */
.pr-sub{
  margin:18px 0 8px; font-size:12px; font-weight:600; letter-spacing:.04em;
  text-transform:uppercase; color:var(--ink-dim);
}

/* class chip in the patterns table. An UNCLASSIFIED cluster is deliberately
   quiet: it carries no suggested move either, and the two must look like the
   same absence rather than one looking like a category. */
.pr-cat{
  display:inline-block; padding:1.5px 7px; border-radius:5px; white-space:nowrap;
  background:var(--panel-2); color:var(--ink-dim); font-family:var(--mono); font-size:10px;
}
.pr-cat[data-on="1"]{color:var(--ink-2)}

/* What the table is not showing. Sits under the table at full width, in body
   ink rather than de-emphasis ink: a reader who misses this line misreads the
   panel, so it is not a footnote. */
.pr-more-note{
  margin-top:12px; padding-top:10px; border-top:1px solid var(--line);
  font-size:12px; color:var(--ink-2);
}
.pr-more-note b{color:var(--ink)}

/* re-ask summary, above the patterns table */
.pr-reask{margin-bottom:14px; font-size:12.5px; color:var(--ink-2)}
.pr-reask b{color:var(--ink)}

/* exact repeats — the identical-text tail under the loose-cluster table */
.pr-exact{margin-top:18px; padding-top:14px; border-top:1px dashed var(--line)}
.pr-exact h4{margin:0 0 9px; font-size:12px; font-weight:600; letter-spacing:.04em;
  text-transform:uppercase; color:var(--ink-dim)}
.pr-exact-rows{display:flex; flex-wrap:wrap; gap:8px}
.pr-exact-row{
  background:var(--panel-2); border-radius:var(--r-sm); padding:6px 10px; font-size:12px;
  color:var(--ink-2);
}
.pr-exact-row b{color:var(--ink); font-family:var(--mono); font-size:11.5px}
.pr-exact-row i{font-style:normal; color:var(--ink-dim); font-size:11px}
.pr-exact-note{margin:10px 0 0; font-size:11.5px; color:var(--ink-dim)}
.pr-exact-note code{font-family:var(--mono); font-size:11px; color:var(--ink-2)}

/* "not built yet" panels. Deliberately quiet and deliberately NOT card-shaped:
   a dashed, unfilled block reads as a gap in the design, where a filled card
   would read as content that failed to load. */
.pr-pending{
  border:1px dashed var(--line-2); border-radius:var(--r-sm); padding:14px 16px;
  background:transparent;
}
.pr-pending h4{margin:0 0 7px; font-size:13px; font-weight:600; color:var(--ink-2)}
.pr-pending p{margin:0 0 8px; font-size:12.5px; color:var(--ink-2); line-height:1.55}
.pr-pending p:last-child{margin-bottom:0}
.pr-pending b{color:var(--ink)}
.pr-pending-note{color:var(--ink-dim) !important; font-size:11.5px !important}

/* Coaching cards (METRICS.md §22). One card per finding — the same visual
   weight as a .kpi tile, not a table row, because a card carries a Try and a
   basis a row has no place for. */
.pr-cards{display:flex; flex-direction:column; gap:12px; margin-bottom:12px}
.pr-card{
  background:var(--panel-2); border-radius:var(--r-sm); padding:13px 14px;
  border-left:3px solid var(--line-2);
}
.pr-card[data-status="adopted"]{border-left-color:var(--ok)}
.pr-card[data-status="retired"]{border-left-color:var(--warn)}
.pr-card[data-status="dismissed"],.pr-card[data-status="expired"]{opacity:.62}
.pr-card-head{display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap}
.pr-card-head h4{margin:0; font-size:13.5px; font-weight:600; color:var(--ink)}
.pr-card-status{
  flex:none; font-size:10.5px; font-weight:600; letter-spacing:.03em; color:var(--ink-2);
  text-transform:uppercase;
}
.pr-card-status[data-status="adopted"]{color:var(--ok)}
.pr-card-status[data-status="retired"]{color:var(--warn); text-transform:none; font-weight:400}
/* F-9: every card names its own source, unconditionally. Deliberately quieter
   than the status chip — this is provenance, not state, and it must be
   readable without competing with the verdict beside it. */
.pr-card-source{
  flex:none; padding:1px 6px; border:1px solid var(--line); border-radius:9px;
  font-size:10px; font-weight:600; letter-spacing:.03em; color:var(--ink-dim);
}
.pr-card-source[data-source="enriched"]{color:var(--ink-2); border-color:var(--line-2)}
.pr-card-finding{margin:7px 0 0; font-size:12.5px; color:var(--ink-2); line-height:1.5}
.pr-card-try{margin:7px 0 0; font-size:12.5px; color:var(--ink)}
.pr-card-try b{font-weight:600}
.pr-card-basis{margin:5px 0 0; font-size:11.5px; color:var(--ink-dim)}
.pr-card-draft{margin-top:10px}
.pr-card-draft-hint{margin:0 0 4px; font-size:10.5px; color:var(--ink-dim); text-transform:uppercase; letter-spacing:.04em}
.pr-card-draft-pre{
  margin:0; padding:9px 11px; background:var(--panel); border:1px solid var(--line);
  border-radius:var(--r-sm); font-family:var(--mono); font-size:11.5px; color:var(--ink-2);
  white-space:pre-wrap; word-break:break-word; max-height:220px; overflow-y:auto; cursor:text;
}
.pr-card-dismiss-hint{margin:8px 0 0; font-size:11px; color:var(--ink-dim)}
.pr-card-dismiss-hint code{font-family:var(--mono); font-size:10.5px; color:var(--ink-2)}
.pr-card-asof{margin:8px 0 0; font-size:10px; color:var(--ink-dim)}
.pr-card-ledger{margin:2px 0 0; font-size:11px; color:var(--ink-dim)}

`;
