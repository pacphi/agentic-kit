import { esc, rowLine } from './groups.mjs';

// Also injected into the browser bundle: one tested formatter for both paths.
export function contextCard(group) {
  const report = group.rows.find(row => row.contextReport)?.contextReport;
  const tokens = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US') : '—';
  const controls = {
    claude: ['Model & compaction', 'https://code.claude.com/docs/en/model-config'],
    codex: ['Model & compaction', 'https://learn.chatgpt.com/docs/config-file/config-reference'],
    opencode: ['Per-model limits', 'https://opencode.ai/docs/config'],
  };
  const hostHtml = host => {
    const models = host.models || [];
    const control = controls[host.host];
    const requested = host.configuredRequest != null ? tokens(host.configuredRequest) + ' tokens requested' : null;
    const summary = '<section class="context-host"><div class="context-host-heading"><h3>' + esc(host.label || host.host)
      + (host.enabled === false ? ' (disabled)' : '') + '</h3>'
      + (host.managed ? '<span>Kit-managed</span>' : control ? '<a class="context-control" href="' + control[1]
        + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc((host.label || host.host) + ' ' + control[0] + ' documentation')
        + '">Native controls ↗</a>' : '<span>Native</span>') + '</div>'
      + (requested ? '<p>' + requested + '</p>' : '');
    const codex = host.host === 'codex' && models.some(model => model.nativeWindow != null);
    const columns = codex ? [['nativeWindow','Default'],['maximumWindow','Maximum'],['effectiveWindow','Usable¹']]
      : [['capacityWindow','Context'],['inputLimit','Input'],['outputLimit','Output']].filter(([field]) => models.some(model => model[field] != null));
    const header = columns.map(([,label]) => '<th>' + label + '</th>').join('');
    const cells = model => columns.map(([field]) => model[field]);
    const freshnessNote = models.some(model => model.freshness === 'stale') ? ' · stale'
      : models.some(model => model.freshness === 'unknown') ? ' · freshness unverified' : '';
    const table = models.length ? '<details><summary>' + models.length + (host.modelsOmitted ? ' of ' + (models.length + host.modelsOmitted) : '') + ' cached model limit' + (models.length === 1 ? '' : 's') + freshnessNote + '</summary>'
      + '<div class="context-model-scroll" role="region" aria-label="' + esc(host.label || host.host) + ' cached model context limits" tabindex="0">'
      + '<table><thead><tr><th>Model</th>' + header + '</tr></thead><tbody>'
      + models.map(model => '<tr><th scope="row" title="' + esc(model.capturedAt ? 'Captured ' + model.capturedAt : 'Capture date unavailable') + '">' + esc(model.provider ? model.provider + '/' + model.model : model.model)
        + '</th>' + cells(model).map(value => '<td>' + tokens(value) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table></div>' + (codex ? '<p>¹ Calculated configuration; session application unverified.</p>' : '') + '</details>' : '';
    const threshold = host.compaction?.configuredThreshold;
    const compact = threshold != null ? '<p>Configured compaction: ' + tokens(threshold) + ' tokens</p>' : '';
    const freshness = codex ? host.cacheFetchedAt : host.inventoryCapturedAt;
    const basis = models.length && freshness ? '<p class="context-basis">Cache <time datetime="' + esc(freshness) + '">'
      + esc(new Date(freshness).toLocaleString('en-US', {dateStyle:'medium',timeStyle:'short'})) + '</time></p>' : '';
    return summary + compact + table.replace('</details>', basis + '</details>') + '</section>';
  };
  const warnings = group.rows.filter(row => row.level === 'warn' || row.level === 'fail');
  const content = report ? (report.hosts || []).map(hostHtml).join('')
    + '<a class="context-control" data-model-inventory href="#usage/models">Open model inventory →</a>'
    + (warnings.length ? '<ul class="rows">' + warnings.map(rowLine).join('') + '</ul>' : '')
    : '<ul class="rows">' + group.rows.map(rowLine).join('') + '</ul>';
  return '<article class="card context-card" data-level="' + esc(group.level) + '"><div class="card-top">'
    + '<span class="dot" data-level="' + esc(group.level) + '"></span><span class="card-name">Context configuration</span></div>'
    + content + '</article>';
}
