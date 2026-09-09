import { esc, rowLine } from './groups.mjs';

// Self-contained apart from the shared escaper/row renderer: also injected into
// the browser bundle, so tests execute exactly the shipped formatter.
export function contextCard(group) {
  const reports = group.rows.map(r => r.contextReport).filter(Boolean);
  const report = reports[0];
  const tokens = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US') : 'unknown';
  const hostHtml = host => {
    const models = host.models || [];
    const summary = '<section class="context-host"><h3>' + esc(host.label || host.host) + (host.enabled === false ? ' (disabled)' : '') + '</h3>'
      + '<p>' + (host.managed ? 'Managed request: ' + tokens(host.configuredRequest) + ' tokens.' : host.configuredRequest != null ? 'User request: ' + tokens(host.configuredRequest) + ' tokens (unmanaged).' : 'Context controls not managed by kit.')
      + ' Current usage: unknown.</p>';
    const table = models.length ? '<details><summary>' + models.length + ' cached model limits</summary>'
      + '<div class="context-model-scroll" role="region" aria-label="Cached model context limits" tabindex="0">'
      + '<table><thead><tr><th>Model</th><th>Default</th><th>Maximum</th><th>Usable¹</th></tr></thead><tbody>'
      + models.map(model => '<tr><th scope="row">' + esc(model.model) + '</th><td>' + tokens(model.nativeWindow)
        + '</td><td>' + tokens(model.maximumWindow) + '</td><td>' + tokens(model.effectiveWindow) + '</td></tr>').join('')
      + '</tbody></table></div><p>¹ Calculated from configuration and cache; running session unverified.</p></details>' : '';
    const threshold = host.compaction?.configuredThreshold;
    const compact = threshold != null ? '<p>User compaction setting: ' + tokens(threshold)
      + ' tokens; scope and runtime application unverified.</p>' : '';
    const freshness = host.cacheFetchedAt || host.observedAt;
    const basis = '<p class="context-basis">' + esc(host.cacheFetchedAt ? 'Model cache captured' : host.source === 'integration-configuration' ? 'Host enablement inspected' : 'Context inspection attempted')
      + (freshness ? ' · <time datetime="' + esc(freshness) + '">' + esc(new Date(freshness).toLocaleString('en-US', {dateStyle:'medium',timeStyle:'short'})) + '</time>' : '') + '</p>';
    return summary + compact + table + basis + '</section>';
  };
  const warnings = group.rows.filter(r => r.level === 'warn' || r.level === 'fail');
  const content = report ? (report.hosts || []).map(hostHtml).join('')
    + '<details class="context-notes"><summary>Reporting limits</summary><ul>'
    + (report.hosts || []).flatMap(host => (host.limitations || []).map(note => '<li>' + esc(host.label || host.host) + ': ' + esc(note) + '</li>')).join('')
    + '<li>Actual session window and compaction threshold are unknown here. Historical observations are in Usage → Context.</li></ul></details>'
    + (warnings.length ? '<ul class="rows">' + warnings.map(rowLine).join('') + '</ul>' : '')
    : '<ul class="rows">' + group.rows.map(rowLine).join('') + '</ul>';
  return '<article class="card context-card" data-level="' + esc(group.level) + '"><div class="card-top">'
    + '<span class="dot" data-level="' + esc(group.level) + '"></span><span class="card-name">Context</span></div>'
    + content + '</article>';
}
