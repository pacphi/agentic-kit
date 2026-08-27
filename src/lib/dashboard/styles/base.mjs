export const BASE_CSS = `
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
  --mli-muted:#b8b8be; --mli-ok:#58dc78; --mli-fail:#ff6961;
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
  --mli-muted:#59595e; --mli-ok:#167d32; --mli-fail:#c5221f;
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
.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;
  overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
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

`;
