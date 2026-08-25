import { CSS } from './styles.mjs';
import { JS } from './client.mjs';
import { LIVE_CSS, LIVE_HTML, LIVE_JS } from './live-view.mjs';

// ── Intelligence: machine-wide rollup + project picker ──────────────────────
// Scoped to this file (not styles.mjs) since page.mjs is the only owner of
// this markup. Reuses styles.mjs's existing design tokens (--panel, --line,
// --ink*, --r-sm, --accent) so the new rows/picker match the Apple system
// motif everywhere else, without duplicating any of styles.mjs's own rules.
const INTEL_CSS = `
.mw-table{display:flex; flex-direction:column; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:var(--r-sm); overflow:hidden; margin-top:14px}
.mw-row{display:grid; grid-template-columns:minmax(140px,1.6fr) repeat(3,minmax(96px,1fr)); gap:10px; align-items:center; padding:8px 14px; background:var(--panel); font-size:12.5px}
.mw-row.mw-head{background:var(--panel-2); color:var(--ink-dim); font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.06em}
.mw-row:not(.mw-head):hover{background:var(--panel-2)}
.mw-name{color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
/* Which learning stores a project carries — three tiny dots, one per store,
   so a row reporting 0 patterns still says what IS active there. Colour, not
   text, because the column is already tight and the title carries the names. */
.mw-stores{display:inline-flex; gap:3px; margin-left:7px; vertical-align:middle; cursor:help}
.mw-store{width:5px; height:5px; border-radius:50%; display:inline-block; background:var(--dim)}
.mw-store[data-store="claude-flow"]{background:var(--s1)}
.mw-store[data-store="agentic-qe"]{background:var(--s3)}
.mw-store[data-store="swarm"]{background:var(--purple)}
.mw-val{color:var(--ink-2); text-align:right}
.mw-row.mw-head .mw-val{color:var(--ink-dim)}
@media(max-width:560px){.mw-row{grid-template-columns:1fr repeat(3,minmax(60px,1fr)); gap:6px}}
.mw-picker{display:flex; align-items:center; gap:9px; flex-wrap:wrap}
.mw-picker label{color:var(--ink-dim); font-size:11.5px}
.mw-picker select{
  background:var(--panel-2); border:1px solid var(--line); color:var(--ink);
  font-family:inherit; font-size:12.5px; padding:6px 12px; border-radius:100px;
  cursor:pointer; max-width:100%;
}
.mw-picker select:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.mw-picker select:disabled{opacity:.5; cursor:not-allowed}
/* The picker moved INTO this strip's head (it is a control on "learning over
   time", not a panel of its own), so the head's baseline alignment has to give
   way to centre alignment or the select sits low against the heading. */
#history .strip-head{align-items:center}
#history #strip-note{margin:0 0 14px}
/* The census explainer: how this panel's project count relates to the counts
   the other tabs show. Sits under the hero because it explains the number in
   it. Reuses the .i-src disclosure so it costs no vertical space until asked. */
#mw-census{margin-top:12px}
.mw-census-line{color:var(--ink-2); font-size:12px; line-height:1.55; margin:0 0 6px}
.mw-census-line b{color:var(--ink); font-weight:600}
.mw-census-caveat{color:var(--warn); font-size:11.5px; margin:6px 0 0}
`;

// ─────────────────────────────────────────────────────────────────────────────
// The page. One document, everything inline. Only `name` and `version` are
// interpolated server-side; the client fetches /api/status and renders live.
//
// Layout: five primary areas — About, Overview, Usage, Observability, and
// System — share one left-aligned secondary-navigation rail. Overview owns
// Summary, Hosts & Routing, Providers, Runtime, and Intelligence; System owns
// Summary, Advisory, Sessions, Storage, Runtime, Catalog, and Projects. Problems never hide:
// Overview's Summary aggregates attention and child tabs retain their scoped
// badges.
//
// About leads the bar because it is the orientation surface (ADR-0026) — but
// OVERVIEW REMAINS THE LANDING VIEW. A first-run nudge on Overview points at
// About once and is dismissible; hijacking the default view would make every
// returning user pay for a first-run explanation.
// ─────────────────────────────────────────────────────────────────────────────
export function renderPage({ name, version }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a84ff'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='white' stroke-width='3'/%3E%3C/svg%3E">
<title>agentic-kit · dashboard</title>
<style>${CSS}${LIVE_CSS}${INTEL_CSS}</style>
</head>
<body>
<div class="gate" id="dash-gate" hidden>
  <div class="gate-card">
    <p>Every conversation and project you've worked on lives behind this page. Paste the one-time session token printed in your terminal (it also rode in on the launch URL's <code>#</code> fragment) — that proves it's really you, not some other program on this machine.</p>
    <input type="password" id="gate-token" placeholder="dashboard token" autocomplete="off" spellcheck="false">
    <button class="primary" id="gate-go" type="button">Open dashboard</button>
    <p class="err" id="gate-err"></p>
  </div>
</div>
<header class="band">
  <div class="band-lead">
    <div class="mark" aria-hidden="true"></div>
    <div class="band-titles">
      <h1 class="kit-name">${escapeHtml(name)}</h1>
      <div class="kit-sub"><span class="mono ver">v${escapeHtml(version)}</span><span class="sep">·</span><span>local diagnostic panel</span></div>
    </div>
  </div>
  <div class="band-verdict">
    <span class="dot" id="verdict-dot" data-level="unknown"></span>
    <span class="verdict-text" id="verdict-text">connecting…</span>
  </div>
  <div class="band-tools">
    <span class="pulse" id="pulse"></span>
    <span class="upd mono" id="updated">—</span>
    <div class="poll">
      <button class="play on" id="poll-play" type="button" title="polling on — click to pause" aria-label="pause polling">&#9208;</button>
      <button class="ivl mono" id="poll-ivl" type="button" title="polling interval" aria-haspopup="true" aria-expanded="false">30s <span class="caret" aria-hidden="true">&#9662;</span></button>
      <button class="refresh" id="poll-now" type="button" title="refresh now" aria-label="refresh now">&#8635;</button>
    </div>
    <button class="toggle" id="theme-toggle" type="button" aria-label="toggle theme" title="toggle theme">
      <span class="icon" id="theme-icon" aria-hidden="true"></span>
    </button>
  </div>
  <div class="menu" id="poll-menu" hidden>
    <button type="button" data-ms="15000">15s</button>
    <button type="button" data-ms="30000">30s</button>
    <button type="button" data-ms="60000">1m</button>
    <button type="button" data-ms="300000">5m</button>
    <button type="button" data-ms="900000">15m</button>
    <button type="button" data-ms="1800000">30m</button>
    <div class="sep"></div>
    <button type="button" data-ms="3600000">1h</button>
    <button type="button" data-ms="21600000">6h</button>
    <button type="button" data-ms="43200000">12h</button>
    <button type="button" data-ms="86400000">24h</button>
  </div>
</header>

<nav class="tabbar">
  <div class="seg" role="tablist" aria-label="dashboard sections" id="seg">
    <span class="seg-thumb" id="seg-thumb" aria-hidden="true"></span>
    <button class="seg-btn" role="tab" id="tab-about" data-tab="about" aria-selected="false" aria-controls="panel-about" type="button">About</button>
    <button class="seg-btn" role="tab" id="tab-overview" data-tab="overview" aria-selected="true" aria-controls="area-overview" type="button">Overview<span class="badge" id="badge-overview" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-usage" data-tab="usage" aria-selected="false" aria-controls="panel-usage" type="button">Usage</button>
    <button class="seg-btn" role="tab" id="tab-observability" data-tab="observability" aria-selected="false" aria-controls="panel-observability" type="button">Observability</button>
    <button class="seg-btn" role="tab" id="tab-system" data-tab="system" aria-selected="false" aria-controls="area-system" type="button">System</button>
  </div>
  <div class="source-health" id="u-source-health" role="status" aria-live="polite" hidden></div>
</nav>

<div class="secondary-shell">
  <div class="secondary-rail">
    <div class="secondary-group" id="secondary-about" hidden>
      <div class="filters" id="about-anchors" role="group" aria-label="About sections" style="margin-left:0">
        <a class="chipf" href="#about/hosts">Hosts</a>
        <a class="chipf" href="#about/engine">Engine &amp; memory</a>
        <a class="chipf" href="#about/quality">Quality &middot; Safety &middot; Knowledge</a>
        <a class="chipf" href="#about/kit">The kit</a>
        <a class="chipf" href="#about/configured">Configured for you</a>
      </div>
    </div>
    <div class="secondary-group" id="secondary-overview">
      <div class="seg subseg" role="tablist" aria-label="Overview views" id="overview-seg">
        <button class="seg-btn" role="tab" id="overview-tab-summary" data-overview-view="summary" aria-selected="true" aria-controls="panel-overview" type="button">Summary</button>
        <button class="seg-btn" role="tab" id="overview-tab-hosts" data-overview-view="hosts" aria-selected="false" aria-controls="panel-hosts" type="button">Hosts &amp; Routing<span class="badge" id="badge-hosts" hidden></span></button>
        <button class="seg-btn" role="tab" id="overview-tab-providers" data-overview-view="providers" aria-selected="false" aria-controls="panel-providers" type="button">Providers<span class="badge" id="badge-providers" hidden></span></button>
        <button class="seg-btn" role="tab" id="overview-tab-runtime" data-overview-view="runtime" aria-selected="false" aria-controls="panel-runtime" type="button">Runtime<span class="badge" id="badge-runtime" hidden></span></button>
        <button class="seg-btn" role="tab" id="overview-tab-intel" data-overview-view="intel" aria-selected="false" aria-controls="panel-intel" type="button">Intelligence<span class="badge" id="badge-intel" hidden></span></button>
      </div>
    </div>
    <div class="secondary-group" id="secondary-usage" hidden>
      <div class="seg subseg" role="tablist" aria-label="Usage views" id="usage-seg">
        <button class="seg-btn" role="tab" id="usage-tab-score" data-view="score" aria-selected="true" aria-controls="v-score" type="button">Scorecard</button>
        <button class="seg-btn" role="tab" id="usage-tab-limits" data-view="limits" aria-selected="false" aria-controls="v-limits" tabindex="-1" type="button">Limits</button>
        <button class="seg-btn" role="tab" id="usage-tab-findings" data-view="findings" aria-selected="false" aria-controls="v-findings" tabindex="-1" type="button">Findings<span class="segbadge" id="u-findings-n" hidden></span></button>
        <button class="seg-btn" role="tab" id="usage-tab-sessions" data-view="sessions" aria-selected="false" aria-controls="v-sessions" tabindex="-1" type="button">Sessions<span class="mono seg-n" id="u-sessions-n"></span></button>
        <button class="seg-btn" role="tab" id="usage-tab-models" data-view="models" aria-selected="false" aria-controls="v-models" tabindex="-1" type="button">Models<span class="segbadge" id="mli-attention-n" hidden></span></button>
        <button class="seg-btn" role="tab" id="usage-tab-transcript" data-view="transcript" aria-selected="false" aria-controls="v-transcript" tabindex="-1" type="button">Transcript</button>
      </div>
      <div class="filters secondary-actions" id="usage-days" role="group" aria-label="Usage window">
        <button class="chipf" type="button" data-days="7">7d</button>
        <button class="chipf on" type="button" data-days="14">14d</button>
        <button class="chipf" type="button" data-days="30">30d</button>
      </div>
    </div>
    <div class="secondary-group" id="secondary-system" hidden>
      <div class="seg subseg" role="tablist" aria-label="System views" id="system-seg">
        <button class="seg-btn" role="tab" data-system-view="summary" aria-selected="true" aria-controls="panel-sys-summary" type="button">Summary</button>
        <button class="seg-btn" role="tab" data-system-view="advisory" aria-selected="false" aria-controls="panel-sys-advisory" type="button">Advisory</button>
        <button class="seg-btn" role="tab" data-system-view="sessions" aria-selected="false" aria-controls="panel-sys-sessions" type="button">Sessions</button>
        <button class="seg-btn" role="tab" data-system-view="storage" aria-selected="false" aria-controls="panel-sys-storage" type="button">Storage</button>
        <button class="seg-btn" role="tab" data-system-view="runtime" aria-selected="false" aria-controls="panel-sys-runtime" type="button">Runtime</button>
        <button class="seg-btn" role="tab" data-system-view="catalog" aria-selected="false" aria-controls="panel-sys-catalog" type="button">Catalog</button>
        <button class="seg-btn" role="tab" data-system-view="projects" aria-selected="false" aria-controls="panel-sys-projects" type="button">Projects</button>
      </div>
      <div class="secondary-actions sy-freshness" id="system-freshness">
        <span class="sy-asof" id="sys-asof">deep scan &mdash; not run yet</span>
        <button class="chipf" type="button" id="sys-rescan" title="re-measure the deep tier now">&#8635; Rescan</button>
      </div>
    </div>
    <div class="secondary-group" id="secondary-observability" hidden>
      <div class="seg subseg" role="tablist" aria-label="Observability views" id="live-scope-tabs">
        <button class="seg-btn" type="button" role="tab" data-live-scope="live" aria-selected="true">Live</button>
        <button class="seg-btn" type="button" role="tab" data-live-scope="history" aria-selected="false">History</button>
      </div>
      <div class="filters secondary-actions" id="observability-window" role="group" aria-label="History window" hidden>
        <button class="chipf" type="button" data-history-window="1d">1d</button>
        <button class="chipf" type="button" data-history-window="7d">7d</button>
        <button class="chipf on" type="button" data-history-window="14d">14d</button>
        <button class="chipf" type="button" data-history-window="1mo">1mo</button>
        <button class="chipf" type="button" data-history-window="3mo">3mo</button>
        <button class="chipf" type="button" data-history-window="6mo">6mo</button>
        <button class="chipf" type="button" data-history-window="1y">1y</button>
        <button class="chipf" type="button" data-history-window="all">all</button>
      </div>
    </div>
  </div>
</div>

<main class="wrap">
  <!-- ABOUT (ADR-0026). Section headings, intros, the how-it-fits map, and the
       design notes are EDITORIAL PAGE COPY and live here; the cards themselves
       are rendered by the client from about-directory.mjs joined with the
       /api/status payload the dashboard already polls. Quality, Safety and
       Knowledge share one section: three one-card categories read as one
       cluster, not three sparse sections. -->
  <section class="panel" id="panel-about" role="tabpanel" aria-labelledby="tab-about" hidden>
    <div class="ab-wrap">
      <div class="ab-hero" id="ab-hero-anchor">
        <header class="view-heading">
          <span class="view-eyebrow">ABOUT</span>
          <h2>Meet your toolkit</h2>
          <p id="ab-hero-lede"></p>
        </header>
        <div class="ab-relwrap">
          <span class="ab-lbl">How it fits</span>
          <div class="ab-relmap">
            <div class="ab-relbox"><b>Coding agents</b>Claude Code &middot; Codex &middot; OpenCode</div>
            <span class="ab-relarrow">&#8646;</span>
            <div class="ab-relbox"><b>Engine + memory</b>ruflo &middot; agentdb</div>
            <span class="ab-relarrow">&#8646;</span>
            <div class="ab-relbox"><b>Quality &middot; Safety &middot; Knowledge</b>agentic-qe &middot; aidefence &middot; Brain</div>
            <span class="ab-relarrow">&#10554;</span>
            <div class="ab-relbox"><b>agentic-kit</b>installs &amp; heals it all</div>
          </div>
        </div>
      </div>

      <section class="ab-sec" id="ab-hosts">
        <h3>Hosts &mdash; the agents you talk to</h3>
        <p class="ab-intro">The coding agents themselves. Everything further down exists to make
          these smarter, safer, and easier to watch.</p>
        <div class="ab-cards" id="ab-cards-hosts"></div>
      </section>

      <section class="ab-sec" id="ab-engine">
        <h3>Engine &amp; memory &mdash; what makes sessions smarter</h3>
        <div class="ab-cards" id="ab-cards-engine"></div>
      </section>

      <section class="ab-sec" id="ab-quality">
        <h3>Quality &middot; Safety &middot; Knowledge &mdash; evidence, defense, grounding</h3>
        <p class="ab-intro">Three specialists with one theme: making agent work trustworthy &mdash;
          tested, protected from smuggled instructions, and answered from real source.</p>
        <div class="ab-cards" id="ab-cards-quality"></div>
      </section>

      <section class="ab-sec" id="ab-kit">
        <h3>The kit &mdash; who takes care of all this</h3>
        <div class="ab-cards" id="ab-cards-kit"></div>
      </section>

      <section class="ab-sec" id="ab-configured">
        <h3>Configured for you</h3>
        <p class="ab-intro">Not packages &mdash; settings and wiring ak set up on your behalf. Each
          names the command that manages it: yours to change, never a black box.</p>
        <div class="ab-cards" id="ab-cards-configured"></div>
      </section>

    </div>
  </section>

  <section class="primary-area" id="area-overview" role="tabpanel" aria-labelledby="tab-overview">
  <section class="panel" id="panel-overview" role="tabpanel" aria-labelledby="overview-tab-summary">
    <header class="view-heading">
      <span class="view-eyebrow">OVERVIEW</span>
      <h2>System overview</h2>
      <p>Overall readiness, configuration health, and the items that need attention.</p>
    </header>
    <!-- First-run nudge (ADR-0026): Overview stays the landing view; this
         points at About once and remembers being dismissed, like the poll and
         theme preferences. It renders BELOW the triage summary so a failing
         subsystem is never displaced by an introduction. -->
    <div class="summary" id="summary" hidden></div>
    <a class="mli-summary" id="mli-summary" data-model-lifecycle href="#usage/models">
      <span><b>Model lifecycle</b><small id="mli-summary-copy">No cached inventory yet</small></span>
      <span class="pill" id="mli-summary-state" data-level="warn"><span class="dot" data-level="warn"></span>refresh</span>
    </a>
    <div class="ab-nudge" id="about-nudge" hidden>
      <span class="i" aria-hidden="true">&#9432;</span>
      <span>New here? <b>About</b> explains every tool agentic-kit installed on this machine, in
        plain words. <button class="ab-nudge-go" type="button" id="about-nudge-go">Open About</button></span>
      <button class="ab-nudge-x" type="button" id="about-nudge-x" aria-label="dismiss this tip" title="dismiss">&times;</button>
    </div>
    <div class="notice" id="update-notice" hidden></div>
    <div id="attention" aria-live="polite"></div>
    <h2 class="subhead" id="map-head" hidden>all subsystems</h2>
    <div class="statusmap" id="statusmap"></div>
  </section>

  <section class="panel" id="panel-hosts" role="tabpanel" aria-labelledby="overview-tab-hosts" hidden>
    <header class="view-heading">
      <span class="view-eyebrow">OVERVIEW</span>
      <h2>Hosts &amp; routing</h2>
      <p>Enabled execution hosts, activity assignments, primary-host policy, and escalation paths.</p>
    </header>
    <div id="cards-hosts"></div>
    <section class="strip" id="routing" hidden>
      <div class="strip-head">
        <button class="strip-toggle" type="button" aria-expanded="true" aria-controls="routing-body">
          <span class="chev" aria-hidden="true">&rsaquo;</span>
          <h2 class="strip-title">per-activity routing</h2>
        </button>
        <span class="mono strip-note" id="routing-note"></span>
      </div>
      <div class="strip-body" id="routing-body">
        <div class="route-matrix" id="route-matrix"></div>
      </div>
    </section>
    <section class="strip" id="models" hidden>
      <div class="strip-head">
        <button class="strip-toggle" type="button" aria-expanded="true" aria-controls="models-body">
          <span class="chev" aria-hidden="true">&rsaquo;</span>
          <h2 class="strip-title">routed host models</h2>
        </button>
        <span class="mono strip-note" id="models-note"></span>
      </div>
      <div class="strip-body" id="models-body">
      <div class="note"><span class="i">&#8505;</span><span>This is your <b>per-activity routing policy</b> &mdash;
        which host and model ak <i>assigns</i> to each kind of work. It is projected into
        <b>agentic-qe</b> agent overrides and <b>ak run</b> pipelines; agentic-qe also has its own
        model router, so a route here is the assignment, not a guarantee.
        It does <b>not</b> establish which inference provider served a session.
        For the models and providers that <b>actually ran</b>, see <b>Usage &rarr; Scorecard</b>.</span></div>
      <div class="model-list" id="model-list"></div>
      </div>
    </section>
  </section>

  <section class="panel" id="panel-providers" role="tabpanel" aria-labelledby="overview-tab-providers" hidden>
    <header class="view-heading">
      <span class="view-eyebrow">OVERVIEW</span>
      <h2>Inference providers</h2>
      <p>Provider bindings, availability, provenance, and configuration health.</p>
    </header>
    <div id="cards-providers"></div>
  </section>

  <section class="panel" id="panel-runtime" role="tabpanel" aria-labelledby="overview-tab-runtime" hidden>
    <header class="view-heading">
      <span class="view-eyebrow">OVERVIEW</span>
      <h2>Runtime health</h2>
      <p>Local services, MCP connections, processes, and operational readiness.</p>
    </header>
    <div id="cards-runtime"></div>
  </section>

  <section class="panel" id="panel-intel" role="tabpanel" aria-labelledby="overview-tab-intel" hidden>
    <header class="view-heading">
      <span class="view-eyebrow">OVERVIEW</span>
      <h2>Intelligence &amp; learning</h2>
      <p>Memory, learned patterns, quality feedback, and improvement signals &mdash; machine-wide, plus detail for one project you pick below.</p>
    </header>
    <div id="cards-intel"></div>

    <section class="strip" id="mw-intel">
      <div class="strip-head">
        <h2 class="strip-title">machine-wide intelligence</h2>
      </div>
      <div class="hero" id="mw-hero"></div>
      <details class="i-src" id="mw-census" hidden>
        <summary>how these projects were counted</summary>
        <div id="mw-census-body"></div>
      </details>
      <div class="mw-table" id="mw-table"></div>
    </section>

    <section class="strip" id="history">
      <div class="strip-head">
        <h2 class="strip-title">learning over time &mdash; <span id="history-project-name"></span></h2>
        <div class="mw-picker">
          <label for="intel-project-select">select project</label>
          <select id="intel-project-select"></select>
        </div>
      </div>
      <p class="mono strip-note" id="strip-note"></p>
      <div class="empty" id="history-empty" hidden></div>
      <div class="spark-row" id="spark-row">
        <figure class="spark">
          <figcaption class="mono">patterns learned</figcaption>
          <div class="spark-svg" id="spark-patterns"></div>
          <div class="strip-note" style="margin-top:6px">lifetime counter (neural/stats.json) &mdash; only ever climbs, even as the store below is pruned</div>
        </figure>
        <figure class="spark">
          <figcaption class="mono">pattern store size</figcaption>
          <div class="spark-svg" id="spark-pattern-store"></div>
          <div class="strip-note" style="margin-top:6px">entries currently on disk (neural/patterns.json), by day created &mdash; a different number from the lifetime counter</div>
        </figure>
        <figure class="spark">
          <figcaption class="mono">reasoning graph size</figcaption>
          <div class="spark-svg" id="spark-graph"></div>
          <div class="strip-note" id="graph-meta" style="margin-top:6px"></div>
        </figure>
        <figure class="spark">
          <figcaption class="mono">improvement &Delta;pp</figcaption>
          <div id="delta-meta" style="margin-bottom:6px" hidden></div>
          <div class="spark-svg" id="spark-delta"></div>
        </figure>
        <figure class="spark">
          <figcaption class="mono">learning curve (cold&rarr;warm)</figcaption>
          <div class="spark-svg" id="spark-curve"></div>
          <div class="strip-note" style="margin-top:6px">held-out accuracy within this eval run, at each k-step checkpoint</div>
        </figure>
      </div>
    </section>
  </section>
  </section>

  <section class="panel" id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>
    <header class="view-heading" id="usage-view-heading">
      <span class="view-eyebrow">USAGE</span>
      <h2 id="usage-view-title">Usage scorecard</h2>
      <p id="usage-view-description">Token consumption, API-equivalent cost, efficiency, and trends.</p>
    </header>

    <section class="view" id="v-score" role="tabpanel" aria-labelledby="usage-tab-score">
      <div class="hero" id="u-hero"></div>
      <div class="note"><span class="i">&#8505;</span><span>Dollar figures are <b>API list-price equivalents</b> &mdash;
        what these tokens would cost metered. On a Max/Pro subscription you are not billed this.
        Cache reads bill at 0.1&times; input and cache writes at 1.25&times;; ignoring that would overstate
        a window by roughly <b>10&times;</b>. <span class="mono" id="u-asof"></span></span></div>
      <section class="strip">
        <div class="sh"><h2>cost per day</h2><span class="n mono" id="u-days-note"></span></div>
        <div class="days" id="u-daybars"></div>
      </section>
      <section class="strip">
        <div class="sh"><h2>telemetry coverage</h2><span class="n mono" id="u-telemetry-note">capabilities &middot; observed locally</span></div>
        <div class="telemetry-grid" id="u-telemetry-grid"></div>
      </section>
      <div class="two">
        <section class="strip">
          <div class="sh"><h2>by host</h2><span class="n mono" id="u-hosts-note"></span></div>
          <div class="psplit" id="u-hosts"></div>
          <div class="tokbar" id="u-tokbar"></div>
          <div class="legend" id="u-toklegend"></div>
        </section>
        <section class="strip">
          <div class="sh"><h2>when you work</h2><span class="n mono">responses &middot; local time</span></div>
          <div id="u-punch"></div>
        </section>
      </div>
      <div class="two">
        <section class="strip">
          <div class="sh"><h2>models in play</h2><span class="n mono">observed in transcripts &middot; by api-equivalent cost<span class="n-sub" id="u-models-note"></span></span></div>
          <div id="u-models"></div>
        </section>
        <section class="strip">
          <div class="sh"><h2>projects</h2><span class="n mono" id="u-projects-note"></span></div>
          <div id="u-projects"></div>
        </section>
      </div>
      <section class="strip">
        <div class="sh">
          <button class="strip-toggle" type="button" aria-expanded="false" aria-controls="u-openrouter-body">
            <span class="chev" aria-hidden="true">&rsaquo;</span>
            <h2>provider account analytics</h2>
          </button>
          <span class="n mono" id="u-openrouter-note">offline cache &middot; separate from transcript totals</span></div>
        <div class="strip-body" id="u-openrouter-body" hidden>
          <div id="u-openrouter"></div>
        </div>
      </section>
      <section class="strip">
        <div class="sh"><h2>what you worked on</h2>
          <span class="n mono">classified from titles, skills &amp; tool mix &middot; click to filter</span></div>
        <div id="u-cats"></div>
        <div class="legend" style="margin-top:11px">
          <span class="lg"><i class="conf"></i>dot opacity = classifier confidence</span>
          <span class="lg">Unclassified is shown, never force-fit</span>
        </div>
      </section>
    </section>

    <section class="view" id="v-limits" role="tabpanel" aria-labelledby="usage-tab-limits" hidden>
      <div class="note"><span class="i">&#8505;</span><span>Utilization here is <b>vendor-reported</b> &mdash;
        the plan&rsquo;s own percentages, a denominator local transcripts cannot compute.
        Claude&rsquo;s numbers arrive via the managed statusLine while a session runs; Codex&rsquo;s come from
        <b>codex app-server</b> using codex&rsquo;s own login. This panel reads no vendor credential.</span></div>
      <div class="two">
        <section class="strip">
          <div class="sh"><h2>claude plan limits</h2><span class="n mono" id="u-lim-claude-note"></span></div>
          <div class="lim" id="u-lim-claude"></div>
        </section>
        <section class="strip">
          <div class="sh"><h2>codex plan limits</h2><span class="n mono" id="u-lim-codex-note"></span></div>
          <div class="lim" id="u-lim-codex"></div>
        </section>
      </div>
      <div class="ins-grid" id="u-lim-insights"></div>
      <div class="foot">windows are keyed by their duration, never by the vendor&rsquo;s primary/secondary slot &middot;
        stale data is labelled stale, not hidden</div>
    </section>

    <section class="view" id="v-findings" role="tabpanel" aria-labelledby="usage-tab-findings" hidden>
      <div class="note"><span class="i">&#8505;</span><span id="u-findings-note"></span></div>
      <div class="ins-grid" id="u-insights"></div>
      <div class="foot">grounded in local measurement first; vendor benchmarks are labelled as such &middot;
        third-party &ldquo;model X vs Y&rdquo; blog comparisons are deliberately not used as evidence</div>
    </section>

    <section class="view" id="v-sessions" role="tabpanel" aria-labelledby="usage-tab-sessions" hidden>
      <div class="note"><span class="i">&#8505;</span><span>Grouped by project, aggregate first.
        Expand a project to see its sessions. Open a row&rsquo;s chevron for execution host, independently evidenced provider, model, and usage details; click <b>&#9707;</b> to read its transcript. &ldquo;Not recorded&rdquo; means the source did not establish that fact.</span></div>
      <div class="ptree" id="u-tree"></div>
      <div class="foot">durations are session span (first&rarr;last event), not exclusive wall-clock</div>
    </section>

    <section class="view" id="v-models" role="tabpanel" aria-labelledby="usage-tab-models" aria-busy="false" hidden>
      <div class="sr-only" id="mli-load-status" role="status" aria-live="polite" aria-atomic="true"></div>
      <div class="note"><span class="i">&#8505;</span><span>This is a <b>read-only operator view</b>.
        It shows the routes you use first and keeps catalogue availability, account access, and observed use as separate evidence.
        Unknown stays unknown; refresh is the only operation that contacts model sources.</span></div>
      <div class="mli-attention" id="mli-attention" role="status" aria-live="polite"></div>
      <section class="strip mli-routes-panel">
        <div class="sh"><h2>Your routes</h2><span class="n mono" id="mli-asof"></span></div>
        <p class="mli-copy">Configured routes and fallbacks. Catalogue-only models are kept below so they do not obscure what is operating now.</p>
        <div class="mli-table-wrap" role="region" aria-label="Your model routes; scroll in either direction for every route" tabindex="0"><table class="mli-table mli-routes-table">
          <caption class="sr-only">Configured model routes, providers, observed use, and API-equivalent pricing.</caption>
          <thead><tr><th>Model</th><th>Model provider</th><th>Used for</th><th>Last used</th><th>API rate / plan use</th></tr></thead>
          <tbody id="mli-routes"></tbody>
        </table></div>
      </section>
      <details class="strip mli-ledger" id="mli-catalog-explorer">
        <summary><span><b>Catalog explorer</b><small>Available and catalogue-only models are separate from your routes.</small></span><span class="n mono">Open when needed</span></summary>
        <div class="mli-catalog-body">
        <div class="sh"><h2>Explore catalog</h2><span class="n mono">public metadata is not entitlement</span></div>
        <form class="mli-filters" id="mli-filters" role="search">
          <label class="mli-filter mli-filter-search" for="mli-search"><span>Search</span><input id="mli-search" name="search" type="search" autocomplete="off" placeholder="Name or selector"></label>
          <label class="mli-filter" for="mli-host"><span>Access host</span><select id="mli-host" name="host"><option value="">All hosts</option></select></label>
          <label class="mli-filter" for="mli-provider"><span>Model provider</span><select id="mli-provider" name="provider"><option value="">All providers</option></select></label>
          <label class="mli-filter" for="mli-relevance"><span>View</span><select id="mli-relevance" name="relevance"><option value="relevant">In use</option><option value="catalog">Available</option><option value="all">All</option></select></label>
          <label class="mli-filter" for="mli-lifecycle"><span>Lifecycle</span><select id="mli-lifecycle" name="lifecycle"><option value="">Any lifecycle</option><option value="removed">Removed</option><option value="retiring">Retiring</option><option value="deprecated">Deprecated</option><option value="hidden">Hidden</option><option value="preview">Preview</option><option value="active">Active</option><option value="unknown">Unknown</option></select></label>
          <label class="mli-filter" for="mli-evidence-field"><span>Evidence state</span><select id="mli-evidence-field" name="evidenceField"><option value="">Any evidence</option><option value="configured">Configured</option><option value="effective">Effective</option><option value="observed">Observed</option><option value="discoverable">Available</option><option value="entitled">Entitled</option><option value="policyAllowed">Policy</option><option value="routable">Routable</option></select></label>
          <label class="mli-filter" for="mli-evidence-value"><span>Evidence value</span><select id="mli-evidence-value" name="evidenceValue" disabled><option value="">Any value</option><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Unknown</option></select></label>
          <button class="mli-reset" id="mli-reset" type="reset">Reset</button>
        </form>
        <div class="mli-results"><span id="mli-result-count" role="status" aria-live="polite" aria-atomic="true">Loading inventory…</span><span class="mono">unknown values sort last</span></div>
        <div class="mli-table-wrap" role="region" aria-label="Host model evidence table; scroll in either direction for every model and state" aria-describedby="mli-result-count" tabindex="0"><table class="mli-table">
          <caption class="sr-only">Catalogue model lifecycle facts. Open Details to inspect evidence.</caption>
          <thead><tr>
            <th scope="col" aria-sort="none"><button type="button" data-mli-sort="host">Model <span aria-hidden="true">↕</span></button></th>
            <th scope="col" aria-sort="none"><button type="button" data-mli-sort="configured">Configured <span aria-hidden="true">↕</span></button></th>
            <th scope="col" aria-sort="none"><button type="button" data-mli-sort="observed">Observed <span aria-hidden="true">↕</span></button></th>
            <th scope="col" aria-sort="none"><button type="button" data-mli-sort="discoverable">Available <span aria-hidden="true">↕</span></button></th>
            <th scope="col" aria-sort="ascending"><button type="button" data-mli-sort="lifecycle">Lifecycle <span aria-hidden="true">↑</span></button></th>
            <th scope="col">Details</th>
          </tr></thead>
          <tbody id="mli-models"></tbody>
        </table></div>
        <div class="mli-pager"><button class="mli-load-more" id="mli-load-more" type="button" hidden>Load 50 more</button></div>
        </div>
      </section>
      <div class="two">
        <section class="strip"><div class="sh"><h2>change history</h2><span class="n mono" id="mli-history-note"></span></div><div id="mli-history"></div></section>
        <section class="strip"><div class="sh"><h2>consumers</h2><span class="n mono">configured / reported evidence</span></div><div id="mli-consumers"></div></section>
      </div>
      <section class="strip"><div class="sh"><h2>swap impact</h2><span class="n mono">read-only canonical-policy preview</span></div><div id="mli-impact"></div></section>
      <div class="foot">swap analysis is available with <b>ak models plan</b> &middot; the dashboard never changes a route</div>
      <dialog class="mli-detail-dialog" id="mli-detail" aria-labelledby="mli-detail-title"><div class="mli-detail-head"><h2 id="mli-detail-title">Model details</h2><button type="button" id="mli-detail-close" aria-label="Close model details">Close</button></div><div id="mli-detail-body"></div></dialog>
    </section>

    <section class="view" id="v-transcript" role="tabpanel" aria-labelledby="usage-tab-transcript" hidden>
      <div class="tcrumb" id="u-crumb"></div>
      <section class="strip" id="u-turns"></section>
      <div class="foot">secret-shaped strings are masked server-side &mdash; the original never reaches this page &middot; no export button by design</div>
    </section>
  </section>

${LIVE_HTML}

  <!-- SYSTEM (ADR-0025). Five sub-views on the shared secondary rail; every
       card's body is rendered by the client from GET /api/system. The deep tier
       is NEVER scanned on open — the rail's Rescan button is the only trigger,
       and the freshness label states how old the figures are. -->
  <section class="primary-area" id="area-system" role="tabpanel" aria-labelledby="tab-system" hidden>
    <section class="panel" id="panel-sys-summary" role="tabpanel" hidden>
      <header class="view-heading">
        <span class="view-eyebrow">SYSTEM</span>
        <h2>Summary</h2>
        <p>Install size, retained data, live resource use and deployed inventory &mdash; each
          deep-tier figure stamped with when it was measured.</p>
      </header>
      <div class="sy-grid">
        <div class="sy-kpis" id="sys-kpis"></div>
        <div class="sy-liner" id="sys-kpis-note"></div>
        <div class="sy-card sy-band">
          <div id="sys-gauge"></div>
        </div>
        <div class="sy-card">
          <div class="sy-head">
            <h3>Largest consumers</h3>
            <!-- Two controls, both about WHAT IS COUNTED. The grouping chips
                 re-shape the same measurement client-side; the project-trees
                 chip changes the measurement itself, so it starts a rescan and
                 says so in its tooltip. -->
            <div class="sy-ctl" id="sys-cons-ctl">
              <button class="chipf on" type="button" data-cons-mode="ranked">Ranked</button>
              <button class="chipf" type="button" data-cons-mode="ecosystem">By ecosystem</button>
              <button class="chipf" type="button" id="sys-cons-trees" aria-pressed="false">Project trees</button>
            </div>
          </div>
          <div class="sy-liner" id="sys-consumers-note"></div>
          <div class="sy-scroll" id="sys-consumers"></div>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-sys-storage" role="tabpanel" hidden>
      <header class="view-heading">
        <span class="view-eyebrow">SYSTEM</span>
        <h2>Storage</h2>
        <p>Retained data by category, then by host, plus growth over time. Learning stores are
          counted on their own because they dwarf everything else. Session-level detail lives in
          Sessions.</p>
      </header>
      <div class="sy-grid">
        <!-- Learning stores get their OWN card and are excluded from the two
             charts below. On a real machine they are 99% of retained bytes, so
             leaving them in renders the donut as a solid ring and flattens
             every other series to nothing. Splitting them out is presentation
             only: the collector still measures all four categories and
             ak system --json still emits them. -->
        <div class="sy-card sy-4">
          <div class="sy-head"><h3>Learning stores</h3></div>
          <div id="sys-learning"></div>
        </div>
        <div class="sy-card sy-4">
          <div class="sy-head"><h3>Retained data by category</h3></div>
          <div id="sys-donut"></div>
        </div>
        <div class="sy-card sy-4">
          <div class="sy-head"><h3>Per-host split by category</h3></div>
          <div id="sys-hostsplit"></div>
        </div>
        <div class="sy-card">
          <div class="sy-head"><h3>Growth &mdash; bytes added per day</h3></div>
          <div id="sys-growth"></div>
        </div>
      </div>
    </section>

    <!-- Advisory is its own area, not a card under a measurement. Everything
         else in System reports what IS; this is the only place that suggests
         what you might DO, and it still has no delete control and may never
         gain one (ADR-0025 §6). Giving it a tab is what keeps that distinction
         legible instead of burying it under a byte chart. -->
    <section class="panel" id="panel-sys-advisory" role="tabpanel" hidden>
      <header class="view-heading">
        <span class="view-eyebrow">SYSTEM</span>
        <h2>Advisory</h2>
        <p>Space you could get back. <b>Regenerable</b> rebuilds itself on demand;
          <b>review</b> might still be in use. Nothing here deletes &mdash; each row gives you
          the path and the command that does.</p>
      </header>
      <div class="sy-grid">
        <div class="sy-card">
          <div class="sy-head"><h3>Reclaimable</h3></div>
          <div class="sy-liner" id="sys-reclaim-note"></div>
          <div id="sys-reclaim"></div>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-sys-sessions" role="tabpanel" hidden>
      <header class="view-heading">
        <span class="view-eyebrow">SYSTEM</span>
        <h2>Sessions</h2>
        <p>The individual session files behind the retained bytes &mdash; which projects hold the
          largest of them, and how much of a host's retained data each one accounts for.</p>
      </header>
      <div class="sy-grid">
        <div class="sy-card">
          <div class="sy-head"><h3>Largest sessions</h3></div>
          <div id="sys-topsessions"></div>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-sys-runtime" role="tabpanel" hidden>
      <header class="view-heading">
        <span class="view-eyebrow">SYSTEM</span>
        <h2>Runtime</h2>
        <p>A point-in-time census &mdash; computed on request, never persisted. CPU and memory of
          live host processes, daemons against their TTL, and combined totals.</p>
      </header>
      <div class="sy-grid">
        <div class="sy-card sy-8">
          <div class="sy-head"><h3>Live host processes</h3></div>
          <div id="sys-procs"></div>
        </div>
        <div class="sy-card sy-4">
          <div class="sy-head"><h3>Combined memory</h3></div>
          <div id="sys-mem"></div>
          <div class="sy-head" style="margin-top:6px"><h3>Daemons</h3></div>
          <div id="sys-daemons"></div>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-sys-catalog" role="tabpanel" hidden>
      <header class="view-heading">
        <span class="view-eyebrow">SYSTEM</span>
        <h2>Catalog</h2>
        <p>What is actually deployed, deduplicated across hosts &mdash; and which host carries what.</p>
      </header>
      <div class="sy-grid">
        <div class="sy-card sy-5">
          <div class="sy-head"><h3>Host inventory profile</h3></div>
          <div id="sys-radar"></div>
        </div>
        <div class="sy-card sy-7">
          <div class="sy-head"><h3>Unique across hosts</h3></div>
          <div id="sys-catcounts"></div>
          <!-- Two independent multi-selects, every option on at first paint, so
               the default view is still the whole inventory. Populated from the
               payload's own kinds/hosts rather than hardcoded, so a host or a
               kind added to the collector appears here without an edit. -->
          <div class="sy-filters">
            <div class="sy-filter-row">
              <span class="sy-filter-l" id="sys-cat-kind-l">show</span>
              <div class="sy-ctl" id="sys-cat-kinds" role="group" aria-labelledby="sys-cat-kind-l"></div>
            </div>
            <div class="sy-filter-row">
              <span class="sy-filter-l" id="sys-cat-host-l">carried by</span>
              <div class="sy-ctl" id="sys-cat-hosts" role="group" aria-labelledby="sys-cat-host-l"></div>
            </div>
          </div>
          <div id="sys-matrix"></div>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-sys-projects" role="tabpanel" hidden>
      <header class="view-heading">
        <span class="view-eyebrow">SYSTEM</span>
        <h2>Projects</h2>
        <p>Every repository you have worked in with a host: how much code it holds, which
          languages that code is in, what the whole project directory occupies on disk, and when
          you last touched it. What is left out, and why, is accounted for beneath the table.</p>
      </header>
      <div class="sy-grid">
        <div class="sy-card">
          <div class="sy-head"><h3>Project footprints</h3></div>
          <div id="sys-projects"></div>
        </div>
      </div>
    </section>
  </section>

</main>

<script>${LIVE_JS}</script>
<script>${JS}</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Styles ───────────────────────────────────────────────────────────────────
// Design: Apple system motif. SF stack with a tight-tracked large title, a
// frosted sticky segmented control (the macOS/iOS tab idiom), hairline
// separators, soft diffuse shadows, and the Apple system palette — systemBlue
// accent, systemGreen/Orange/Red status semantics. Restraint over ornament;
// CSS variables drive BOTH themes.
