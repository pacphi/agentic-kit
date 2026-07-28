// Admin console presentation. Kept separate from the loopback server so the
// security boundary and the browser-facing theme can evolve independently.
export const ADMIN_CSS = `
:root{
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue","Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono","Menlo","Cascadia Code",monospace;
  --display:var(--sans);
  --r:16px; --r-sm:11px;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#000; --bg-2:#2c2c2e; --surface:#1c1c1e; --ridge:rgba(255,255,255,.09);
  --ink:#f5f5f7; --ink-2:rgba(235,235,245,.64); --muted:rgba(235,235,245,.5); --faint:rgba(235,235,245,.38);
  --on-accent:#fff; --accent:#0a84ff; --accent-2:#64d2ff; --accent-3:#30d158; --bad:#ff453a;
  --material:rgba(16,16,18,.72);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -20px rgba(0,0,0,.9);
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f5f5f7; --bg-2:#f2f2f7; --surface:#fff; --ridge:rgba(60,60,67,.12);
  --ink:#1d1d1f; --ink-2:rgba(60,60,67,.68); --muted:rgba(60,60,67,.56); --faint:rgba(60,60,67,.42);
  --on-accent:#fff; --accent:#007aff; --accent-2:#0071e3; --accent-3:#248a3d; --bad:#ff3b30;
  --material:rgba(249,249,251,.78);
  --shadow:0 1px 2px rgba(0,0,0,.05),0 12px 30px -22px rgba(0,0,0,.22);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;min-height:100vh;overflow-x:hidden}
.mono{font-family:var(--mono)}
.wrap{max-width:1120px;margin:0 auto;padding:24px clamp(16px,4vw,40px) 44px}
.head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.head h1{font-family:var(--display);font-weight:700;font-size:clamp(21px,2.6vw,28px);letter-spacing:-.022em;color:var(--ink);margin:0}
.mark{width:40px;height:40px;flex:none;border-radius:10px;background:linear-gradient(165deg,#5ac8fa,#007aff 55%,#0a5fd6);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 18px -8px rgba(0,122,255,.55);position:relative}
.mark::after{content:"";position:absolute;inset:11px;border-radius:50%;border:2.5px solid rgba(255,255,255,.92);border-top-color:rgba(255,255,255,.35);transform:rotate(-45deg)}
.stamp{font-size:12px;color:var(--faint)}
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;margin-left:auto;color:var(--ink-2);background:var(--surface);border:1px solid var(--ridge);border-radius:50%;font-family:var(--sans);font-size:16px}
.theme-toggle:hover{color:var(--accent);background:var(--bg-2)}

.gate{max-width:460px;background:var(--surface);border:1px solid var(--ridge);border-radius:12px;padding:26px 28px}
.gate p{font-size:14px;color:var(--ink-2);margin:0 0 14px}
.gate code{font-family:var(--mono);color:var(--accent);font-size:12.5px}
.gate input{width:100%;background:var(--bg-2);border:1px solid var(--ridge);border-radius:10px;color:var(--ink);font-family:var(--mono);font-size:14px;padding:10px 12px;margin-bottom:12px}
.gate input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.err{color:var(--bad);font-size:13.5px;margin:10px 0 0;min-height:1.2em}
button{cursor:pointer;background:var(--surface);color:var(--ink);border:1px solid var(--ridge);border-radius:8px;font-family:var(--mono);font-size:12.5px;padding:6px 14px}
button:hover{border-color:var(--accent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;font-weight:700;font-size:14px;padding:10px 18px;font-family:var(--sans)}
.controls{display:flex;align-items:center;gap:12px;margin-bottom:12px;font-family:var(--mono);font-size:12.5px;color:var(--muted);flex-wrap:wrap}
.controls label{display:flex;align-items:center;gap:6px;cursor:pointer}
.controls .undo{border-color:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--accent)}
.controls .right{margin-left:auto}

/* ── sticky segmented control (the dashboard's tab idiom) ── */
.tabbar{position:sticky;top:0;z-index:20;display:flex;padding:8px 0 10px;margin-bottom:10px;
  background:var(--material);
  -webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);
  border-bottom:1px solid var(--ridge)}
.seg{position:relative;display:inline-flex;gap:2px;padding:3px;border-radius:999px;
  background:var(--bg-2);
  max-width:100%;overflow-x:auto;scrollbar-width:none}
.seg::-webkit-scrollbar{display:none}
.seg-btn{position:relative;z-index:1;border:0;background:transparent;color:var(--muted);
  font-family:var(--mono);font-size:12.5px;letter-spacing:.01em;padding:6px 15px;border-radius:999px;
  cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:7px;transition:color .2s ease}
.seg-btn[aria-selected="true"]{color:var(--ink)}
.seg-btn:hover{color:var(--ink-2)}
.seg-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.seg-thumb{position:absolute;top:3px;left:3px;height:calc(100% - 6px);width:0;border-radius:999px;
  background:var(--surface);border:1px solid var(--ridge);
  box-shadow:var(--shadow);
  transition:left .25s cubic-bezier(.3,.7,.3,1),width .25s cubic-bezier(.3,.7,.3,1)}
.tbadge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--bad);color:#fff;
  font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;line-height:1}
.tbadge[data-tone="warn"]{background:var(--accent);color:var(--on-accent)}
.tbadge[hidden]{display:none}

.panel{animation:fade .25s ease}
.panel[hidden]{display:none}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

.sec{margin-top:26px}
.sec.first{margin-top:6px}
.sec h2{font-family:var(--display);font-weight:600;font-size:1.25rem;color:var(--ink);margin:0 0 4px}
.sec h2 .qual{font-size:11px;color:var(--faint);font-weight:400;letter-spacing:.03em}
.sec .lead{font-size:13px;color:var(--muted);margin:0 0 12px;max-width:80ch}
.sec .note{font-size:12.5px;color:var(--faint);margin:12px 0 0;max-width:80ch;line-height:1.55}
.sec .lead em,.gate p em{color:var(--ink-2);font-style:italic}

.reach{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}
.rcell{border:1px solid var(--ridge);border-radius:12px;padding:16px 18px;background:var(--surface);min-width:0}
.rcell.hero{border-color:color-mix(in srgb,var(--accent-3) 55%,var(--ridge))}
.rcell b{display:block;font-family:var(--display);font-weight:600;font-size:32px;line-height:1.05;color:var(--ink)}
.rcell.hero b{color:var(--accent-3)}
.rcell.unknown b{color:var(--faint);font-size:22px}
.rcell .lbl{display:block;margin-top:6px;font-family:var(--mono);font-size:11.5px;letter-spacing:.03em;color:var(--ink-2);line-height:1.4}
.rcell .win{display:block;margin-top:3px;font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.rcell .caveat{display:block;margin-top:9px;padding-top:9px;border-top:1px solid var(--ridge);font-size:11.5px;color:var(--muted);line-height:1.5}

.mom{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
.mcell{border:1px solid var(--ridge);border-radius:12px;padding:15px 17px;background:var(--surface);min-width:0}
.mcell .top{display:flex;align-items:baseline;gap:8px}
.mcell .top b{font-family:var(--display);font-weight:600;font-size:25px;color:var(--ink);line-height:1.1}
.mcell .arrow{font-family:var(--mono);font-size:12px}
.mcell .arrow.up{color:var(--accent-3)} .mcell .arrow.down{color:var(--bad)} .mcell .arrow.flat{color:var(--faint)}
.mcell span{display:block;margin-top:5px;font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:var(--muted);line-height:1.4}
.mcell .faint{color:var(--faint)}
.mcell svg{display:block;width:100%;height:30px;margin-top:9px}
.mcell.unknown b{color:var(--faint);font-size:20px}

.health{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}
.hcell{border:1px solid var(--ridge);border-radius:12px;padding:15px 17px;background:var(--surface);min-width:0}
.hcell .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hcell .pill{font-family:var(--mono);font-size:11px;letter-spacing:.03em;padding:3px 10px;border-radius:999px;border:1px solid var(--ridge);color:var(--muted)}
.hcell .pill.ok{background:color-mix(in srgb,var(--accent-3) 16%,transparent);border-color:var(--accent-3);color:var(--accent-3)}
.hcell .pill.bad{background:color-mix(in srgb,var(--bad) 16%,transparent);border-color:var(--bad);color:var(--bad)}
.hcell .pill.pending{background:color-mix(in srgb,var(--accent) 16%,transparent);border-color:var(--accent);color:var(--accent)}
.hcell b{display:block;margin-top:9px;font-family:var(--display);font-weight:600;font-size:20px;color:var(--ink)}
.hcell.unknown b{color:var(--faint);font-size:18px}
.hcell span{display:block;margin-top:5px;font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:var(--muted);line-height:1.4}
.hcell a{color:var(--accent-2);text-decoration:none}
.hcell a:hover{text-decoration:underline}

.since{background:var(--surface);border:1px solid var(--ridge);border-radius:14px;padding:22px 24px}
.since .headline{font-family:var(--display);font-weight:600;font-size:1.25rem;color:var(--ink);margin:0 0 6px;line-height:1.34}
.since .headline b{color:var(--accent)}
.since .headline .flat{color:var(--muted)}
.since-when{font-family:var(--mono);font-size:11.5px;color:var(--faint);margin:0 0 18px}
.since-foot{font-size:12.5px;color:var(--faint);margin:14px 0 0;max-width:80ch;line-height:1.55}
.dstrip{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.dcell{border:1px solid var(--ridge);border-radius:10px;padding:13px 15px;background:var(--bg-2);min-width:0}
.dcell b{display:block;font-family:var(--display);font-weight:600;font-size:24px;line-height:1.1;color:var(--muted)}
.dcell.up b{color:var(--accent-3)} .dcell.down b{color:var(--bad)}
.dcell.unknown b{color:var(--faint);font-size:20px}
.dcell span{display:block;margin-top:5px;font-family:var(--mono);font-size:10.5px;letter-spacing:.03em;color:var(--muted);line-height:1.4}
.dcell em{display:block;margin-top:4px;font-style:normal;font-family:var(--mono);font-size:10px;color:var(--faint)}

/* long lists scroll inside their card, never the page (the no-scroll contract) */
.todo,.tl{border:1px solid var(--ridge);border-radius:12px;background:var(--surface);overflow:hidden;margin-top:12px;max-height:52vh;overflow-y:auto}
.todo-row{display:flex;gap:14px;align-items:baseline;padding:13px 16px;border-bottom:1px solid var(--ridge)}
.todo-row:last-child{border-bottom:none}
.todo-row .age{font-family:var(--mono);font-size:11.5px;color:var(--bad);white-space:nowrap;min-width:74px}
.todo-row .age.fresh{color:var(--accent)}
.todo-row .body{min-width:0;flex:1}
.todo-row .body a{color:var(--accent-2);text-decoration:none;font-size:14px}
.todo-row .body a:hover{text-decoration:underline}
.todo-row .body .by{display:block;margin-top:3px;font-family:var(--mono);font-size:11px;color:var(--faint)}
.inbox-zero{border:1px solid color-mix(in srgb,var(--accent-3) 40%,var(--ridge));border-radius:12px;background:var(--surface);padding:18px 20px;margin-top:12px;font-size:14px;color:var(--ink-2)}
.inbox-zero.ridge{border-color:var(--ridge)}
.inbox-zero b{color:var(--accent-3)}

.ppl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.pcard{border:1px solid var(--ridge);border-radius:12px;padding:15px 17px;background:var(--surface)}
.pcard.active{border-color:color-mix(in srgb,var(--accent-3) 55%,var(--ridge))}
.pcard .who{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pcard .who a{font-family:var(--display);font-weight:600;font-size:1.05rem;color:var(--accent-2);text-decoration:none}
.pcard .span{margin:9px 0 0;font-family:var(--mono);font-size:11px;color:var(--faint);line-height:1.5}
.badge{font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--ridge);color:var(--muted);white-space:nowrap}
.badge.live{background:color-mix(in srgb,var(--accent-3) 15%,transparent);border-color:var(--accent-3);color:var(--accent-3)}
.badge.new{background:color-mix(in srgb,var(--accent) 16%,transparent);border-color:var(--accent);color:var(--accent)}
.badge.open{border-color:var(--accent);color:var(--accent)}
.note{color:var(--faint);font-size:12px}

.tl-row{display:flex;gap:13px;align-items:baseline;padding:11px 16px;border-bottom:1px solid var(--ridge);font-size:13.5px}
.tl-row:last-child{border-bottom:none}
.tl-row.is-new{background:color-mix(in srgb,var(--accent) 7%,transparent)}
.tl-row .when{font-family:var(--mono);font-size:11.5px;color:var(--faint);white-space:nowrap;min-width:82px}
.tl-row .kind{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap;min-width:34px}
.tl-row .what{min-width:0;flex:1;color:var(--ink-2);line-height:1.45}
.tl-row .what a{color:var(--accent-2);text-decoration:none}
.tl-row .what a:hover{text-decoration:underline}
.tl-row .what .who{font-family:var(--mono);font-size:11px;color:var(--faint)}
.more-btn{cursor:pointer;background:none;border:0;color:var(--accent-2);font-family:var(--mono);font-size:12px;padding:11px 16px}
.more-btn:hover{color:var(--ink)}

.tbl-scroll{overflow-x:auto;border:1px solid var(--ridge);border-radius:12px;background:var(--surface);margin-top:12px}
table.adm{width:100%;border-collapse:collapse;font-size:13.5px}
table.adm th{text-align:left;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);padding:12px 14px;border-bottom:1px solid var(--ridge)}
table.adm td{padding:10px 14px;border-bottom:1px solid var(--ridge);color:var(--ink-2);vertical-align:top}
table.adm tr:last-child td{border-bottom:none}
table.adm td.num{font-family:var(--mono)}

.gaps{border:1px dashed var(--ridge);border-radius:12px;background:var(--bg-2);padding:6px 20px;margin-top:12px}
.gaps li{list-style:none;padding:10px 0;border-bottom:1px solid var(--ridge);font-size:13.5px;color:var(--ink-2);line-height:1.55}
.gaps li:last-child{border-bottom:none}
.gaps li b{color:var(--ink);font-weight:500}
.gaps li .fix{display:block;margin-top:4px;font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.gaps li .tag{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;padding:2px 7px;border-radius:4px;margin-right:8px;border:1px solid var(--ridge);color:var(--muted)}
.gaps li .tag.config{border-color:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--accent)}
.gaps li .tag.code{border-color:color-mix(in srgb,var(--accent-2) 50%,transparent);color:var(--accent-2)}
.gaps li .tag.design{border-color:color-mix(in srgb,var(--accent-3) 50%,transparent);color:var(--accent-3)}

.doors{font-size:14px;color:var(--ink-2);background:var(--surface);border:1px solid var(--ridge);border-radius:12px;padding:16px 20px;margin-top:12px}
.doors a{color:var(--accent-2)}
.foot{margin-top:26px;padding-top:14px;border-top:1px solid var(--ridge);color:var(--faint);font-size:11.5px}

@media (max-width:880px){
  .dstrip,.mom,.reach,.health{grid-template-columns:1fr 1fr}
  .ppl{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
