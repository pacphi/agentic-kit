import { esc } from './groups.mjs';

/**
 * One host card of the Usage > Context panel. Also injected into the browser
 * bundle (client.mjs interpolates `contextHostCard.toString()`), the same
 * pattern as context-card.mjs: one tested renderer for both paths, so it must
 * stay self-contained — every helper is declared inside it.
 *
 * @param {string} host    'claude' | 'codex' | 'opencode'
 * @param {any} fold    the host's MAIN-session fold from the Context projection
 * @param {any} [ctx]   { policy, health, subagent }
 *   policy   — the Context Budget thresholds (bps), for the pressure tooltip
 *   health   — sourceHealth[host] ({status, reason}); makes the empty state
 *              distinguish "not installed" / "unreadable" / "nothing ran"
 *   subagent — the host's subagent fold, shown as a separate secondary line
 */
export function contextHostCard(host, fold, ctx) {
  fold = fold || {};
  ctx = ctx || {};
  const labels = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
  const label = labels[host] || host;
  const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const tokens = (value) => {
    if (!finite(value)) return '—';
    const n = Number(value);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(Math.round(n));
  };
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value.toLocaleString() : '—');
  const policy = ctx.policy || {};
  const pol = (key) => (finite(policy[key]) ? (Number(policy[key]) / 100).toFixed(0) + '%' : 'unknown');

  const meter = (name, bps) => {
    const known = finite(bps);
    const actual = known ? Math.max(0, Number(bps) / 100) : null;
    const bounded = known ? Math.min(100, actual) : 0;
    const valueAttr = known ? ' aria-valuenow="' + bounded.toFixed(1) + '" aria-valuetext="' + actual.toFixed(1) + ' percent"' : '';
    return '<div class="ctx-meter" role="meter" aria-label="' + esc(name) + '" aria-valuemin="0" aria-valuemax="100"' + valueAttr + '>'
      + '<span class="ctx-meter-track"><i style="width:' + bounded.toFixed(1) + '%"></i></span>'
      + '<span class="ctx-meter-value mono">' + (known ? actual.toFixed(1) + '%' : 'unknown') + '</span></div>';
  };

  // The real formula and evidence source per host (ADR-0042). Never a catalogue
  // maximum: a pressure sample exists only when numerator and denominator are
  // compatible RUNTIME evidence from the same session.
  const formula = {
    codex: 'Pressure = last_token_usage.input_tokens ÷ model_context_window, both from the SAME token_count event. '
      + 'Cached input is a subset of that input and is not added again.',
    claude: 'Pressure = gross input of each assistant message (fresh + cache read + cache write) ÷ the context window the '
      + 'Claude Code statusline reported for that session at that time. Only sessions that ran with the kit\'s statusline '
      + 'have a window (run ak sync to enable it); headless, subagent and pre-upgrade sessions show Input only.',
    opencode: 'OpenCode records no runtime context window, so pressure is not measured. A catalogue maximum is deliberately '
      + 'not used: it would overstate capacity, because local models often load far less than their maximum.',
  };
  const tip = (formula[host] || 'Pressure is measured only where the host records a runtime context window.')
    + '\nThresholds: startup target ' + pol('startupTargetBps') + '; dynamic warn ' + pol('dynamicWarningBps')
    + ' · compact ' + pol('dynamicCompactBps') + ' · handoff ' + pol('dynamicHandoffBps') + '; reserve ' + pol('reserveBps') + '.'
    + '\n"Not measured" never means 0%. Evidence is a per-session runtime observation, never an estimate.';

  const emptyState = () => {
    const status = ctx.health && ctx.health.status;
    if (status === 'absent') return { label: 'Not installed', reason: 'No ' + label + ' session store was found on this machine, so there is nothing to measure.' };
    if (status === 'degraded') {
      return {
        label: 'Source unreadable',
        reason: label + ' data could not be read' + (ctx.health.reason ? ' (' + ctx.health.reason + ')' : '')
          + ', so an empty list here does not mean no sessions ran.',
      };
    }
    if (status === 'ok') return { label: 'No sessions', reason: 'No sessions in the selected timeframe. ' + label + ' is installed and readable; nothing ran in this window.' };
    return { label: 'No sessions', reason: 'No sessions in the selected timeframe.' };
  };
  const describe = (coverage) => {
    const sessions = coverage.sessions;
    const paired = coverage.pressureMeasured || 0;
    if (sessions === 0) return emptyState();
    if (!Number.isFinite(sessions)) return { label: 'Unavailable', reason: 'Session coverage is unavailable.' };
    if (paired > 0) return { label: paired === sessions ? 'Measured' : 'Partial coverage', reason: paired + ' of ' + sessions + ' sessions have paired input/window measurements.' };
    if (coverage.inputMeasured > 0 && !(coverage.windowMeasured > 0)) {
      return {
        label: 'Input only',
        reason: 'Input tokens are available without a recorded context window.'
          + (host === 'claude' ? ' Only sessions that ran with the kit statusline record one.' : ''),
      };
    }
    if (coverage.windowMeasured > 0) return { label: 'Unpaired data', reason: 'Input and window were not recorded together, so pressure cannot be calculated.' };
    return { label: 'Not recorded', reason: 'No input/window measurements were found in these sessions.' };
  };

  const coverage = fold.coverage || {};
  const state = coverage.state || 'not-observed';
  const description = describe(coverage);
  const peak = fold.pressureBps && fold.pressureBps.peak && fold.pressureBps.peak.p90;
  const windowMedian = fold.windowTokens && fold.windowTokens.median;
  const inputPeak = fold.inputTokens && fold.inputTokens.peak && fold.inputTokens.peak.p90;
  const tipId = 'ctx-tip-' + host;
  const pressure = finite(peak)
    ? meter(label + ' p90 peak context pressure', peak)
    : '<p class="ctx-no-pressure">Pressure not measured</p>';

  const sub = ctx.subagent || {};
  const subCoverage = sub.coverage || {};
  const subPeak = sub.pressureBps && sub.pressureBps.peak && sub.pressureBps.peak.p90;
  const subInput = sub.inputTokens && sub.inputTokens.peak && sub.inputTokens.peak.p90;
  const subagents = subCoverage.sessions > 0
    ? '<p class="ctx-subagents"><b>Subagent sessions</b> (delegated work, reported separately from the figures above): '
      + esc(count(subCoverage.sessions)) + ' · p90 peak input ' + esc(tokens(subInput)) + ' · '
      + (finite(subPeak) ? 'p90 peak pressure ' + esc((Number(subPeak) / 100).toFixed(1)) + '%' : 'pressure not measured') + '</p>'
    : '';

  return '<article class="ctx-card" data-state="' + esc(state) + '">'
    + '<div class="ctx-card-head"><h2>' + esc(label) + '</h2><span class="ctx-state">' + esc(description.label) + '</span></div>'
    + '<div class="ctx-pressure" tabindex="0" title="' + esc(tip) + '" aria-describedby="' + esc(tipId) + '">' + pressure + '</div>'
    + '<span class="sr-only" id="' + esc(tipId) + '">' + esc(tip) + '</span>'
    + '<dl class="ctx-facts"><div><dt>main sessions</dt><dd>' + esc(count(coverage.sessions)) + '</dd></div>'
    + '<div><dt>Sessions with pressure</dt><dd>' + esc(count(coverage.pressureMeasured)) + '</dd></div>'
    + '<div><dt>p90 peak input</dt><dd>' + esc(tokens(inputPeak)) + '</dd></div>'
    + '<div><dt>median window</dt><dd>' + esc(tokens(windowMedian)) + '</dd></div></dl>'
    + '<p class="ctx-caveat">' + esc(description.reason) + '</p>' + subagents + '</article>';
}
