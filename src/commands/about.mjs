// ak about — the component directory in the terminal (ADR-0026).
//
// The CLI twin of the dashboard's About area, reading the SAME frozen editorial
// data (src/lib/dashboard/about-directory.mjs). There is deliberately no second
// copy of the copy: a paragraph reviewed for the release must read identically
// in both surfaces, or one of them shipped text nobody signed off on.
//
// The editorial/detection split survives the port. Prose comes from the
// directory and never claims runtime state; the state chip is the only place a
// runtime fact appears, and it is fed by collectors that ALREADY EXIST — the
// version primitives `ak status` itself calls, and `ak status`'s own rows for
// the configured surfaces. This command adds no probe of its own. When a
// detection source fails the chip degrades to `state unknown — <reason>` and the
// entry still renders: an unmeasured component is never drawn as absent
// (ADR-0023 / component-directory invariants 2 and 3).
import { heading, dim, bold, glyph, green, yellow } from '../lib/output.mjs';
import { CATEGORY_ORDER, directoryEntries } from '../lib/dashboard/about-directory.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  category: { type: 'string' },
  'no-detect': { type: 'boolean', default: false },
};

export const help = `ak about — what agentic-kit installs and configures, and why

One entry per component: what it is, what it does for you, where to read more,
and an honest state chip. Prose is authored with the release; the chip is the
only runtime fact, read from the same detection \`ak status\` uses. The dashboard's
About tab renders this identical directory.

Usage:
  ak about [entry-id]

Options:
  --category <name>   only one category: ${CATEGORY_ORDER.join(', ')}
  --no-detect         editorial only — resolve no state chips at all (instant)
  --json              emit the directory plus resolved state chips

Examples:
  ak about                        the whole directory, grouped by category
  ak about ruflo                  one entry
  ak about --category hosts       just the agent CLIs
  ak about --no-detect            the authored copy alone, no detection at all
  ak about --json                 machine-readable directory + state`;

// The directory exports no category headings on purpose: section copy belongs to
// the page that renders it, not to the shared data. These are the terminal's.
const CATEGORY_LABELS = Object.freeze({
  hosts: 'Hosts — the agents you talk to',
  'engine-memory': 'Engine and memory — what runs underneath',
  quality: 'Quality — proving the work is done',
  safety: 'Safety — checking untrusted text',
  knowledge: 'Knowledge — grounded answers about this stack',
  kit: 'The kit itself',
  configured: 'Configured for you — surfaces ak sets up',
});

const installed = (version, note = null) => ({ state: 'installed', version: version ?? null, note });
const absent = () => ({ state: 'absent', version: null, note: null });
const configured = () => ({ state: 'configured', version: null, note: null });
const attention = (note) => ({ state: 'attention', version: null, note: String(note) });
const unknown = (why) => ({ state: 'unknown', version: null, note: String(why) });
// Distinct from `unknown`: nothing failed here, the user asked for no detection.
// Sharing the chip would flag all fifteen entries as if something were wrong.
const skipped = () => ({ state: 'skipped', version: null, note: 'detection skipped (--no-detect)' });

const reasonOf = (error) => String(error?.message ?? error);

/**
 * State chips for the packaged entries, from the primitives `ak status` already
 * calls. Each source is guarded independently so one unavailable collector
 * degrades one chip, never the page. Network-free by construction: every call
 * here reads the filesystem or resolves a binary — the drift/latest-version
 * lookups that DO reach npm are deliberately not consulted, because "is it
 * installed" is a local question and About asks nothing else.
 *
 * @param {{ pkgRoot?: string }} input
 * @returns {Promise<Map<string, { state: string, version: string|null, note: string|null }>>}
 */
async function detectPackaged({ pkgRoot }) {
  const states = new Map();

  try {
    const { HOSTS, hostInstallState } = await import('../lib/providers.mjs');
    for (const host of HOSTS) {
      try {
        const state = await hostInstallState(host);
        states.set(`hosts.${host.id}`, state.method === 'absent'
          ? absent()
          // An externally-installed host (mise, brew, a native installer) is
          // present and ak says so — while naming the owner, because ak does
          // not manage its updates (MANAGED-TOOLS "honest disowning").
          : installed(state.version,
            state.method === 'external' ? 'external install — self-managed' : null));
      } catch (error) {
        states.set(`hosts.${host.id}`, unknown(reasonOf(error)));
      }
    }
  } catch (error) {
    for (const id of ['claude', 'codex', 'opencode']) states.set(`hosts.${id}`, unknown(reasonOf(error)));
  }

  const { installedVersion, KIT_PKG } = await import('../lib/versions.mjs');
  for (const [key, pkg] of [['ruflo', 'ruflo'], ['agentic-qe', 'agentic-qe']]) {
    try {
      const version = installedVersion(pkg);
      states.set(key, version ? installed(version) : absent());
    } catch (error) {
      states.set(key, unknown(reasonOf(error)));
    }
  }

  try {
    const { coherence } = await import('../lib/agentdb.mjs');
    const c = coherence();
    states.set('agentdb', c.present ? installed(c.global) : absent());
  } catch (error) {
    states.set('agentdb', unknown(reasonOf(error)));
  }

  // aidefence and @claude-flow/security are nested under global ruflo, not
  // global packages, so there is no version to read — presence is the whole
  // fact ak has. Reporting the pair separately matters: security-without-
  // aidefence is the state in which `security defend` silently does nothing.
  try {
    const { aidefencePresent, securityPresent } = await import('../lib/natives.mjs');
    const security = securityPresent();
    if (security && aidefencePresent()) states.set('security', installed(null));
    else if (security) states.set('security', attention('@claude-flow/security present, aidefence missing'));
    else states.set('security', absent());
  } catch (error) {
    states.set('security', unknown(reasonOf(error)));
  }

  try {
    const brain = await import('../lib/ruvnet-brain.mjs');
    states.set('ruvnet-brain', brain.present() ? installed(brain.installedVersion()) : absent());
  } catch (error) {
    states.set('ruvnet-brain', unknown(reasonOf(error)));
  }

  // The kit's own version: the globally installed copy when there is one, else
  // the running checkout's manifest — the same order collectInstall resolves
  // `self` in, so a linked dev install reports a version rather than "absent".
  try {
    let version = installedVersion(KIT_PKG);
    if (!version && pkgRoot) {
      const [{ readFileSync }, { default: path }] = await Promise.all([
        import('node:fs'), import('node:path'),
      ]);
      version = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version ?? null;
    }
    states.set('self', version ? installed(version) : absent());
  } catch (error) {
    states.set('self', unknown(reasonOf(error)));
  }

  return states;
}

/**
 * State chips for the configured surfaces, joined from `ak status` rows exactly
 * as the dashboard joins them from /api/status. A subsystem that emits NO row is
 * unknown, never `configured`: an unjoined key is an unmeasured fact, not a
 * satisfied one (the permission allowlist is in that position today).
 */
function detectConfigured(rows) {
  const bySubsystem = new Map();
  for (const row of rows) {
    if (!bySubsystem.has(row.subsystem)) bySubsystem.set(row.subsystem, []);
    bySubsystem.get(row.subsystem).push(row);
  }
  return (subsystem) => {
    const matched = bySubsystem.get(subsystem);
    if (!matched?.length) return unknown(`ak status emits no '${subsystem}' row`);
    const bad = matched.find((row) => row.level === 'fail') ?? matched.find((row) => row.level === 'warn');
    return bad ? attention(bad.message) : configured();
  };
}

/** The chip's rendered text. `installed` without a version is a real state —
 *  some components are nested packages with no manifest ak may read. */
function chipText(state) {
  if (state.state === 'installed') return state.version ? `installed · v${state.version}` : 'installed';
  if (state.state === 'absent') return 'not installed — ak setup adds it';
  if (state.state === 'configured') return 'configured';
  if (state.state === 'attention') return 'needs attention';
  if (state.state === 'skipped') return 'state not resolved — detection skipped';
  return `state unknown — ${state.note}`;
}

const chipLevel = (state) => (state.state === 'installed' || state.state === 'configured' ? 'ok'
  : state.state === 'attention' || state.state === 'unknown' ? 'warn' : 'none');

function paint(state, text) {
  const level = chipLevel(state);
  if (level === 'ok') return green(text);
  if (level === 'warn') return yellow(text);
  return dim(text);
}

/** Greedy wrap. Long tokens (URLs) are never broken — a split URL is unusable. */
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function renderEntry(entry, state, width) {
  const indent = '      ';
  const body = Math.max(40, width - indent.length);
  console.log(`  ${glyph(chipLevel(state))} ${bold(entry.name)}  ${paint(state, chipText(state))}`);
  console.log(`${indent}${dim(entry.tagline)}`);
  for (const line of wrap(entry.paragraph, body)) console.log(`${indent}${line}`);
  for (const link of entry.links) console.log(`${indent}${dim(link.label.padEnd(6))} ${link.url}`);
  if (entry.manage) console.log(`${indent}${dim('manage'.padEnd(6))} ${entry.manage}`);
  console.log('');
}

/**
 * @param {{ flags: Record<string, any>, positionals: string[], pkgRoot?: string,
 *           deps?: { collectStatus?: Function, cwd?: string } }} input
 */
export async function run({ flags, positionals, pkgRoot, deps = {} }) {
  const wanted = positionals[0];
  // The directory is a frozen literal, so its inferred type is a union of 15
  // distinct shapes and `entry.subsystem` is only on some of them. Widening here
  // keeps the field access honest at runtime (a missing key is `undefined`,
  // which is exactly the packaged/configured discriminator) without weakening
  // any type the directory itself publishes.
  /** @type {Array<Record<string, any>>} */
  const entries = directoryEntries().filter((entry) => (
    (!wanted || entry.id === wanted) && (!flags.category || entry.category === flags.category)
  ));

  if (!entries.length) {
    const what = [wanted && `id '${wanted}'`, flags.category && `category '${flags.category}'`]
      .filter(Boolean).join(' and ');
    console.log(`${glyph('warn')} no directory entry matches ${what}`);
    console.log(dim(`ids: ${directoryEntries().map((entry) => entry.id).join(', ')}`));
    return 2;
  }

  const states = new Map();
  if (flags['no-detect']) {
    for (const entry of entries) states.set(entry.id, skipped());
  } else {
    const packaged = await detectPackaged({ pkgRoot });
    // One `ak status` collect for every configured chip. Skipped entirely when
    // no configured entry survived the filter, so `ak about ruflo` stays cheap.
    /** @type {(subsystem: string) => { state: string, version: string|null, note: string|null }} */
    let configuredState = () => unknown('status collection not run');
    if (entries.some((entry) => entry.subsystem)) {
      try {
        const collectStatus = deps.collectStatus
          ?? (await import('./status.mjs')).collect;
        configuredState = detectConfigured(await collectStatus({ pkgRoot, cwd: deps.cwd ?? process.cwd() }));
      } catch (error) {
        const why = reasonOf(error);
        configuredState = () => unknown(why);
      }
    }
    for (const entry of entries) {
      states.set(entry.id, entry.subsystem
        ? configuredState(entry.subsystem)
        : packaged.get(entry.detectionKey) ?? unknown(`no detection source for '${entry.detectionKey}'`));
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      detection: !flags['no-detect'],
      entries: entries.map((entry) => ({ ...entry, state: states.get(entry.id) })),
    }, null, 2));
    return 0;
  }

  const width = Math.max(60, Math.min(100, process.stdout.columns || 80));
  heading('ak about — what agentic-kit installs and configures');
  console.log(dim('  purpose is authored; presence is measured — only the chip claims runtime state'));

  for (const category of CATEGORY_ORDER) {
    const inCategory = entries.filter((entry) => entry.category === category);
    if (!inCategory.length) continue;
    heading(CATEGORY_LABELS[category] ?? category);
    console.log('');
    for (const entry of inCategory) renderEntry(entry, states.get(entry.id), width);
  }
  return 0;
}
