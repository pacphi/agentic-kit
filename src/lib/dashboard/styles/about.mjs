export const ABOUT_CSS = `
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

`;
