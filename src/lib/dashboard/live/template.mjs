export const LIVE_HTML = `
  <section class="panel live-panel" id="panel-observability" role="tabpanel" aria-labelledby="tab-observability" data-scope="live" hidden>
    <header class="live-toolbar">
      <div>
        <span class="view-eyebrow">OBSERVABILITY</span>
        <h2 class="live-title" id="observability-title">Live agent activity</h2>
        <p class="live-sub" id="live-sub">Follow the agents, tools, and conversation behind work happening now.</p>
        <span class="live-view-summary" id="live-view-summary"></span>
      </div>
      <div class="live-controls">
        <span class="live-mode" id="live-mode" data-mode="live">LIVE</span>
        <button class="live-pause" id="live-pause" type="button" aria-pressed="false">&#9208; Pause stream</button>
      </div>
    </header>
    <div class="live-state" role="status" aria-live="polite">
      <span class="live-state-dot" id="live-state-dot" data-state="connecting"></span>
      <span id="live-state-text">Connecting to local session telemetry…</span>
      <button class="live-health-summary" id="live-health-toggle" type="button" aria-expanded="false">Sources</button>
      <span class="mono live-cursor" id="live-cursor"></span>
    </div>
    <div class="live-health" id="live-health" aria-label="Adapter health" hidden></div>

    <div class="live-workspace" id="live-workspace" data-transcript-collapsed="false">
      <nav class="live-browser" id="live-browser" aria-label="Projects and sessions" data-level="projects">
        <div class="live-browser-top">
          <button class="live-browser-back" id="live-browser-back" type="button" aria-label="Back to projects">
            <span aria-hidden="true">‹</span>
          </button>
          <div>
            <span class="live-kicker" id="live-browser-kicker">WORKSPACES</span>
            <h3 id="live-browser-title">Projects</h3>
          </div>
          <output id="live-project-count">0</output>
          <output id="live-count">0</output>
        </div>
        <div class="live-browser-stack">
          <section class="live-projects" aria-labelledby="live-browser-title">
            <div class="live-browser-caption">Choose a repository to see its recorded sessions.</div>
            <div id="live-project-list" class="live-project-list" role="list"></div>
          </section>
          <section class="live-project-sessions" aria-labelledby="live-session-heading">
            <h4 class="sr-only" id="live-session-heading">Sessions</h4>
            <div class="live-browser-caption">Most recent activity first</div>
            <div id="live-session-list" class="live-session-list" role="list"></div>
          </section>
        </div>
        <footer class="live-browser-foot">
          <span class="live-state-dot" id="live-browser-state-dot" data-state="connecting"></span>
          <span id="live-browser-state">Local evidence</span>
        </footer>
      </nav>

      <section class="live-canvas-card" aria-labelledby="live-graph-title">
        <div class="live-pane-head live-graph-head">
          <div>
            <span class="live-kicker">EXECUTION MAP</span>
            <h3 id="live-graph-title">Agent activity</h3>
            <span id="live-graph-summary" class="live-graph-summary"></span>
          </div>
          <div class="live-view-tools" role="toolbar" aria-label="Map controls">
            <span class="live-control-group live-zoom-tools" role="group" aria-label="Zoom controls">
              <button type="button" id="live-zoom-out" aria-label="Zoom out" title="Zoom out (−)">−</button>
              <output id="live-zoom" aria-live="polite">100%</output>
              <button type="button" id="live-zoom-in" aria-label="Zoom in" title="Zoom in (+)">+</button>
            </span>
            <span class="live-control-group live-map-actions" role="group" aria-label="Map view actions">
              <button type="button" id="live-fit" title="Fit all actors and operations (F)">Fit</button>
              <button type="button" id="live-fit-selection" title="Center the selected actor or operation">Focus</button>
              <button type="button" id="live-reset-layout" title="Restore automatic positions">Reset</button>
              <button class="live-help-button" type="button" id="live-legend-toggle" aria-expanded="false" aria-controls="live-legend" title="Open the map legend and interaction help">Help</button>
            </span>
          </div>
        </div>
        <div class="live-session-context" id="live-session-context">
          <span class="live-session-context-identity" id="live-session-context-identity">—</span>
          <span id="live-session-context-project">Choose a session</span>
          <span id="live-session-context-status">Waiting for local evidence</span>
        </div>
        <div class="live-canvas" id="live-canvas" tabindex="0" aria-label="Interactive execution map. Drag to pan, scroll to zoom, and drag actors or operations to pin them.">
          <svg id="live-graph" role="group" aria-labelledby="live-graph-title live-graph-desc">
            <desc id="live-graph-desc">Agents are connected to their workers and owned tool calls. Select an item to focus its transcript.</desc>
            <defs>
              <marker id="live-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8z"></path></marker>
              <filter id="live-glow"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>
            <g id="live-viewport"><g id="live-edges"></g><g id="live-tools"></g><g id="live-nodes"></g></g>
          </svg>
          <div class="live-empty" id="live-empty">Waiting for agent activity…</div>
          <div class="live-map-help" id="live-map-guidance" role="status" aria-live="polite">Select an actor or operation for details. Drag to pin · scroll to zoom.</div>
          <div class="live-legend" id="live-legend" role="dialog" aria-labelledby="live-legend-title" hidden>
            <strong id="live-legend-title">How to read this map</strong>
            <dl>
              <dt>Host mark</dt><dd>Claude Code, OpenAI/Codex, or OpenCode execution host; adjacent text is authoritative.</dd>
              <dt>◎ Coordinator</dt><dd>The selected host session.</dd>
              <dt>⬡ Worker</dt><dd>An agent or embedded worker view.</dd>
              <dt>◆ Operation</dt><dd>A tool, skill, plugin, or MCP call.</dd>
              <dt>Presence halo</dt><dd>Slow breathing means the host process is present, not necessarily working.</dd>
              <dt>Green pulse</dt><dd>Meaningful work is observed now.</dd>
              <dt>Moving dash</dt><dd>That specific operation or flow is in flight.</dd>
              <dt>Static line</dt><dd>A recorded relationship, not current traffic.</dd>
              <dt>+ / − lines</dt><dd>Tracked working-tree state compared with HEAD when captured; it is not attributed to one session.</dd>
              <dt>Live / History</dt><dd>Live is current presence or work. History is inert last-recorded evidence.</dd>
            </dl>
            <p>Select for persistent details. Drag actors or operations to pin them; double-click to reset one position.</p>
            <button type="button" id="live-legend-close">Close</button>
          </div>
          <div class="live-tooltip" id="live-tooltip" role="tooltip" hidden></div>
          <div class="sr-only" id="live-interaction-status" aria-live="polite"></div>
        </div>
        <section class="live-playback" id="live-playback" aria-label="Session playback controls" hidden>
          <button type="button" id="live-playback-toggle" aria-label="Play session review">&#9654;</button>
          <label class="sr-only" for="live-playback-range">Playback position</label>
          <input id="live-playback-range" type="range" min="0" max="0" value="0" step="1" disabled>
          <output id="live-playback-time" for="live-playback-range">Live now</output>
          <label class="sr-only" for="live-playback-speed">Playback speed</label>
          <select id="live-playback-speed" aria-label="Playback speed">
            <option value=".5">0.5×</option><option value="1" selected>1×</option>
            <option value="1.5">1.5×</option><option value="2">2×</option>
            <option value="5">5×</option><option value="10">10×</option>
          </select>
          <button type="button" id="live-enter-review">Review session</button>
          <button type="button" id="live-resume-live" hidden>Resume live</button>
        </section>
      </section>

      <aside class="live-transcript" id="live-transcript-panel" aria-labelledby="live-transcript-title" data-collapsed="false">
        <div class="live-pane-head live-transcript-head">
          <div>
            <span class="live-kicker" id="live-transcript-kicker">LIVE EVIDENCE</span>
            <h3 id="live-transcript-title">Session stream</h3>
            <span id="live-transcript-context">Select a session to follow</span>
          </div>
          <span class="live-transcript-state" id="live-transcript-state" data-state="idle">Idle</span>
          <button class="live-transcript-toggle" id="live-transcript-toggle" type="button" aria-expanded="true" aria-controls="live-transcript-body" aria-label="Collapse Session stream" title="Collapse Session stream">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"></path></svg>
          </button>
        </div>
        <div class="live-transcript-body" id="live-transcript-body">
          <div class="live-transcript-tools">
            <label class="live-search"><span class="sr-only">Search transcript</span><input id="live-transcript-search" type="search" placeholder="Search this stream…" autocomplete="off"></label>
            <button type="button" id="live-transcript-follow" aria-pressed="true">Following</button>
            <button type="button" id="live-transcript-clear-filter" hidden>All agents</button>
          </div>
          <div id="live-transcript-list" class="live-transcript-list" role="log" aria-live="polite" aria-relevant="additions text" tabindex="0">
            <div class="live-transcript-empty">Transcript content stays local and appears here as the selected session runs.</div>
          </div>
          <button type="button" id="live-transcript-new" class="live-transcript-new" hidden>New activity ↓</button>
          <details class="live-selection" id="live-selection">
            <summary>Selection details</summary>
            <div id="live-selection-body">Select an agent or tool in the map.</div>
          </details>
          <div class="live-replay-notice" id="live-replay-notice" hidden role="status"></div>
        </div>
      </aside>
    </div>
    <div class="foot">Local evidence view · bounded last-recorded workspace snapshots support History · agent and repository state are never mutated</div>
  </section>`;
