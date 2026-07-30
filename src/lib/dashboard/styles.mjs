export const CSS = `
:root{
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue","Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono","Menlo","Cascadia Code",monospace;
  --r:16px; --r-sm:11px;
  /* One height for every scrollable list, so the page frame never changes
     between Findings / Sessions / Transcript. The 420px subtrahend is the fixed
     chrome above and below: header band + tab bar + sub-tabs + note + footer.
     Without it the region ran to the viewport edge and the footer sat below the
     fold, forcing a window scroll to read it — the thing in-place scrolling was
     supposed to avoid. */
  --listh:clamp(200px, calc(100vh - 420px), 520px);
}
:root[data-theme="dark"]{
  --bg:#000000; --panel:#1c1c1e; --panel-2:#2c2c2e; --raised:#3a3a3c; --thumb:#48484a;
  --ink:#f5f5f7; --ink-2:rgba(235,235,245,.64); --ink-dim:rgba(235,235,245,.38);
  --line:rgba(255,255,255,.09); --line-2:rgba(255,255,255,.17);
  --accent:#0a84ff; --accent-soft:rgba(10,132,255,.16);
  --ok:#30d158; --warn:#ff9f0a; --fail:#ff453a; --info:#98989d; --purple:#bf5af2;
  --material:rgba(16,16,18,.72);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -20px rgba(0,0,0,.9);
}
:root[data-theme="light"]{
  --bg:#f5f5f7; --panel:#ffffff; --panel-2:#f2f2f7; --raised:#ffffff; --thumb:#ffffff;
  --ink:#1d1d1f; --ink-2:rgba(60,60,67,.68); --ink-dim:rgba(60,60,67,.42);
  --line:rgba(60,60,67,.12); --line-2:rgba(60,60,67,.22);
  --accent:#007aff; --accent-soft:rgba(0,122,255,.12);
  --ok:#34c759; --warn:#ff9500; --fail:#ff3b30; --info:#8e8e93; --purple:#af52de;
  --material:rgba(249,249,251,.78);
  --shadow:0 1px 2px rgba(0,0,0,.05),0 12px 30px -22px rgba(0,0,0,.22);
}
@media (prefers-color-scheme:light){
  :root:not([data-theme]){ color-scheme:light; }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);
  color:var(--ink);
  font-family:var(--sans);
  font-size:14px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
  min-height:100vh;
  overflow-x:hidden;
}
.mono{font-family:var(--mono)}

/* ── token gate (dashboard requires a per-session token, same contract as
   admin — ADR-0014) — hides the rest of the page via body.gated below ── */
.gate{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:24px}
.gate[hidden]{display:none}
.gate-card{max-width:460px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:26px 28px}
.gate-card p{font-size:14px;color:var(--ink-2);margin:0 0 14px;line-height:1.5}
.gate-card code{font-family:var(--mono);color:var(--accent);font-size:12.5px}
.gate-card input{width:100%;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font-family:var(--mono);font-size:14px;padding:10px 12px;margin-bottom:12px}
.gate-card input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.gate-card .err{color:var(--fail);font-size:13.5px;margin:10px 0 0;min-height:1.2em}
.gate-card button.primary{background:var(--accent);color:#fff;border:0;border-radius:10px;font-weight:700;font-size:14px;padding:10px 18px;font-family:var(--sans);cursor:pointer;width:100%}
body.gated .band,body.gated .tabbar,body.gated main{display:none}

/* ── header band ── */
.band{
  position:relative;
  display:flex; align-items:center; gap:20px; flex-wrap:wrap;
  padding:24px clamp(16px,4vw,40px) 14px;
}
.band-lead{display:flex; align-items:center; gap:14px; min-width:0}
.mark{
  width:40px; height:40px; flex:none; border-radius:10px;
  background:linear-gradient(165deg,#5ac8fa,#007aff 55%,#0a5fd6);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 18px -8px rgba(0,122,255,.55);
  position:relative;
}
.mark::after{
  content:""; position:absolute; inset:11px; border-radius:50%;
  border:2.5px solid rgba(255,255,255,.92);
  border-top-color:rgba(255,255,255,.35);
  transform:rotate(-45deg);
}
.band-titles{min-width:0}
.kit-name{
  font-size:clamp(21px,2.6vw,28px); font-weight:700; letter-spacing:-.022em;
  line-height:1.1; margin:0;
}
.kit-sub{color:var(--ink-dim); font-size:12px; display:flex; gap:8px; align-items:center; margin-top:3px}
.kit-sub .sep{opacity:.5}
.ver{color:var(--accent)}
.band-verdict{
  display:flex; align-items:center; gap:9px; margin-left:auto;
  padding:7px 15px; border:1px solid var(--line); border-radius:100px;
  background:var(--panel);
}
.verdict-text{font-size:13px; font-weight:500; letter-spacing:-.006em}
.band-tools{display:flex; align-items:center; gap:10px}
.pulse{
  width:8px; height:8px; border-radius:50%; background:var(--accent); flex:none;
  animation:pulse 2.4s ease-out infinite;
}
/* paused reads as paused: the pulse greys and stops, so "live" is never implied
   by a still-animating dot over stale numbers. */
.pulse.off{background:var(--ink-dim); animation:none}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 var(--accent-soft)}
  70%{box-shadow:0 0 0 7px transparent}
  100%{box-shadow:0 0 0 0 transparent}
}
.upd{font-size:11.5px; color:var(--ink-dim); min-width:96px}

/* ── poll control (governs EVERY tab, not just Usage) ── */
.poll{
  display:flex; align-items:center; gap:2px; padding:3px;
  border:1px solid var(--line); border-radius:100px; background:var(--panel);
}
.poll button{
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  border:0; background:transparent; color:var(--ink-2);
  font-family:inherit; font-size:12px; height:26px; padding:0 10px;
  border-radius:100px; cursor:pointer; transition:background .15s ease, color .15s ease;
}
.poll button:hover:not(:disabled){background:var(--panel-2); color:var(--ink)}
.poll button:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.poll button:disabled{opacity:.38; cursor:not-allowed}
.poll .play{width:28px; padding:0}
.poll .play.on{color:var(--accent)}
.poll .ivl{min-width:56px; justify-content:space-between}
.poll .caret{opacity:.5}
.poll .refresh{width:28px; padding:0; font-size:14px}
.poll .refresh.spin{animation:spin .6s linear}
@keyframes spin{to{transform:rotate(360deg)}}
.menu{
  position:absolute; z-index:60; right:clamp(16px,4vw,40px); top:100%; margin-top:-6px;
  background:var(--panel); border:1px solid var(--line-2); border-radius:var(--r-sm);
  box-shadow:var(--shadow); padding:5px; min-width:118px;
}
.menu[hidden]{display:none}
.menu button{
  display:flex; width:100%; justify-content:space-between; align-items:center;
  font-family:var(--mono); font-size:12px; height:26px; padding:0 9px;
  border-radius:7px; background:transparent; border:0; color:var(--ink-2); cursor:pointer;
}
.menu button:hover{background:var(--panel-2); color:var(--ink)}
.menu button.sel{color:var(--accent)}
.menu .sep{height:1px; background:var(--line); margin:4px 2px}
.toggle{
  display:inline-flex; align-items:center; justify-content:center;
  width:34px; height:34px; padding:0;
  color:var(--ink-2); background:var(--panel);
  border:1px solid var(--line); border-radius:50%; cursor:pointer;
  transition:border-color .2s ease, color .2s ease, background .2s ease;
}
.toggle:hover{border-color:var(--line-2); color:var(--accent); background:var(--panel-2)}
.toggle:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.toggle .icon{display:inline-flex}
.toggle .icon svg{width:16px; height:16px; display:block}

/* ── sticky frosted segmented control ── */
.tabbar{
  position:sticky; top:0; z-index:20;
  display:flex; padding:8px clamp(16px,4vw,40px) 10px;
  background:var(--material);
  -webkit-backdrop-filter:saturate(180%) blur(20px);
  backdrop-filter:saturate(180%) blur(20px);
  border-bottom:1px solid var(--line);
}
.seg{
  position:relative; display:inline-flex; gap:2px; padding:3px;
  border-radius:12px; background:var(--panel-2);
  max-width:100%; overflow-x:auto; scrollbar-width:none;
}
.seg::-webkit-scrollbar{display:none}
.seg-btn{
  position:relative; z-index:1; border:0; background:transparent;
  color:var(--ink-2); font-family:inherit; font-size:13px; font-weight:500;
  letter-spacing:-.006em; padding:6px 14px; border-radius:9px; cursor:pointer;
  white-space:nowrap; display:inline-flex; align-items:center; gap:6px;
  transition:color .2s ease;
}
.seg-btn[aria-selected="true"]{color:var(--ink); font-weight:600}
.seg-btn:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.seg-thumb{
  position:absolute; top:3px; left:3px; height:calc(100% - 6px); width:0;
  border-radius:9px; background:var(--thumb);
  box-shadow:0 1px 4px rgba(0,0,0,.18),0 0 0 .5px rgba(0,0,0,.04);
  transition:left .25s cubic-bezier(.3,.7,.3,1), width .25s cubic-bezier(.3,.7,.3,1);
}
.badge{
  min-width:16px; height:16px; padding:0 4px; border-radius:8px;
  background:var(--fail); color:#fff; font-size:10.5px; font-weight:600;
  display:inline-flex; align-items:center; justify-content:center; line-height:1;
}
.badge[data-tone="warn"]{background:var(--warn)}
.badge[hidden]{display:none}

/* ── layout ── */
.wrap{padding:clamp(16px,4vw,40px); max-width:1180px; margin:0 auto}
.panel{animation:fade .25s ease}
.panel[hidden]{display:none}
@keyframes fade{from{opacity:0; transform:translateY(4px)}to{opacity:1; transform:none}}

/* ── triage summary + update notice (Overview) ── */
.summary{
  display:flex; flex-wrap:wrap; gap:9px; align-items:center;
  margin-bottom:14px; font-size:12.5px;
}
.pill{
  display:inline-flex; align-items:center; gap:7px;
  padding:5px 12px; border-radius:100px;
  border:1px solid var(--line); background:var(--panel);
  color:var(--ink-2); letter-spacing:-.006em;
}
.pill .dot{width:8px; height:8px}
.pill b{color:var(--ink); font-weight:600}
.pill[data-level="fail"]{border-color:color-mix(in srgb,var(--fail) 50%,transparent)}
.pill[data-level="warn"]{border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.pill[data-tone="calm"]{opacity:.72}
.notice{
  display:flex; align-items:baseline; gap:9px;
  padding:10px 14px; margin-bottom:14px;
  border-radius:var(--r-sm); background:var(--accent-soft);
  color:var(--ink-2); font-size:13px;
}
.notice .up{color:var(--accent); font-weight:700}
.notice code{font-family:var(--mono); color:var(--ink); font-size:12px}
.notice b{color:var(--ink); font-weight:600}
.allclear{
  display:flex; align-items:center; gap:10px;
  padding:20px 22px; margin-bottom:6px;
  border-radius:var(--r); background:var(--panel); border:1px solid var(--line);
  box-shadow:var(--shadow); color:var(--ink-2); font-size:14px;
}

/* ── cards ── */
.grid{
  display:grid; gap:14px;
  grid-template-columns:repeat(auto-fill,minmax(272px,1fr));
}
.card{
  background:var(--panel); border:1px solid var(--line);
  border-radius:var(--r); padding:16px 17px 15px;
  box-shadow:var(--shadow);
  opacity:0; transform:translateY(6px);
  animation:rise .45s cubic-bezier(.2,.7,.3,1) forwards;
  overflow:hidden;
}
@keyframes rise{to{opacity:1; transform:none}}
.card-top{display:flex; align-items:center; gap:10px; margin-bottom:9px}
.dot{
  width:10px; height:10px; border-radius:50%; flex:none;
  background:var(--lvl,var(--info));
  box-shadow:0 0 0 3px color-mix(in srgb,var(--lvl,var(--info)) 20%, transparent);
}
.card[data-level="ok"]{--lvl:var(--ok)}
.card[data-level="warn"]{--lvl:var(--warn)}
.card[data-level="fail"]{--lvl:var(--fail)}
.card[data-level="info"]{--lvl:var(--info)}
.card[data-level="unknown"]{--lvl:var(--ink-dim)}
.dot[data-level="ok"]{--lvl:var(--ok)}
.dot[data-level="warn"]{--lvl:var(--warn)}
.dot[data-level="fail"]{--lvl:var(--fail)}
.dot[data-level="info"]{--lvl:var(--info)}
.dot[data-level="unknown"]{--lvl:var(--ink-dim)}
.card-name{font-size:15px; font-weight:600; letter-spacing:-.014em; color:var(--ink)}
.card-level{
  margin-left:auto; font-size:10.5px; font-weight:600; letter-spacing:.1em;
  text-transform:uppercase; color:var(--lvl,var(--info));
}
.card-count{
  margin-left:auto; font-size:11px; color:var(--ink-dim);
  border:1px solid var(--line); border-radius:100px; padding:1px 8px;
}
.card-count + .card-level{margin-left:8px}
.rows{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px}
.rows .row{display:flex; gap:9px; align-items:flex-start; font-size:13px; color:var(--ink-2); line-height:1.5}
.row-dot{
  width:7px; height:7px; border-radius:50%; flex:none; margin-top:6px;
  background:var(--lvl,var(--info));
}
.row[data-level="ok"]{--lvl:var(--ok)}
.row[data-level="warn"]{--lvl:var(--warn)}
.row[data-level="fail"]{--lvl:var(--fail)}
.row[data-level="info"]{--lvl:var(--info)}
.row[data-level="unknown"]{--lvl:var(--ink-dim)}
.row-msg{min-width:0; word-break:break-word}
.row-fix{display:block; margin-top:3px; color:var(--ink-dim); font-size:12px}
.row-fix .arrow{color:var(--accent); margin-right:5px}
.row-fix code{font-family:var(--mono); color:var(--ink-2); font-size:11.5px}

/* ── overview status map ── */
.subhead{
  margin:24px 0 10px; color:var(--ink-dim); font-size:12px; font-weight:600;
  letter-spacing:.07em; text-transform:uppercase;
}
.statusmap{
  display:grid; gap:8px;
  grid-template-columns:repeat(auto-fill,minmax(160px,1fr));
}
.tile{
  display:flex; align-items:center; gap:9px; text-align:left;
  padding:10px 13px; border-radius:var(--r-sm);
  background:var(--panel); border:1px solid var(--line);
  color:var(--ink); font-family:inherit; font-size:12.5px; font-weight:500;
  letter-spacing:-.006em; cursor:pointer;
  transition:background .15s ease, border-color .15s ease;
}
.tile:hover{background:var(--panel-2); border-color:var(--line-2)}
.tile:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.tile .dot{width:8px; height:8px}
.tile .tile-go{margin-left:auto; color:var(--ink-dim); font-weight:400}

/* ── strips (routing / models / learning) ── */
.strip{
  margin-top:22px; padding:18px clamp(14px,3vw,24px);
  background:var(--panel); border:1px solid var(--line);
  border-radius:var(--r); box-shadow:var(--shadow);
}
.strip-head{display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px}
.strip-title{font-size:16px; font-weight:600; letter-spacing:-.014em; margin:0}
.strip-note{color:var(--ink-dim); font-size:12px}
.route-matrix{display:flex; flex-direction:column; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:var(--r-sm); overflow:hidden}
.r-row{display:grid; grid-template-columns:minmax(140px,1.4fr) 84px minmax(120px,1.4fr) minmax(90px,1fr); gap:10px; align-items:center; padding:8px 14px; background:var(--panel)}
.r-row:hover{background:var(--panel-2)}
.r-act{color:var(--ink); font-size:12.5px; display:flex; align-items:center; gap:6px}
.r-host{font-size:11px; font-weight:600; text-align:center; padding:2px 0; border-radius:100px; border:1px solid var(--line-2)}
.r-host-claude{color:#ff9f0a; background:rgba(255,159,10,.12); border-color:rgba(255,159,10,.3)}
.r-host-codex{color:var(--accent); background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.r-host[data-primary]{box-shadow:inset 0 0 0 1.5px var(--accent); font-weight:700}
.r-model{color:var(--ink-2); font-size:11.5px}
.r-meta{display:flex; align-items:center; gap:8px; justify-content:flex-end; font-size:10.5px}
.r-esc{color:var(--ink-dim)}
.r-src{text-transform:uppercase; letter-spacing:.04em; color:var(--ink-dim); font-size:9.5px}
.r-src-user{color:var(--accent)}
.r-tag{font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--accent); border:1px solid var(--accent-soft); border-radius:3px; padding:0 3px}
@media(max-width:560px){.r-row{grid-template-columns:1fr 70px} .r-model,.r-meta{grid-column:1/-1; justify-content:flex-start}}
.model-list{display:flex; flex-direction:column; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:var(--r-sm); overflow:hidden}
.m-row{display:grid; grid-template-columns:84px 1fr auto; gap:12px; align-items:center; padding:9px 14px; background:var(--panel)}
.m-row:hover{background:var(--panel-2)}
.m-model{color:var(--ink); font-size:12.5px}
.m-n{color:var(--ink-dim); font-size:11.5px}
.spark-row{display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:20px}
.spark{margin:0}
.spark figcaption{color:var(--ink-dim); font-size:11px; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px}
.spark-svg{width:100%; overflow-x:auto}
.spark-svg svg{display:block; width:100%; height:auto}

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
.filters{display:flex; gap:8px; flex-wrap:wrap; margin-left:auto}
.chipf{
  font-size:12px; padding:4px 11px; border-radius:100px; border:1px solid var(--line);
  background:var(--panel); color:var(--ink-2); cursor:pointer; font-family:inherit;
}
.chipf.on{border-color:var(--accent); color:var(--accent); background:var(--accent-soft)}
.chipf:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.view[hidden]{display:none}

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
.note{
  display:flex; gap:9px; padding:10px 14px; margin-bottom:16px; border-radius:var(--r-sm);
  background:var(--accent-soft); color:var(--ink-2); font-size:12.5px; align-items:baseline;
}
.note b{color:var(--ink)}
.note .i{color:var(--accent); font-weight:700}
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
.pcard{flex:1; min-width:190px; border:1px solid var(--line); border-radius:var(--r-sm); padding:13px 15px; background:var(--panel-2)}
.pcard .ph{display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; margin-bottom:9px}
.pdot{width:9px; height:9px; border-radius:50%}
.pdot.c{background:var(--warn)}
.pdot.x{background:var(--accent)}
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
  display:grid; grid-template-columns:18px 58px minmax(150px,2.1fr) minmax(90px,1fr) 106px 46px 60px 62px 68px 20px;
  gap:10px; align-items:center; padding:9px 13px; background:var(--panel); font-size:12.5px; cursor:pointer;
}
.srow:hover{background:var(--panel-2)}
.s-host{font-size:10px; font-weight:600; text-align:center; padding:2px 0; border-radius:100px; border:1px solid var(--line-2)}
.s-claude{color:var(--warn); background:color-mix(in srgb,var(--warn) 12%,transparent); border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.s-codex{color:var(--accent); background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.s-title{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
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
     header chips and on the Scorecard's category rows. */
  .srow{grid-template-columns:18px 58px 1fr 68px 20px}
  .srow .s-proj,.srow .s-when,.srow .s-dur,.srow .s-turns,.srow .s-tok,.srow .cat{display:none}
  .phead{grid-template-columns:16px 1fr 58px 66px}
  .phead .pchips,.phead .p-h,.phead .p-tok{display:none}
}

/* ── footer ── */
.foot{margin-top:24px; padding-top:16px; border-top:1px solid var(--line); color:var(--ink-dim); font-size:12px}

.empty{color:var(--ink-dim); font-size:13px; padding:26px 4px}

@media (max-width:560px){
  .band{gap:12px}
  .band-verdict{margin-left:0; order:3; width:100%; justify-content:center}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none !important; transition:none !important}
  .card{opacity:1; transform:none}
}
`;

// ── Client script ────────────────────────────────────────────────────────────
// No backticks and no ${ } anywhere below — this whole string is embedded inside
// a server-side template literal, so those tokens would be misparsed. Plain
// string concatenation only.
