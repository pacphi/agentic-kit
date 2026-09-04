export const SYSTEM_CSS = `
/* ── System area (ADR-0025) ──────────────────────────────────────────────────
   sy-prefixed for the same collision reason. A 12-column grid so each card can
   declare the width its chart form actually needs; charts are inline SVG built
   from the payload, never an image and never a remote asset. */
.sy-grid{display:grid; grid-template-columns:repeat(12,1fr); gap:10px}
/* Card chrome is deliberately tight. A System view is a dense band of facts —
   padding and inter-row gap that would flatter one hero chart is, across five
   stacked cards, most of a screen spent on framing rather than measurement. */
.sy-card{
  grid-column:span 12; display:flex; flex-direction:column; gap:8px; min-width:0;
  background:var(--panel); border:1px solid var(--line); border-radius:var(--r);
  padding:13px 15px; box-shadow:var(--shadow);
}
.sy-3{grid-column:span 3}.sy-4{grid-column:span 4}.sy-5{grid-column:span 5}
.sy-6{grid-column:span 6}.sy-7{grid-column:span 7}.sy-8{grid-column:span 8}
@media(max-width:900px){.sy-3,.sy-4,.sy-5{grid-column:span 6}.sy-6,.sy-7,.sy-8{grid-column:span 12}}
@media(max-width:600px){.sy-3,.sy-4,.sy-5{grid-column:span 12}}
.sy-head{display:flex; align-items:baseline; justify-content:space-between; gap:8px}
.sy-head h3{margin:0; font-size:13px; font-weight:650; letter-spacing:-.008em}
.sy-legend{display:flex; gap:12px; flex-wrap:wrap; font-size:11.5px; color:var(--ink-2)}
.sy-legend i{display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:5px; vertical-align:-1px}
.sy-legend b{color:var(--ink); font-weight:600}
/* Unknown is a first-class rendering, not an empty cell: it says so, and the
   reason rides the title so a reader can find out why without leaving. */
.sy-unk{color:var(--ink-dim); font-style:italic; cursor:help}
.sy-approx{color:var(--ink-dim)}
#secondary-system{flex-wrap:wrap}
#secondary-system>.subseg{flex:1 1 auto;min-width:0}
.sy-freshness{display:flex; align-items:center; flex-wrap:wrap; gap:9px; max-width:100%; font-size:12px; color:var(--ink-2)}
.sy-freshness[data-running="1"]{
  flex:1 0 100%;width:100%;margin-left:0;justify-content:flex-end;min-width:0;
  padding-top:2px
}
.sy-freshness[data-running="1"] .sy-asof{
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap
}
@media(max-width:720px){
  .sy-freshness{flex:1 0 100%;width:100%;margin-left:0;justify-content:flex-start}
  .sy-freshness[data-running="1"] .sy-asof{white-space:normal}
}
.sy-asof{font-family:var(--mono); font-size:11.5px}
.sy-asof[data-stale="1"]{color:var(--warn)}
.sy-scan{color:var(--accent)}
/* KPI band + odometer readout. Dimensions are Usage's .kpi rhythm EXACTLY —
   15px 16px of padding and a 27px value — not a second scale: the two bands are
   one click apart, and a System tile that towers over a Scorecard tile reads as
   a different, more important kind of fact than it is. OD_H in client.mjs must
   equal the odometer height below — the digit stack is translated by whole rows,
   so a mismatch shows two half digits. */
.sy-kpis{grid-column:span 12; display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
.sy-kpi{background:var(--panel); border:1px solid var(--line); border-radius:var(--r); padding:15px 16px; box-shadow:var(--shadow)}
.sy-kpi .lbl{font-size:10.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-dim)}
.sy-kpi .val{display:flex; align-items:baseline; gap:5px; margin-top:5px; min-height:30px; flex-wrap:wrap}
.sy-kpi .unit{font-size:12px; color:var(--ink-2)}
/* One fact per line, so a caption never wraps mid-separator. The tiles are grid
   items and already share a height, so stacking costs nothing a dot-joined line
   that wrapped was not already costing. */
.sy-kpi .sub{display:flex; flex-direction:column; gap:1px; font-size:11.5px; color:var(--ink-2); margin-top:6px}
.sy-kpi .sub-l{white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.od{display:inline-flex; overflow:hidden; height:30px; font-family:var(--mono); font-variant-numeric:tabular-nums}
.od .dcol{display:inline-block; height:30px; overflow:hidden}
.od .dstack{display:flex; flex-direction:column; transition:transform 1.1s cubic-bezier(.2,.7,.2,1)}
.od .dstack span{height:30px; line-height:30px; font-size:27px; font-weight:700; letter-spacing:-.028em; text-align:center; min-width:.62em}
.od .lit{font-size:27px; font-weight:700; line-height:30px; letter-spacing:-.028em}
/* Liner note: what a panel counted and how, in the muted voice the genuine
   caveats already use. It qualifies the DATA — a figure whose accounting
   changed cannot be read correctly without it, which is why it renders next to
   the number rather than in a doc. */
.sy-liner{font-size:11.5px; color:var(--ink-dim); line-height:1.55}
.sy-liner b{color:var(--ink-2); font-weight:600}
/* A grid-level liner is two lines of dense accounting prose sitting between the
   KPI band above and the disk strip below. It was pulled UP by a negative
   margin, which left 5px between it and the cards it qualifies and made the
   whole region read as one undifferentiated block. Give it room on both sides:
   at this density the separation is what makes it legible as a footnote rather
   than as more numbers. */
.sy-grid > .sy-liner{grid-column:span 12; margin:6px 0 8px; max-width:120ch}
/* Disk denominator as a horizontal meter. The radial spent a full card's height
   stating one ratio; the band states the same ratio plus its parts in one line.
   It also drops the card chrome entirely — a panel, a border and a shadow around
   a single line of text is 20px of container spent framing 18px of content, and
   the Summary is meant to read as a dense band of facts rather than a stack of
   tall cards. It keeps its own hairline rules so it still reads as a strip. */
.sy-band{
  background:none; border:0; border-radius:0; box-shadow:none;
  border-top:1px solid var(--line); border-bottom:1px solid var(--line);
  padding:13px 2px; gap:0;
}
.sy-diskband{display:flex; align-items:center; gap:13px; flex-wrap:wrap}
.sy-diskband .dk-lbl{
  flex:none; font-size:10.5px; font-weight:600; letter-spacing:.09em;
  text-transform:uppercase; color:var(--ink-dim);
}
.sy-diskband .dk-meter{
  flex:1 1 200px; min-width:140px; height:12px; border-radius:100px;
  background:var(--panel-2); overflow:hidden; display:flex;
}
.sy-diskband .dk-meter i{height:100%; min-width:2px}
/* Wraps to its own line rather than forcing the band wider than the viewport:
   a facts string that cannot shrink is how a panel makes the whole page scroll
   sideways on a phone. */
.sy-diskband .dk-facts{flex:1 1 auto; min-width:0; font-size:12px; color:var(--ink-2)}
.sy-diskband .dk-facts b{color:var(--ink); font-family:var(--mono); font-weight:700}
/* Consumers: twenty ranked rows in a scroller. About four were visible, which
   is too few to read as a ranking — you compared the top of the list against
   nothing. Sized for 8-10 rows in the denser "by ecosystem" mode, where every
   row also carries a note (~40px a pair against ~25px for a bare ranked row).
   Still bounded, and the scroll still belongs to this container: the page body
   must never scroll sideways or grow a screen-tall list to state a ranking. */
.sy-ctl{display:flex; gap:6px; flex-wrap:wrap}
.sy-scroll{
  max-height:min(46vh,400px); overflow-y:auto; overflow-x:hidden;
  overscroll-behavior:contain; padding-right:4px;
}
.sy-crow{
  display:grid; grid-template-columns:minmax(110px,200px) 1fr 96px; gap:10px;
  align-items:center; font-size:12.5px; padding:3px 0;
}
.sy-crow .n{color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.sy-crow .g{color:var(--ink-dim); font-size:10.5px; margin-left:6px}
.sy-crow .sy-track{height:11px}
.sy-crow .v{text-align:right; font-family:var(--mono); font-size:11.5px; color:var(--ink)}
.sy-cnote{font-size:11px; color:var(--ink-dim); line-height:1.4; margin:0 0 5px 96px}
@media(max-width:600px){
  .sy-crow{grid-template-columns:1fr 84px}
  .sy-crow .n{grid-column:1/-1}
  .sy-cnote{margin-left:0}
}
/* Horizontal magnitude bars (ranked + stacked) */
.sy-bars{display:flex; flex-direction:column; gap:8px}
.sy-bar{display:grid; grid-template-columns:minmax(96px,150px) 1fr 78px; gap:10px; align-items:center; font-size:12.5px}
.sy-bar .n{color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.sy-track{height:14px; border-radius:4px; background:var(--panel-2); overflow:hidden; display:flex; gap:2px}
.sy-track.tall{height:18px}
.sy-fill{height:100%; border-radius:4px; min-width:3px}
.sy-bar .v{text-align:right; font-family:var(--mono); font-size:11.5px; color:var(--ink)}
@media(max-width:600px){.sy-bar{grid-template-columns:1fr 64px} .sy-bar .n{grid-column:1/-1}}
/* Tables */
.sy-tblwrap{overflow-x:auto}
/* Sortable headers. The whole header is the button, so the target is the width
   of the column rather than the glyph. The arrow is always present — a control
   that only appears on hover is invisible to anyone who never hovers, and a
   column that shifts width when you point at it is worse than no affordance.
   Inactive arrows sit at low opacity; the active one takes the accent, which is
   how "only one column at a time" reads without a legend. */
.sy-sortable th{padding:0}
.sy-sort{
  display:flex; align-items:center; gap:5px; width:100%;
  background:none; border:0; padding:6px 8px; cursor:pointer;
  font:inherit; color:var(--ink-dim); font-weight:600; text-align:inherit;
  letter-spacing:inherit; text-transform:inherit; white-space:nowrap;
}
.sy-sortable th[style*="right"] .sy-sort{justify-content:flex-end}
.sy-sort:hover{color:var(--ink-2)}
.sy-sort:focus-visible{outline:2px solid var(--accent); outline-offset:-2px; border-radius:4px}
.sy-sort .sy-arrow{font-size:9px; opacity:.28; line-height:1}
.sy-sort:hover .sy-arrow{opacity:.6}
.sy-sort.on{color:var(--accent)}
.sy-sort.on .sy-arrow{opacity:1; color:var(--accent)}
/* A liner directly after a table needs real separation, and a SCROLLING table
   needs more of it: its last row is clipped mid-glyph by design, so a caption
   sitting flush underneath reads as another clipped row rather than as the
   footnote it is. */
.sy-tblwrap + .sy-liner{margin-top:10px}
.sy-catalog-scroll + .sy-liner,
.sy-reclaim-scroll + .sy-liner{margin-top:14px; padding-top:2px}
.sy-table{border-collapse:collapse; width:100%; font-size:12.5px}
.sy-table th{
  color:var(--ink-dim); font-weight:600; text-align:left; padding:6px 8px; white-space:nowrap;
  border-bottom:1px solid var(--line-2); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em;
}
.sy-table td{padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:middle; color:var(--ink-2)}
.sy-table tr:last-child td{border-bottom:0}
.sy-table td.num{text-align:right; white-space:nowrap; font-family:var(--mono); color:var(--ink)}
.sy-table a{color:var(--accent); text-decoration:none; font-weight:600}
.sy-table a:hover,.sy-table a:focus-visible{text-decoration:underline}
.sy-sub{font-family:var(--mono); font-size:10.5px; color:var(--ink-dim); margin-top:2px}
/* Stack chips: frameworks, SDKs and tools are PRESENCE facts, so they get a
   shape with no length to misread as a quantity. The kinds differ by weight of
   outline, not by hue — three more hues here would compete with the four-step
   data series next to them for no gain in meaning. */
.sy-chips{display:flex; flex-wrap:wrap; gap:4px; margin-top:5px}
.sy-chip{
  font-size:10.5px; line-height:1.5; border-radius:100px; padding:1px 7px;
  border:1px solid var(--line-2); color:var(--ink-2); background:var(--panel-2);
  white-space:nowrap; cursor:help;
}
/* A weight ladder, not three hues: framework reads strongest, tool faintest.
   Accent is this page's ACTION colour — six accent chips per project row would
   read as six buttons, and they would out-shout the data bars beside them. */
.sy-chip[data-kind="framework"]{border-color:var(--line-2); color:var(--ink); background:var(--panel-2)}
.sy-chip[data-kind="sdk"]{border-color:var(--line-2); color:var(--ink-2); background:transparent}
.sy-chip[data-kind="tool"]{border-style:dashed; background:transparent; color:var(--ink-dim)}
/* The unrecognized tail: a named to-do list, so each chip carries its count. */
.sy-chip[data-kind="ext"]{font-family:var(--mono); background:transparent}
.sy-chip[data-kind="dep"]{font-family:var(--mono); background:transparent; border-style:dashed}
.sy-chip b{color:var(--ink-dim); font-weight:600; margin-left:5px}
.sy-chip.more{border-style:dashed; color:var(--ink-dim)}
.sy-subhead{font-size:10.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-dim); margin-top:10px}
/* Language names under the stacked bar — identity in text, magnitude in the bar. */
.sy-langs{font-size:10.5px; color:var(--ink-dim); margin-top:3px; max-width:210px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:help}
.sy-inbar{height:9px; border-radius:3px; background:var(--panel-2); min-width:80px; display:flex; gap:2px; overflow:hidden}
.sy-rss{display:flex; gap:8px; align-items:center}
.sy-dot{display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px}
/* Meter, stat tiles, advisory rows, presence matrix */
/* The meter sits between the figure it measures and the denominator that
   explains it, and had zero margin on both — 10px of bar wedged flush against
   two lines of type. Slightly more room above than below, so it stays visually
   attached to the caption that gives it its scale. */
.sy-meter{height:10px; border-radius:100px; background:var(--panel-2); overflow:hidden; margin:10px 0 7px}
.sy-meter > i{display:block; height:100%; border-radius:100px; background:var(--accent)}
.sy-tiles{display:flex; gap:10px; flex-wrap:wrap}
.sy-tile{flex:1; min-width:92px; background:var(--panel-2); border-radius:var(--r-sm); padding:10px 12px}
.sy-tile .t-v{font-family:var(--mono); font-size:20px; font-weight:700; color:var(--ink)}
.sy-tile .t-l{font-size:11px; color:var(--ink-2); margin-top:2px}
/* Reclaimables — two safety tiers, deliberately NOT one list.
   'regenerable' is space the owning tool rebuilds by itself, so its rows lead
   with the byte count in a pill. 'review' is a pointer at something to look at:
   its rows lead with the WORD, and their bytes render as muted context text.
   That difference is the whole point — the pill is the visual grammar of "this
   much is yours to take back", and putting it on a row that may be in use would
   claim something the measurement does not support. Neither tier has, or may
   ever have, a delete affordance (ADR-0025 §6). */
/* Scrollable, but generous: the ~2-row cap was right when this sat under the
   byte charts and the cost of it was scrolling PAST the advisory to reach the
   next panel. On its own tab there is nothing to scroll past, and a two-row
   window on a nine-row advisory is just a smaller advisory. */
.sy-reclaim-scroll{max-height:min(62vh,620px); overflow-y:auto}
.sy-table .tag{
  display:inline-block; white-space:nowrap;
  font-size:9.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  border-radius:100px; padding:2px 8px;
}
.sy-table .tag.regen{color:var(--ok); background:var(--ok-soft)}
.sy-table .tag.review{color:var(--ink-2); background:transparent; border:1px dashed var(--line-2)}
.sy-adv-t{max-width:46ch}
.sy-adv-t b{color:var(--ink); font-weight:600}
.sy-adv-t .why{color:var(--ink-dim); font-size:11.5px; line-height:1.45}
/* The remediation line. Separated from the rationale above it because it
   answers a different question — not "what is this" but "what would you run" —
   and read as one more clause of the description when it sat flush against it. */
.sy-adv-fix{margin-top:9px; font-size:11.5px; line-height:1.45; color:var(--ink-2)}
.sy-adv-fix .mono{color:var(--ink)}
/* The status totals line above the table. */
#sys-reclaim-note b{color:var(--ink); font-family:var(--mono); font-weight:700}
#sys-reclaim-note .g{color:var(--ink-dim); font-size:11px}
#sys-reclaim-note .why{color:var(--ink-dim); font-size:11.5px; line-height:1.45; margin-top:3px}
.sy-path{font-family:var(--mono); font-size:11px; color:var(--ink-dim); word-break:break-all; margin-top:2px}
/* A session id that opens its transcript. A real <button>, because it performs
   an in-page action rather than navigating — but styled as the link it reads
   as, so the affordance is visible without a second visual vocabulary. */
.sy-link{
  background:none; border:0; padding:0; font:inherit; color:var(--accent);
  cursor:pointer; text-align:left; border-radius:3px;
}
.sy-link:hover{text-decoration:underline}
.sy-link:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
/* The presence matrix is a real table and retains EVERY deduplicated item, but
   its viewport is deliberately one header plus no more than five records. The
   44px minimum accounts for the name and source lines; a wrapped record may
   make fewer than five visible, never more. The sticky header keeps the host
   columns meaningful while the remaining inventory scrolls beneath it. */
.sy-catalog-scroll{max-height:280px; overflow-y:auto}
.sy-catalog-scroll tbody tr{height:44px}
.sy-catalog-scroll thead th{position:sticky; top:0; background:var(--panel); z-index:1}
.sy-matrix-t .nm{font-family:var(--mono); font-size:11.5px; color:var(--ink); word-break:break-all}
.sy-catmeta{margin-top:3px; font-family:var(--sans); font-size:10px; color:var(--ink-dim)}
.sy-matrix-t .cell{text-align:center; width:74px}
.sy-matrix-t th.cell{text-transform:uppercase; letter-spacing:.04em}
.sy-matrix-t .on{display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--accent)}
.sy-matrix-t .off{display:inline-block; width:9px; height:9px; border-radius:50%; border:1.5px solid var(--line-2)}
/* Two stacked pick lists above the table. A label per row rather than a legend,
   because "show" and "carried by" are different questions and an unlabelled
   second row of chips reads as more of the first. */
.sy-filters{display:flex; flex-direction:column; gap:6px; margin:10px 0 12px}
.sy-filter-row{display:flex; align-items:center; gap:9px; flex-wrap:wrap}
.sy-filter-l{
  color:var(--ink-dim); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em;
  min-width:66px; flex:none;
}
/* The kind now rides on its row, since the heading rows that used to carry it
   are gone and a filtered list must never leave a name unexplained. */
.sy-kindtag{
  margin-left:8px; font-family:var(--sans); font-size:9.5px; color:var(--ink-dim);
  text-transform:uppercase; letter-spacing:.05em;
}
.sy-pressure-overview{display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-bottom:10px}
.sy-pressure-overview span{padding:10px 12px; border:1px solid var(--line); border-radius:9px; color:var(--ink-dim); font-size:11px}
.sy-pressure-overview b{display:block; color:var(--ink); font-family:var(--mono); font-size:18px; line-height:1.2; margin-bottom:2px}
.sy-pressure-context,.sy-pressure-foot{color:var(--ink-dim); font-size:11.5px; line-height:1.5}
.sy-pressure-context{padding:9px 11px; border-left:2px solid var(--s1); background:color-mix(in srgb,var(--s1) 7%,transparent); margin-bottom:10px}
.sy-pressure-context b,.sy-pressure-foot b{color:var(--ink-2)}
.sy-pressure-list{max-height:520px; overflow:auto; display:flex; flex-direction:column; gap:6px; padding:1px}
.sy-pressure-list:focus-visible,.sy-pressure-project>summary:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.sy-pressure-project{border:1px solid var(--line); border-radius:9px; background:color-mix(in srgb,var(--panel) 92%,var(--ink) 8%)}
.sy-pressure-project>summary{position:relative; display:grid; grid-template-columns:minmax(180px,.8fr) minmax(0,2fr); gap:12px; align-items:center; min-height:48px; padding:10px 34px 10px 13px; cursor:pointer; list-style:none}
.sy-pressure-project>summary::-webkit-details-marker{display:none}
.sy-pressure-project>summary::after{content:'›'; position:absolute; right:14px; top:50%; color:var(--ink-dim); font-size:20px; transform:translateY(-50%); transition:transform .15s ease}
.sy-pressure-project[open]>summary::after{transform:translateY(-50%) rotate(90deg)}
.sy-pressure-project[open]>summary{border-bottom:1px solid var(--line)}
.sy-pressure-project-id{display:flex; flex-direction:column; min-width:0; gap:3px}
.sy-pressure-project-id>span:first-child{display:flex; align-items:center; gap:7px; min-width:0}
.sy-pressure-project-id b{color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.sy-pressure-path{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-dim); font-family:var(--mono); font-size:10.5px}
.sy-pressure-meta{display:flex; justify-content:flex-end; align-items:center; gap:6px; flex-wrap:wrap}
.sy-pressure-chip,.sy-pressure-state{padding:3px 7px; border:1px solid var(--line); border-radius:999px; color:var(--ink-2); font-size:10.5px; white-space:nowrap}
.sy-pressure-chip b{color:var(--ink); font-weight:600}
.sy-pressure-detail{padding:11px 13px 13px}
.sy-pressure-detail>.sy-path{margin-bottom:9px; word-break:break-word}
.sy-pressure-t{min-width:720px}
.sy-pressure-t th,.sy-pressure-t td{vertical-align:top; font-size:11.5px; line-height:1.4}
.sy-pressure-t tbody th{color:var(--ink-2); font-weight:500}
.sy-pressure-n{color:var(--ink)}
.sy-pressure-reason{display:block; max-width:170px; margin-top:2px; color:var(--ink-dim); font-size:9.5px; line-height:1.35}
.sy-pressure-action{display:grid; grid-template-columns:auto minmax(0,1fr); gap:12px; align-items:center; padding-top:10px}
.sy-pressure-action>span{display:flex; flex-direction:column; color:var(--ink-2); white-space:nowrap}
.sy-pressure-action small{color:var(--ink-dim); font-size:10px}
.sy-pressure-command{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:stretch;min-width:0;border-radius:6px;background:var(--bg);overflow:hidden}
.sy-pressure-command code{display:block;min-width:0;padding:7px 9px;color:var(--accent);overflow:auto;white-space:nowrap}
.sy-copy-command{display:inline-flex;align-items:center;justify-content:center;width:34px;padding:5px;border:0;border-left:1px solid var(--line);background:transparent;color:var(--ink-2);cursor:pointer}
.sy-copy-command:hover{color:var(--accent);background:var(--accent-soft)}
.sy-copy-command:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}
.sy-copy-command[data-copy-busy="1"]{cursor:wait;opacity:.7}
.sy-copy-command svg{width:15px;height:15px;stroke:currentColor;stroke-width:1.4;fill:none}
.sy-copy-command[data-copy-state="copied"]{color:var(--ok)}
.sy-copy-command[data-copy-state="failed"]{color:var(--fail)}
.sy-copy-command[data-copy-state] svg{display:none}
.sy-copy-command[data-copy-state]::after{font:700 14px/1 var(--sans)}
.sy-copy-command[data-copy-state="copied"]::after{content:'✓'}
.sy-copy-command[data-copy-state="failed"]::after{content:'!'}
.sy-pressure-foot{margin-top:10px}
@media(max-width:900px){
  .sy-pressure-overview{grid-template-columns:repeat(2,minmax(0,1fr))}
  .sy-pressure-project>summary{grid-template-columns:1fr}
  .sy-pressure-meta{justify-content:flex-start}
}
@media(max-width:600px){
  .sy-pressure-overview{grid-template-columns:1fr 1fr}
  .sy-pressure-action{grid-template-columns:1fr}
}
.sy-good{color:var(--ok)}.sy-warn{color:var(--warn)}.sy-zero{color:var(--ink-dim)}
/* Inline SVG charts share one type treatment with the rest of the page. */
.sy-card svg{display:block; max-width:100%}
.sy-card svg text{font-family:var(--sans); fill:var(--ink-2); font-size:11px}
.sy-card svg .gridline{stroke:var(--line); fill:none}
.sy-card svg .big{font-family:var(--mono); font-weight:700; font-size:20px; fill:var(--ink)}
.sy-donut{display:flex; gap:18px; align-items:center; flex-wrap:wrap}
/* One row of five: the growth series are a fixed small set (three hosts plus
   ak's own state and per-project learning stores), and side by side is the
   only arrangement in which they can be compared at a glance. */
.sy-spark{display:grid; grid-template-columns:repeat(5,1fr); gap:12px}
@media(max-width:1100px){.sy-spark{grid-template-columns:repeat(3,1fr)}}
@media(max-width:600px){.sy-spark{grid-template-columns:1fr}}
/* Axis ticks. Smaller than body type and dimmer than the plot, so they read as
   scale rather than as data. */
.sy-card svg text.ax{font-family:var(--mono); font-size:7px; fill:var(--ink-dim)}
/* The single-figure card (learning stores): one number that needs no chart. */
.sy-solo{padding:2px 0}
.sy-solo-v{font-family:var(--mono); font-weight:700; font-size:26px; letter-spacing:-.02em; color:var(--ink)}
.sy-solo-l{color:var(--ink-dim); font-size:11.5px; margin-top:2px}

@media (prefers-reduced-motion:reduce){
  *{animation:none !important; transition:none !important}
  .card{opacity:1; transform:none}
}
`;
