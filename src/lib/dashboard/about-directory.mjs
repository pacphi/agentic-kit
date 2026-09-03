// The About area's component directory: the authored editorial identity of every
// component agentic-kit installs or configures (ADR-0026 / docs/ddd/component-directory.md).
//
// THE EDITORIAL/DETECTION SPLIT is why this module exists and why it is pure data.
// Editorial content — tagline, paragraph, links, icon, category, order — is authored,
// reviewed, and versioned WITH THE RELEASE. Detection facts — installed, version,
// install method, configured — are observed at render by collectors that already exist
// (/api/status rows, the drift array, the managed-tools machinery). The directory owns
// only the first kind and joins the second client-side; it probes nothing, fetches
// nothing, and adds no endpoint. Importing this module must therefore have zero side
// effects so a unit test can assert the whole catalog without a machine to measure.
//
// PROSE NEVER CLAIMS RUNTIME STATE. "Installed", "running", "healthy" are chip words fed
// by detection. Every paragraph below reads true on a machine where the component is
// absent — that is the structural guarantee behind the state chip, not a style
// preference: if copy could assert presence, a stale sentence would contradict an honest
// chip on the same card. Purpose is timeless; presence is measured.
//
// The register contract governing this copy (one paragraph, ~50 words, plain language,
// active voice, no superlatives, no runtime claims) is specified in the DDD doc.

/** Curated, stable reading order. Never derived from popularity, size, or health:
 *  the things a new user already recognizes come first, infrastructure after, and the
 *  kit's own card sits near the end because it is the caretaker, not the point. */
export const CATEGORY_ORDER = Object.freeze([
  'hosts', 'engine-memory', 'quality', 'safety', 'knowledge', 'kit', 'configured',
]);

// Official marks are reused BYTE-IDENTICALLY from the marks the dashboard already ships
// for Observability's session rows (`hostIcon()` in live/client.mjs, `sourceHostIcon()`
// in client.mjs), which dispatch on these exact host ids. Only the three hosts have a
// genuinely official, already-shipped mark; everything else is an explicit monogram
// tile — initials on a category hue — because a fabricated logo would misrepresent a
// project we do not speak for. `hue` names a CSS custom property the About stylesheet
// defines; the directory names the token, it does not pick the colour.
const OFFICIAL = (ref) => Object.freeze({ kind: 'official', ref });
const MONOGRAM = (ref, hue) => Object.freeze({ kind: 'monogram', ref, hue });

const link = (kind, label, url) => Object.freeze({ kind, label, url });

// detectionKey joins a packaged entry to the managed-tools detection facts. The keys are
// heterogeneous because the facts are: hosts resolve through the host registry
// (`hosts.<id>`), agentdb / agentic-qe / ruvnet-brain have their own `ak status`
// subsystem row, aidefence is reported by the `security` row, and the kit reports as
// `self`. `npmPackage` is carried alongside because the version chip's other source —
// the drift array — is keyed by package name, and deriving that from a link URL would be
// a parsing trick rather than a stated fact. Configured surfaces have no detectionKey:
// they are not packages, so they carry the status `subsystem` row their chip joins on
// plus the `manage` command that changes them. `subsystem` names the row a chip SHOULD
// join; where no such row is emitted yet the chip must degrade to `unknown` rather than
// assume `configured` — an unjoined key is an unmeasured fact, not a satisfied one.
const ENTRIES = Object.freeze([
  Object.freeze({
    id: 'claude-code',
    category: 'hosts',
    name: 'Claude Code',
    tagline: "Anthropic's coding agent, in your terminal.",
    paragraph:
      'Point it at a repository and talk to it: it reads your code, proposes and makes '
      + 'changes, runs your tests, and explains each step as it goes. It is one of the '
      + 'agent CLIs — coding assistants that live in your terminal — the rest of this '
      + 'toolkit exists to strengthen.',
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/anthropics/claude-code'),
      link('npm', 'npm', 'https://www.npmjs.com/package/@anthropic-ai/claude-code'),
      link('docs', 'Docs', 'https://docs.claude.com/en/docs/claude-code/overview'),
    ]),
    icon: OFFICIAL('claude'),
    detectionKey: 'hosts.claude',
    npmPackage: '@anthropic-ai/claude-code',
  }),
  Object.freeze({
    id: 'codex',
    category: 'hosts',
    name: 'Codex',
    tagline: "OpenAI's coding agent — a second pair of eyes.",
    paragraph:
      "OpenAI's take on the same idea: an agent that works alongside you in the terminal "
      + 'on real repositories. When both it and Claude Code are enabled, agentic-kit runs '
      + "them as peers — either can lead a job, review the other's output, or pick up a "
      + 'step the other stalled on.',
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/openai/codex'),
      link('npm', 'npm', 'https://www.npmjs.com/package/@openai/codex'),
      link('docs', 'Docs', 'https://developers.openai.com/codex/cli'),
    ]),
    icon: OFFICIAL('codex'),
    detectionKey: 'hosts.codex',
    npmPackage: '@openai/codex',
  }),
  Object.freeze({
    id: 'opencode',
    category: 'hosts',
    name: 'OpenCode',
    tagline: 'An open-source coding agent, run as a worker.',
    paragraph:
      'A community-built agent CLI from the OpenCode project. agentic-kit treats it as an '
      + 'opt-in worker: you route particular jobs to it by name, its sessions appear '
      + 'alongside the others in Observability, and it never takes the lead on a job '
      + 'unless you say so.',
    links: Object.freeze([
      // The upstream repository moved from sst/opencode; github.com/sst/opencode still
      // resolves only by redirect, so the canonical owner is named here directly.
      link('github', 'GitHub', 'https://github.com/anomalyco/opencode'),
      link('npm', 'npm', 'https://www.npmjs.com/package/opencode-ai'),
      link('docs', 'Docs', 'https://opencode.ai/docs/'),
    ]),
    icon: OFFICIAL('opencode'),
    detectionKey: 'hosts.opencode',
    npmPackage: 'opencode-ai',
  }),
  Object.freeze({
    id: 'ruflo',
    category: 'engine-memory',
    name: 'ruflo',
    tagline: 'The orchestration engine under your agents.',
    paragraph:
      'Gives your agents what a single session cannot: decisions remembered across '
      + "restarts, teams of specialist agents working one task in parallel (a 'swarm'), "
      + 'hooks that send each job to the agent suited to it, and security checks along '
      + 'the way. agentic-kit installs it and keeps it healthy.',
    links: Object.freeze([
      // The upstream repository was renamed from ruvnet/claude-flow; npm still records
      // the old URL, so the canonical name is stated here rather than derived.
      link('github', 'GitHub', 'https://github.com/ruvnet/ruflo'),
      link('npm', 'npm', 'https://www.npmjs.com/package/ruflo'),
      link('docs', 'Docs', 'https://github.com/ruvnet/ruflo/tree/main/docs'),
    ]),
    icon: MONOGRAM('rf', '--hue-engine'),
    detectionKey: 'ruflo',
    npmPackage: 'ruflo',
  }),
  Object.freeze({
    id: 'agent-browser',
    category: 'engine-memory',
    name: 'agent-browser',
    tagline: 'Ruflo browser automation without another plugin catalog.',
    paragraph:
      'Ruflo\'s shipped browser tools use this native command to open pages, inspect them, '
      + 'and run browser actions. agentic-kit pins the Ruflo-compatible release, verifies '
      + 'its native executable, and confines its configuration to managed MCP processes. '
      + 'It will be retired only when a released Ruflo build actually switches to Servo.',
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/vercel-labs/agent-browser'),
      link('npm', 'npm', 'https://www.npmjs.com/package/agent-browser'),
      link('docs', 'Docs', 'https://agent-browser.dev/'),
    ]),
    icon: MONOGRAM('ab', '--hue-engine'),
    detectionKey: 'agent-browser',
    npmPackage: 'agent-browser',
  }),
  Object.freeze({
    id: 'agentdb',
    category: 'engine-memory',
    name: 'agentdb',
    tagline: 'Where what your agents learn is stored.',
    paragraph:
      'The store behind that memory: a single local file holding what agents recorded — '
      + 'decisions, state, and the reasons behind them — searchable by meaning as well as '
      + 'by keyword, with the links between entries kept too. agentic-kit pins its version '
      + 'to the one ruflo ships, so the two cannot drift apart.',
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/ruvnet/agentdb'),
      link('npm', 'npm', 'https://www.npmjs.com/package/agentdb'),
      link('docs', 'Docs', 'https://github.com/ruvnet/agentdb/tree/main/docs'),
    ]),
    icon: MONOGRAM('db', '--hue-engine'),
    detectionKey: 'agentdb',
    npmPackage: 'agentdb',
  }),
  Object.freeze({
    id: 'deja-vu',
    category: 'engine-memory',
    name: 'deja-vu',
    tagline: 'Searchable local history for your coding agents.',
    paragraph:
      'Session histories from supported coding agents become a local, searchable archive through '
      + 'deja-vu. It helps you find earlier decisions, revisit approaches, and carry context '
      + 'between tools without treating that archive as curated project memory. Agentic-kit '
      + 'keeps the integration opt-in and separates its index from the source histories it reads.',
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/vshulcz/deja-vu'),
      link('npm', 'npm', 'https://www.npmjs.com/package/@vshulcz/deja-vu'),
      link('docs', 'Docs', 'https://github.com/vshulcz/deja-vu/tree/v0.19.0/docs'),
    ]),
    icon: MONOGRAM('dv', '--hue-engine'),
    detectionKey: 'deja-vu',
    npmPackage: '@vshulcz/deja-vu',
  }),
  Object.freeze({
    id: 'agentic-qe',
    category: 'quality',
    name: 'agentic-qe',
    tagline: 'A quality-engineering fleet you can call on.',
    paragraph:
      "Specialist agents for the unglamorous half of shipping: writing tests in your "
      + "project's own framework, finding which untested code carries the most risk, "
      + 'spotting tests that pass and fail at random, and gating a change on those '
      + "results. 'The agent says it works' becomes something you can check.",
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/proffesor-for-testing/agentic-qe'),
      link('npm', 'npm', 'https://www.npmjs.com/package/agentic-qe'),
      link('docs', 'Docs', 'https://github.com/proffesor-for-testing/agentic-qe#readme'),
    ]),
    icon: MONOGRAM('qe', '--hue-quality'),
    detectionKey: 'agentic-qe',
    npmPackage: 'agentic-qe',
  }),
  Object.freeze({
    id: 'aidefence',
    category: 'safety',
    name: 'aidefence + security',
    tagline: 'Checks untrusted text before your agents act on it.',
    paragraph:
      "A pasted issue, a fetched web page, a stranger's README — any of them can carry "
      + "instructions aimed at your agent rather than at you ('prompt injection'). "
      + 'aidefence scans text for those patterns, for jailbreak attempts, and for exposed '
      + 'personal data; @claude-flow/security supplies the primitives ruflo\'s security '
      + 'commands are built on.',
    links: Object.freeze([
      link('github', 'GitHub',
        'https://github.com/ruvnet/ruflo/tree/main/v3/@claude-flow/aidefence'),
      link('npm', 'npm', 'https://www.npmjs.com/package/@claude-flow/aidefence'),
      // No upstream doc site exists for these two packages; ak's own troubleshooting
      // page is the honest "where to read more", not a stand-in for one.
      link('docs', 'Docs',
        'https://github.com/pacphi/agentic-kit/blob/main/docs/TROUBLESHOOTING.md'),
    ]),
    icon: MONOGRAM('ad', '--hue-safety'),
    detectionKey: 'security',
    npmPackage: '@claude-flow/aidefence',
  }),
  Object.freeze({
    id: 'ruvnet-brain',
    category: 'knowledge',
    name: 'RuvNet Brain',
    tagline: 'Answers about this stack, from its real source.',
    paragraph:
      "These tools change faster than any model's training data, so an agent asked about "
      + 'them tends to guess. The Brain is a local knowledge base built from those '
      + "projects' real source, and it answers with the file path each answer came from — "
      + 'so you can check the claim yourself.',
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/stuinfla/ruvnet-brain'),
      link('npm', 'npm', 'https://www.npmjs.com/package/ruvnet-brain'),
      link('docs', 'Docs', 'https://isovision.ai/ruvnet-brain/'),
    ]),
    icon: MONOGRAM('B', '--hue-knowledge'),
    detectionKey: 'ruvnet-brain',
    npmPackage: 'ruvnet-brain',
  }),
  Object.freeze({
    id: 'agentic-kit',
    category: 'kit',
    name: 'agentic-kit',
    tagline: 'The caretaker for everything above.',
    paragraph:
      'One command sets this collection up, one command repairs it after an upgrade moves '
      + 'something, and this dashboard shows what all of it is doing. When a piece drifts '
      + 'from the version it should be on, breaks, or disappears, ak names the problem and '
      + 'the command that fixes it.',
    links: Object.freeze([
      link('github', 'GitHub', 'https://github.com/pacphi/agentic-kit'),
      link('npm', 'npm', 'https://www.npmjs.com/package/@pacphi/agentic-kit'),
      link('docs', 'Docs', 'https://github.com/pacphi/agentic-kit/tree/main/docs'),
    ]),
    icon: MONOGRAM('ak', '--hue-kit'),
    detectionKey: 'self',
    npmPackage: '@pacphi/agentic-kit',
  }),
  Object.freeze({
    id: 'mcp-registrations',
    category: 'configured',
    name: 'MCP registrations',
    tagline: 'Your tools, plugged in once for every project.',
    paragraph:
      'Agents reach outside tools through MCP, the plug-in protocol for AI tooling. ak '
      + "registers this stack's MCP servers once at your user level, so every repository "
      + 'you open gets them without per-project setup, and lets you switch off tool groups '
      + 'you would rather not have. Run `ak x mcp pick` to change it.',
    links: Object.freeze([]),
    icon: MONOGRAM('M', '--info'),
    subsystem: 'mcp',
    manage: 'ak x mcp pick',
  }),
  Object.freeze({
    id: 'guidance-blocks',
    category: 'configured',
    name: 'Guidance blocks',
    tagline: 'House rules your agents read at startup.',
    paragraph:
      'Short managed sections inside CLAUDE.md and AGENTS.md that tell each agent how this '
      + 'stack fits together and which tool to reach for. ak writes only between its own '
      + 'markers, so anything you wrote stays untouched, and refreshes the text as the '
      + 'tools change. Run `ak sync` to reapply it.',
    links: Object.freeze([]),
    icon: MONOGRAM('G', '--info'),
    subsystem: 'blocks',
    manage: 'ak sync',
  }),
  Object.freeze({
    id: 'statuslines',
    category: 'configured',
    name: 'Statuslines',
    tagline: 'A live footer showing what a session costs.',
    paragraph:
      'A footer line inside Claude Code and Codex showing the model in use, what the '
      + "session has spent so far, and how much of your plan's limit is left — so cost "
      + 'stays visible while you work instead of arriving later. Run `ak sync` when an '
      + 'upgrade wipes it.',
    links: Object.freeze([]),
    icon: MONOGRAM('S', '--info'),
    subsystem: 'statusline',
    manage: 'ak sync',
  }),
  Object.freeze({
    id: 'dual-host-routing',
    category: 'configured',
    name: 'Dual-host routing & shared tools',
    tagline: 'Each kind of work goes to the better host.',
    paragraph:
      'With Claude Code and Codex both enabled, ak records which host handles which kind '
      + 'of work — coding, testing, review, security — and gives both hosts the same '
      + 'Ruflo/AQE tools. Bounded `ak run` workers hand work across hosts. You pick the table and '
      + 'which host leads: `ak host pick`.',
    links: Object.freeze([]),
    icon: MONOGRAM('R', '--info'),
    subsystem: 'routing',
    manage: 'ak host pick',
  }),
  Object.freeze({
    id: 'background-daemon',
    category: 'configured',
    name: 'Background daemon',
    tagline: 'Local workers that keep things tidy between sessions.',
    paragraph:
      'A background process ruflo runs between your sessions for upkeep — learning from '
      + 'finished work, tidying up — staffed by local workers that cost nothing. Anything '
      + 'that would spend money on a model stays opt-in, and each daemon expires on its '
      + 'own. List or stop them with `ak x daemon-gc`.',
    links: Object.freeze([]),
    icon: MONOGRAM('D', '--info'),
    subsystem: 'daemons',
    manage: 'ak x daemon-gc',
  }),
  Object.freeze({
    id: 'permission-allowlist',
    category: 'configured',
    name: 'Permission allowlist',
    tagline: 'Fewer prompts for the tools you already trust.',
    paragraph:
      "Pre-approved command patterns for this stack's own tools, so routine calls stop "
      + 'asking your permission every time. Every rule is shown to you during setup and '
      + "written into your project's settings file, and ak strips out any rule it finds "
      + 'there that it never disclosed. Run `ak setup` to review them.',
    links: Object.freeze([]),
    icon: MONOGRAM('P', '--info'),
    // `ak status` emits no `permissions` row today; until one exists this chip reads
    // unknown. Naming the row it would join is the honest placeholder — inventing a
    // green `configured` for an unmeasured surface is the failure this avoids.
    subsystem: 'permissions',
    manage: 'ak setup',
  }),
]);

/** The whole directory in curated order. Frozen: a card renderer reads it, a parity test
 *  asserts over it, and neither may edit the release's authored copy in place. */
export function directoryEntries() {
  return ENTRIES;
}

/** One entry by its stable id, or null — never a partial object, so a caller that
 *  mistypes an id gets an obvious absence rather than a card with empty prose. */
export function entryById(id) {
  return ENTRIES.find((e) => e.id === id) || null;
}

/** Entries in one category, in curated order; an unknown category yields []. */
export function entriesByCategory(category) {
  return ENTRIES.filter((e) => e.category === category);
}
