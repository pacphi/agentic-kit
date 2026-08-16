// Shape-agnostic lifecycle report renderer (ADR-0031 P3). setup.mjs, sync.mjs
// and uninstall.mjs used to destructure a runLifecycle() result directly
// (stack.oc/.plugin/.agents/.skill for apply, ret.undo/.artifacts for undo) —
// a shape only OPENCODE_LIFECYCLE_ADAPTER produces. That worked only because
// the command loops iterated builtinHostsWithLifecycle() (opencode-only).
// Now that the loops iterate hostsWithLifecycle() (built-ins + admitted
// externals — see lifecycle-registry.mjs), an admitted host's adapter
// (buildAdmittedLifecycleAdapter) returns the GENERIC lifecycleResult shape
// instead ({ok, changed, facts, actions, ownership, warnings, errors} — see
// lifecycle.mjs) and the raw destructure would throw on `stack.oc`. This
// module is the single place that tells the two shapes apart and turns
// either one into print-ready lines, so no command needs to know which shape
// it got.
//
// opencode's rich shape renders the lines the three commands already printed
// before this wave (same text, same conditions) — pinned by the existing
// setup/sync/uninstall test suites — plus a level fix (Wave C security
// review F5): plugin/agents/skill now carry their OWN ok/status into the
// line's level instead of a hard-coded 'ok', so a failed sub-surface renders
// as failed rather than a fabricated green checkmark. A generic admitted
// host renders one honest summary line instead: ok/changed plus a short
// detail pulled from actions/errors/warnings, never a per-surface breakdown
// the manifest never promised.

/** True when `lifecycle` is opencode's apply() shape: `{changed, result:
 *  {oc, plugin, agents, skill, markersChanged}}`. Any other shape (including
 *  a bare generic lifecycleResult, which has no `.result` at all) is generic. */
function isOpencodeApplyShape(lifecycle) {
  return !!(lifecycle && lifecycle.result && lifecycle.result.oc);
}

/** True when `lifecycle` is opencode's undo() shape: `{changed, result:
 *  {undo, artifacts, ok}}`. */
function isOpencodeUndoShape(lifecycle) {
  return !!(lifecycle && lifecycle.result && lifecycle.result.undo);
}

// F3 (Wave C security review, BLOCKER — ANSI/control-char smuggling): a
// hostile hook's stdout (a manifest's own detect/apply/undo hook, or a
// user-editable error string that eventually lands in one of these lines)
// can carry raw ANSI control sequences — e.g. ESC[2K (erase line) + ESC[1A
// (cursor up) followed by a forged "✓ opencode: … in sync" — which a
// terminal would happily execute, erasing the real (failing) line and
// forging a fake green one. Every line this module builds funnels through
// line() below, so stripping there is the one choke point that closes it
// for every caller, opencode-shaped or generic alike. Reused shape (not
// imported — command/lib boundary): src/commands/x/host-adapters.mjs's own
// ~8-line stripControl is the canonical copy; this is the lib-side twin.
function stripControl(value) {
  const input = String(value ?? '');
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    // Tab/LF/CR become a space rather than vanishing — this is also what
    // clamps every line to a SINGLE line (no embedded newline can smuggle a
    // second, attacker-controlled "line" into the terminal).
    if (code === 0x09 || code === 0x0a || code === 0x0d) { out += ' '; continue; }
    // C0 (0x00-0x1f, includes ESC 0x1b) and C1 (0x7f-0x9f, includes DEL
    // 0x7f) are dropped outright — an ESC-led CSI sequence loses its ESC
    // byte and the rest (e.g. "[2K") survives only as inert, visible text.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/** Typed constructor for one report line — keeps `level` a literal union
 *  instead of widening to `string` the moment it comes from a ternary, AND
 *  is the single choke point every line's text passes through (F3, above).
 * @param {'ok'|'warn'|'info'|'fail'} level
 * @param {string} text
 * @returns {{level:'ok'|'warn'|'info'|'fail', text:string}} */
function line(level, text) {
  return { level, text: stripControl(text) };
}

// F5 (Wave C security review, BLOCKER — built-in sync regression): mirrors
// output.mjs's reportOutcome exactly (result.status ?? (ok?'ok':'failed'),
// then ok/degraded/skipped/anything-else -> ok/warn/info/fail) so a
// FAILED opencode sub-surface (plugin/agents/skill/oc itself) renders at its
// own real level instead of a level this renderer fabricates. Pre-wave sync
// read every opencode sub-result through reportOutcome directly; this is
// that same mapping, now shared by setup AND sync from the one renderer.
function levelForResult(result) {
  const status = result?.status ?? (result?.ok ? 'ok' : 'failed');
  if (status === 'ok') return 'ok';
  if (status === 'degraded') return 'warn';
  if (status === 'skipped') return 'info';
  return 'fail';
}

/** A short, honest one-line detail for a generic lifecycleResult: the first
 *  error, else the first warning, else an action count, else "no changes" —
 *  never fabricated, never a per-surface guess. */
function summarizeGeneric(result) {
  if (Array.isArray(result?.errors) && result.errors.length) return result.errors[0];
  if (Array.isArray(result?.warnings) && result.warnings.length) return result.warnings[0];
  if (Array.isArray(result?.actions) && result.actions.length) return `${result.actions.length} action(s)`;
  return 'no changes';
}

/** @returns {{shape:'opencode', fatal:boolean, ok:boolean, changed:boolean,
 *   ocChanged:boolean, markersChanged:boolean,
 *   lines:Array<{level:'ok'|'warn'|'info'|'fail', text:string}>}} */
function renderOpencodeApply(hostId, lifecycle) {
  const stack = lifecycle.result;
  const lines = [line(levelForResult(stack.oc), `${hostId}: ${stack.oc.detail}`)];
  if (stack.oc.fatal) {
    lines.push(line('warn', `${hostId} plugin/gateway/agents/skill/guidance skipped — ${stack.oc.detail}`));
    return {
      shape: 'opencode', fatal: true, ok: !!stack.oc.ok, changed: !!lifecycle.changed,
      ocChanged: !!stack.oc.changed, markersChanged: !!stack.markersChanged, lines,
    };
  }
  lines.push(line(levelForResult(stack.plugin), `${hostId} plugin: ${stack.plugin.detail}`));
  // The compact lazy gateway (#152) is opencode's own apply surface, rendered
  // through the same shape-agnostic path as the other sub-surfaces.
  lines.push(line(levelForResult(stack.gateway), `${hostId} gateway: ${stack.gateway.detail}`));
  lines.push(line(levelForResult(stack.agents), `${hostId} agents: ${stack.agents.detail}`));
  // F5: restored the `|| !skill.ok` half of the gate — a failed skill write
  // (ok:false, changed:false, e.g. opencode.mjs's adoptionBlocked path) must
  // still be reported, not silently dropped because nothing "changed".
  if (stack.skill.changed || !stack.skill.ok) {
    lines.push(line(levelForResult(stack.skill), `${hostId} skill: ${stack.skill.detail}`));
  }
  return {
    shape: 'opencode', fatal: false, ok: !!stack.oc.ok, changed: !!lifecycle.changed,
    ocChanged: !!stack.oc.changed, markersChanged: !!stack.markersChanged, lines,
  };
}

/** @returns {{shape:'generic', fatal:boolean, ok:boolean, changed:boolean,
 *   ocChanged:boolean, markersChanged:boolean,
 *   lines:Array<{level:'ok'|'warn'|'info'|'fail', text:string}>}} */
function renderGenericApply(hostId, result) {
  const ok = !!result?.ok;
  const changed = !!result?.changed;
  const verdict = ok ? (changed ? 'applied' : 'in sync') : 'apply failed';
  const lines = [line(ok ? 'ok' : 'warn', `${hostId}: ${verdict} — ${summarizeGeneric(result)}`)];
  return {
    shape: 'generic', fatal: false, ok, changed, ocChanged: false, markersChanged: false, lines,
  };
}

/**
 * Turn a runLifecycle({action:'apply', ...}) result into print-ready lines.
 * Dispatches on shape (see module doc) — the caller never inspects the
 * result's own fields, only this report's normalized ones.
 * @param {string} hostId
 * @param {any} lifecycle — runLifecycle's return value
 * @returns {{shape:'opencode'|'generic', fatal:boolean, ok:boolean,
 *   changed:boolean, ocChanged:boolean, markersChanged:boolean,
 *   lines:Array<{level:'ok'|'warn'|'info'|'fail', text:string}>}}
 */
export function renderApplyReport(hostId, lifecycle) {
  return isOpencodeApplyShape(lifecycle)
    ? renderOpencodeApply(hostId, lifecycle)
    : renderGenericApply(hostId, lifecycle);
}

/** @returns {{shape:'opencode', ok:boolean, changed:boolean,
 *   lines:Array<{level:'ok'|'warn'|'info'|'fail', text:string}>}} */
function renderOpencodeUndo(hostId, lifecycle) {
  const ret = lifecycle.result;
  const ok = !!ret.ok;
  const changed = !!(ret.undo.changed || ret.artifacts.changed);
  const lines = (changed || !ok) ? [line(
    ok ? 'ok' : 'warn',
    ok
      ? `stripped ak-managed ${hostId} wiring + artifacts (opencode.json, plugin, agents, skill)`
      : `${hostId} teardown incomplete — ${ret.undo.detail}`,
  )] : [];
  return { shape: 'opencode', ok, changed, lines };
}

/** @returns {{shape:'generic', ok:boolean, changed:boolean,
 *   lines:Array<{level:'ok'|'warn'|'info'|'fail', text:string}>}} */
function renderGenericUndo(hostId, result) {
  const ok = !!result?.ok;
  const changed = !!result?.changed;
  const lines = (changed || !ok) ? [line(
    ok ? 'ok' : 'warn',
    ok
      ? `${hostId}: undo complete — ${summarizeGeneric(result)}`
      : `${hostId} teardown incomplete — ${summarizeGeneric(result)}`,
  )] : [];
  return { shape: 'generic', ok, changed, lines };
}

/**
 * Turn a runLifecycle({action:'undo', ...}) result into print-ready lines.
 * Same dispatch as renderApplyReport. `ok` on the return is the caller's
 * ownership-teardown signal (uninstall.mjs ANDs it across every host).
 * @param {string} hostId
 * @param {any} lifecycle — runLifecycle's return value
 * @returns {{shape:'opencode'|'generic', ok:boolean, changed:boolean,
 *   lines:Array<{level:'ok'|'warn'|'info'|'fail', text:string}>}}
 */
export function renderUndoReport(hostId, lifecycle) {
  return isOpencodeUndoShape(lifecycle)
    ? renderOpencodeUndo(hostId, lifecycle)
    : renderGenericUndo(hostId, lifecycle);
}
