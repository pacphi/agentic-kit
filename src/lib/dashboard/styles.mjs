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
  --ok-soft:rgba(48,209,88,.16);
  --material:rgba(16,16,18,.72);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -20px rgba(0,0,0,.9);
  /* About: category hues for monogram tiles. IDENTITY, not a data series —
     they say "this card belongs to that family", never "this value is larger".
     Named by the directory module (about-directory.mjs's icon.hue), defined
     here, so the data never picks a colour. */
  --hue-engine:#7d7aff; --hue-quality:#30d158; --hue-safety:#ff9f0a;
  --hue-knowledge:#bf5af2; --hue-kit:#0a84ff;
  /* System: the four-step categorical series. Four is the cap — past that the
     steps stop being separable at 3:1 against this panel, which is why the
     Storage donut is capped at four slices and every chart carries labels
     rather than relying on colour alone. --dim is de-emphasis (free space,
     "other", reinstallable overhead), never a category. */
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --dim:#48484a;
}
:root[data-theme="light"]{
  --bg:#f5f5f7; --panel:#ffffff; --panel-2:#f2f2f7; --raised:#ffffff; --thumb:#ffffff;
  --ink:#1d1d1f; --ink-2:rgba(60,60,67,.68); --ink-dim:rgba(60,60,67,.42);
  --line:rgba(60,60,67,.12); --line-2:rgba(60,60,67,.22);
  --accent:#007aff; --accent-soft:rgba(0,122,255,.12);
  --ok:#34c759; --warn:#ff9500; --fail:#ff3b30; --info:#8e8e93; --purple:#af52de;
  --ok-soft:rgba(52,199,89,.14);
  --material:rgba(249,249,251,.78);
  --shadow:0 1px 2px rgba(0,0,0,.05),0 12px 30px -22px rgba(0,0,0,.22);
  /* Light-theme steps of the same two families — darkened where the dark-theme
     value would not clear 3:1 against a #ffffff panel. */
  --hue-engine:#5e5ce6; --hue-quality:#1baf7a; --hue-safety:#eb6834;
  --hue-knowledge:#af52de; --hue-kit:#007aff;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --dim:#c7c7cc;
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
  display:flex; align-items:center; gap:12px; padding:8px clamp(16px,4vw,40px) 10px;
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
.secondary-shell{
  min-height:54px; padding:12px clamp(16px,4vw,40px) 0;
  background:var(--bg);
}
.secondary-rail{max-width:1180px; min-height:42px; margin:0 auto}
.secondary-group{display:flex; align-items:center; gap:12px; min-height:42px; width:100%}
.secondary-group[hidden]{display:none}
.secondary-group .subseg{justify-content:flex-start}
.secondary-actions{margin-left:auto; flex:0 0 auto}
.primary-area[hidden]{display:none}
.view-heading{min-height:76px; margin:0 0 18px}
.view-heading h2{margin:4px 0 5px; color:var(--ink); font-size:20px; letter-spacing:-.025em}
.view-heading p{margin:0; max-width:720px; color:var(--ink-2); font-size:12px; line-height:1.5}
.view-eyebrow{color:var(--accent); font:700 9px/1 ui-monospace,monospace; letter-spacing:.14em}
.badge{
  min-width:16px; height:16px; padding:0 4px; border-radius:8px;
  background:var(--fail); color:#fff; font-size:10.5px; font-weight:600;
  display:inline-flex; align-items:center; justify-content:center; line-height:1;
}
.badge[data-tone="warn"]{background:var(--warn)}
.badge[hidden]{display:none}

/* ── layout ── */
.wrap{padding:16px clamp(16px,4vw,40px) clamp(16px,4vw,40px); max-width:1180px; margin:0 auto}
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

/* Panel-level collapse. A real <button> wrapping the heading, so the whole
   title is the target and screen readers announce the state — the .s-exp
   lesson, applied at panel scale. The chevron is a child span rather than the
   button itself (unlike .s-exp) because the button also has to carry the
   heading; the rotation selector is the only thing that differs, so this still
   reuses the .chev vocabulary rather than inventing a second one.
   Unlike the row expanders, this state IS persisted (LS_COLLAPSE in
   client.mjs): a 30 s poll re-render would otherwise reopen a panel the user
   just closed, which reads as the page fighting you. */
.strip-toggle{
  display:flex; align-items:baseline; gap:8px; margin:0; padding:0;
  background:transparent; border:0; color:inherit; font:inherit; text-align:left; cursor:pointer;
}
.strip-toggle:focus-visible{outline:2px solid var(--accent); outline-offset:3px; border-radius:4px}
.strip-toggle:hover .chev{color:var(--accent)}
.strip-toggle[aria-expanded="true"] .chev{transform:rotate(90deg); color:var(--accent)}
/* A collapsed head carries the panel's whole bottom margin — the body that
   normally provides the spacing is gone. */
.strip-head:has(.strip-toggle[aria-expanded="false"]){margin-bottom:0}
.strip-body[hidden]{display:none}
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
/* Two distinct signals, deliberately coloured apart: the warn tone for a
   retirement (a dated hard failure ak has already worked around) and the
   neutral dim for a divergence (a trade for the user to weigh — colouring it as
   a problem would editorialise a choice the code is careful not to make). */
.r-flag{
  margin-left:7px; font-family:var(--sans); font-size:9.5px; letter-spacing:.01em;
  border-radius:100px; padding:1px 6px; white-space:nowrap; cursor:help;
}
.r-flag[data-kind="retired"]{
  color:var(--warn); border:1px solid color-mix(in srgb,var(--warn) 32%,transparent);
  background:color-mix(in srgb,var(--warn) 11%,transparent);
}
.r-flag[data-kind="diverged"]{
  color:var(--ink-dim); border:1px solid var(--line); background:transparent;
}
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
  display:grid; grid-template-columns:18px 82px minmax(150px,2.1fr) minmax(90px,1fr) 106px 46px 60px 62px 68px 20px;
  gap:10px; align-items:center; padding:9px 13px; background:var(--panel); font-size:12.5px; cursor:pointer;
}
.srow:hover{background:var(--panel-2)}
.s-host{font-size:10px; font-weight:600; text-align:center; padding:2px 6px; border-radius:100px; border:1px solid var(--line-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
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
/* ── About area (ADR-0026) ───────────────────────────────────────────────────
   Every class here is ab-prefixed. The mock's generic names (.card, .tile,
   .note, .grid, .legend) all collide with shipped dashboard classes, so the
   prefix is load-bearing rather than tidiness: an unprefixed .card here would
   restyle every Overview status card. Tokens are the page's own. */
.ab-nudge{
  display:flex; align-items:baseline; gap:10px; padding:11px 14px; margin-bottom:14px;
  border-radius:var(--r-sm); background:var(--accent-soft); color:var(--ink-2); font-size:13px;
}
.ab-nudge .i{color:var(--accent); font-weight:700}
.ab-nudge b{color:var(--ink); font-weight:600}
.ab-nudge-go,.ab-nudge-x{
  background:transparent; border:0; color:var(--accent); font-family:inherit; font-size:13px;
  cursor:pointer; padding:0 2px; border-radius:5px;
}
.ab-nudge-x{color:var(--ink-dim); margin-left:auto; font-size:15px; line-height:1}
.ab-nudge-go:hover,.ab-nudge-x:hover{text-decoration:underline}
.ab-nudge-go:focus-visible,.ab-nudge-x:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
a.chipf{text-decoration:none; display:inline-flex; align-items:center}
.ab-wrap{display:flex; flex-direction:column; gap:34px}
.ab-hero{display:flex; flex-direction:column; gap:12px}
.ab-hero h2{margin:0; font-size:23px; font-weight:700; letter-spacing:-.02em}
.ab-hero p{margin:0; max-width:62ch; color:var(--ink-2); font-size:14px}
.ab-hero p b{color:var(--ink); font-weight:600}
.ab-relwrap{
  display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:2px;
  border:1px dashed var(--line-2); border-radius:var(--r); padding:11px 14px;
}
.ab-relwrap .ab-lbl{
  font-size:10.5px; color:var(--ink-dim); text-transform:uppercase; letter-spacing:.11em; font-weight:700;
}
.ab-relmap{display:flex; align-items:stretch; gap:10px; flex-wrap:wrap}
.ab-relbox{
  display:flex; flex-direction:column; justify-content:center; text-align:center;
  border:1px solid var(--line-2); border-radius:var(--r-sm); padding:8px 13px;
  background:var(--panel); font-size:11.5px; color:var(--ink-2);
}
.ab-relbox b{display:block; color:var(--ink); font-size:12.5px}
.ab-relarrow{align-self:center; color:var(--ink-dim); font-size:15px}
.ab-sec{display:flex; flex-direction:column; gap:12px; scroll-margin-top:120px}
.ab-sec h3{margin:0; font-size:17px; font-weight:700; letter-spacing:-.016em}
.ab-sec p.ab-intro{margin:0; max-width:66ch; color:var(--ink-2); font-size:13px}
.ab-cards{display:grid; gap:14px; grid-template-columns:repeat(3,1fr)}
@media(max-width:900px){.ab-cards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:620px){.ab-cards{grid-template-columns:1fr}}
.ab-card{
  display:flex; flex-direction:column; gap:10px; min-width:0;
  background:var(--panel); border:1px solid var(--line); border-radius:var(--r);
  padding:16px 17px; box-shadow:var(--shadow);
}
.ab-card.ab-wide{grid-column:span 2}
@media(max-width:620px){.ab-card.ab-wide{grid-column:span 1}}
.ab-head{display:flex; align-items:center; gap:11px; min-width:0}
.ab-tile{
  width:38px; height:38px; flex:none; border-radius:10px; display:flex;
  align-items:center; justify-content:center; overflow:hidden;
  background:var(--panel-2); border:1px solid var(--line);
}
/* The three official marks are the SAME sourceHostIcon() SVGs the Observability
   source pills use, reused byte-identically. One of them (opencode) paints a
   literal near-white fill, which would vanish on a light-theme tile — so that
   tile gets a fixed dark backdrop rather than the mark getting a second,
   subtly different copy. */
.ab-tile .live-host-icon{width:20px; height:20px; stroke-width:1.6}
.ab-tile[data-mark="opencode"]{background:#1c1c1e; border-color:rgba(255,255,255,.14)}
.ab-tile.ab-mg{border:0; color:#fff; font-weight:700; font-size:15px; letter-spacing:-.01em}
.ab-name{min-width:0}
.ab-name b{
  display:block; font-size:14px; font-weight:650; letter-spacing:-.012em; color:var(--ink);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.ab-state{
  display:inline-flex; align-items:center; gap:5px; margin-top:3px; padding:1.5px 9px;
  border-radius:100px; font-size:10.5px; font-weight:650;
}
.ab-state::before{content:""; width:5px; height:5px; border-radius:50%; background:currentColor}
.ab-state[data-state="ok"]{color:var(--ok); background:var(--ok-soft)}
.ab-state[data-state="configured"]{color:var(--accent); background:var(--accent-soft)}
.ab-state[data-state="warn"]{color:var(--warn); background:color-mix(in srgb,var(--warn) 15%,transparent)}
.ab-state[data-state="fail"]{color:var(--fail); background:color-mix(in srgb,var(--fail) 15%,transparent)}
.ab-state[data-state="unknown"]{color:var(--ink-2); background:var(--panel-2); border:1px dashed var(--line-2)}
.ab-tagline{font-size:13.5px; font-weight:640; letter-spacing:-.006em; color:var(--ink)}
.ab-body{margin:0; font-size:12.8px; color:var(--ink-2); line-height:1.5}
.ab-detail{
  margin:0; font-size:11.5px; color:var(--ink-2); border-left:2px solid var(--lvl,var(--warn));
  padding:2px 0 2px 9px;
}
.ab-detail[data-level="fail"]{--lvl:var(--fail)}
.ab-detail code{font-family:var(--mono); font-size:11px; color:var(--ink)}
.ab-links{display:flex; gap:6px; flex-wrap:wrap; margin-top:auto; padding-top:2px}
.ab-pill{
  font-size:11px; font-weight:600; text-decoration:none; color:var(--accent);
  border:1px solid var(--line-2); border-radius:100px; padding:3px 10px; background:var(--panel-2);
}
.ab-pill:hover{border-color:var(--accent)}
.ab-pill:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.ab-manage{font-family:var(--mono); font-size:11px; color:var(--ink-dim); margin-top:auto; padding-top:2px}
.ab-secnote{
  border-top:1px dashed var(--line-2); padding-top:8px; max-width:80ch;
  font-size:11.5px; color:var(--ink-2);
}
.ab-secnote b{color:var(--ink); font-weight:600}

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
.sy-freshness{display:flex; align-items:center; gap:9px; font-size:12px; color:var(--ink-2)}
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
/* The presence matrix is a real table now, and scrolls: it lists EVERY
   deduplicated item rather than the first fourteen, and a full inventory is
   several hundred rows on a working machine. The sticky header keeps the host
   columns meaningful once you are 200 rows down. */
.sy-catalog-scroll{max-height:420px; overflow-y:auto}
.sy-catalog-scroll thead th{position:sticky; top:0; background:var(--panel); z-index:1}
.sy-matrix-t .nm{font-family:var(--mono); font-size:11.5px; color:var(--ink); word-break:break-all}
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

// ── Client script ────────────────────────────────────────────────────────────
// No backticks and no ${ } anywhere below — this whole string is embedded inside
// a server-side template literal, so those tokens would be misparsed. Plain
// string concatenation only.
