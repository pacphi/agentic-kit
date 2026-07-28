import { CSS } from './styles.mjs';
import { JS } from './client.mjs';
import { LIVE_CSS, LIVE_HTML, LIVE_JS } from './live-view.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// The page. One document, everything inline. Only `name` and `version` are
// interpolated server-side; the client fetches /api/status and renders live.
//
// Layout: a sticky segmented control (Apple's tab idiom) splits the panel into
// five views — Overview, Hosts & Routing, Providers, Runtime, Intelligence.
// Problems never hide behind a tab: Overview aggregates every attention card,
// and each tab carries a count badge when something in it is failing/warning.
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
<style>${CSS}${LIVE_CSS}</style>
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
    <button class="seg-btn" role="tab" id="tab-overview" data-tab="overview" aria-selected="true" aria-controls="panel-overview" type="button">Overview<span class="badge" id="badge-overview" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-hosts" data-tab="hosts" aria-selected="false" aria-controls="panel-hosts" type="button">Hosts &amp; Routing<span class="badge" id="badge-hosts" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-providers" data-tab="providers" aria-selected="false" aria-controls="panel-providers" type="button">Providers<span class="badge" id="badge-providers" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-runtime" data-tab="runtime" aria-selected="false" aria-controls="panel-runtime" type="button">Runtime<span class="badge" id="badge-runtime" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-intel" data-tab="intel" aria-selected="false" aria-controls="panel-intel" type="button">Intelligence<span class="badge" id="badge-intel" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-usage" data-tab="usage" aria-selected="false" aria-controls="panel-usage" type="button">Usage</button>
    <button class="seg-btn" role="tab" id="tab-live" data-tab="live" aria-selected="false" aria-controls="panel-live" type="button">Live</button>
  </div>
</nav>

<main class="wrap">
  <section class="panel" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
    <div class="summary" id="summary" hidden></div>
    <div class="notice" id="update-notice" hidden></div>
    <div id="attention" aria-live="polite"></div>
    <h2 class="subhead" id="map-head" hidden>all subsystems</h2>
    <div class="statusmap" id="statusmap"></div>
  </section>

  <section class="panel" id="panel-hosts" role="tabpanel" aria-labelledby="tab-hosts" hidden>
    <div id="cards-hosts"></div>
    <section class="strip" id="routing" hidden>
      <div class="strip-head">
        <h2 class="strip-title">per-activity routing</h2>
        <span class="mono strip-note" id="routing-note"></span>
      </div>
      <div class="route-matrix" id="route-matrix"></div>
    </section>
  </section>

  <section class="panel" id="panel-providers" role="tabpanel" aria-labelledby="tab-providers" hidden>
    <div id="cards-providers"></div>
    <section class="strip" id="models" hidden>
      <div class="strip-head">
        <h2 class="strip-title">routed models</h2>
        <span class="mono strip-note" id="models-note"></span>
      </div>
      <div class="note"><span class="i">&#8505;</span><span>This is your <b>per-activity routing policy</b> &mdash;
        which host and model ak <i>assigns</i> to each kind of work. It is projected into
        <b>agentic-qe</b> agent overrides and <b>ak dual run</b> pipelines; agentic-qe also has its own
        model router, so a route here is the assignment, not a guarantee.
        It does <b>not</b> govern the model an interactive Claude Code or codex CLI session uses &mdash;
        you choose that per session with <span class="mono">/model</span>.
        For the models that <b>actually ran</b>, see <b>Usage &rarr; Scorecard</b>.</span></div>
      <div class="model-list" id="model-list"></div>
    </section>
  </section>

  <section class="panel" id="panel-runtime" role="tabpanel" aria-labelledby="tab-runtime" hidden>
    <div id="cards-runtime"></div>
  </section>

  <section class="panel" id="panel-intel" role="tabpanel" aria-labelledby="tab-intel" hidden>
    <div id="cards-intel"></div>
    <section class="strip" id="history" hidden>
      <div class="strip-head">
        <h2 class="strip-title">learning over time</h2>
        <span class="mono strip-note" id="strip-note"></span>
      </div>
      <div class="spark-row">
        <figure class="spark">
          <figcaption class="mono">patterns learned</figcaption>
          <div class="spark-svg" id="spark-patterns"></div>
        </figure>
        <figure class="spark">
          <figcaption class="mono">improvement Δpp</figcaption>
          <div class="spark-svg" id="spark-delta"></div>
        </figure>
      </div>
    </section>
  </section>

  <section class="panel" id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>
    <div class="usage-bar">
      <div class="seg subseg" role="tablist" aria-label="usage views" id="usage-seg">
        <button class="seg-btn" role="tab" data-view="score" aria-selected="true" type="button">Scorecard</button>
        <button class="seg-btn" role="tab" data-view="limits" aria-selected="false" type="button">Limits</button>
        <button class="seg-btn" role="tab" data-view="findings" aria-selected="false" type="button">Findings<span class="segbadge" id="u-findings-n" hidden></span></button>
        <button class="seg-btn" role="tab" data-view="sessions" aria-selected="false" type="button">Sessions<span class="mono seg-n" id="u-sessions-n"></span></button>
        <button class="seg-btn" role="tab" data-view="transcript" aria-selected="false" type="button">Transcript</button>
      </div>
      <div class="filters" id="usage-days" role="group" aria-label="window">
        <button class="chipf" type="button" data-days="7">7d</button>
        <button class="chipf on" type="button" data-days="14">14d</button>
        <button class="chipf" type="button" data-days="30">30d</button>
      </div>
    </div>

    <section class="view" id="v-score">
      <div class="hero" id="u-hero"></div>
      <div class="note"><span class="i">&#8505;</span><span>Dollar figures are <b>API list-price equivalents</b> &mdash;
        what these tokens would cost metered. On a Max/Pro subscription you are not billed this.
        Cache reads bill at 0.1&times; input and cache writes at 1.25&times;; ignoring that would overstate
        a window by roughly <b>10&times;</b>. <span class="mono" id="u-asof"></span></span></div>
      <section class="strip">
        <div class="sh"><h2>cost per day</h2><span class="n mono" id="u-days-note"></span></div>
        <div class="days" id="u-daybars"></div>
      </section>
      <div class="two">
        <section class="strip">
          <div class="sh"><h2>by host</h2><span class="n mono">claude vs codex</span></div>
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
        <div class="sh"><h2>what you worked on</h2>
          <span class="n mono">classified from titles, skills &amp; tool mix &middot; click to filter</span></div>
        <div id="u-cats"></div>
        <div class="legend" style="margin-top:11px">
          <span class="lg"><i class="conf"></i>dot opacity = classifier confidence</span>
          <span class="lg">Unclassified is shown, never force-fit</span>
        </div>
      </section>
    </section>

    <section class="view" id="v-limits" hidden>
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

    <section class="view" id="v-findings" hidden>
      <div class="note"><span class="i">&#8505;</span><span id="u-findings-note"></span></div>
      <div class="ins-grid" id="u-insights"></div>
      <div class="foot">grounded in local measurement first; vendor benchmarks are labelled as such &middot;
        third-party &ldquo;model X vs Y&rdquo; blog comparisons are deliberately not used as evidence</div>
    </section>

    <section class="view" id="v-sessions" hidden>
      <div class="note"><span class="i">&#8505;</span><span>Grouped by project, aggregate first.
        Expand a project to see its sessions; click <b>&#9707;</b> on any session to read its transcript.</span></div>
      <div class="ptree" id="u-tree"></div>
      <div class="foot">durations are session span (first&rarr;last event), not exclusive wall-clock</div>
    </section>

    <section class="view" id="v-transcript" hidden>
      <div class="tcrumb" id="u-crumb"></div>
      <section class="strip" id="u-turns"></section>
      <div class="foot">secret-shaped strings are masked server-side &mdash; the original never reaches this page &middot; no export button by design</div>
    </section>
  </section>

${LIVE_HTML}

  <footer class="foot mono">
    <span id="foot-note">read-only · 127.0.0.1 · nothing here mutates state</span>
  </footer>
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
