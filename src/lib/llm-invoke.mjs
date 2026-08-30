// llm-invoke.mjs — the invocation seam (W5 build). Ground truth (verified
// before this module was written): NO LLM-invocation machinery exists
// anywhere else in this kit — providers.mjs is detection/wiring only
// (`have`/`run`/`hostInstallState`, never a spawn that reads a model's
// answer). This is the FIRST inference path in the codebase, so it is kept
// deliberately small: detect the `claude` CLI through the kit's own host
// registry, spawn it for exactly one prompt, and say plainly when it is not
// there. Nothing here decides WHAT to ask — usage-enrich.mjs owns that; this
// module only knows how to ask it.
//
// WHY THE BIN NAME COMES FROM THE REGISTRY, NOT A LITERAL 'claude': the
// kit's own host detection (src/lib/hosts.mjs, and the HOST_REGISTRY it is
// built from in src/lib/adapters/index.mjs) is the single place that already
// knows what binary a host's CLI installs as — `install.bin` on the
// 'claude' entry. Reading it from there means a future rename of that
// binary is a one-line registry edit, not a second hardcoded string to find
// and fix; it is also what makes this module's own tests able to prove "we
// check the registry's name, not a literal" by swapping in a fake registry.
//
// NO SCHEDULED MACHINERY LIVES HERE. The opt-in periodic digest recipe
// (METRICS.md §20) is a documentation-and-existing-governed-machinery
// concern (W6); this module exposes exactly one on-demand invocation,
// called only from the CLI's `--enrich` path.
//
// THE PROMPT CARRIES UNTRUSTED INPUT TO A MODEL. Everything this seam sends
// is derived from transcripts on disk, and a transcript is not a trustworthy
// document: anything that can write one — a malicious MCP server, a shared
// machine, a pasted snippet the operator was induced to repeat — chooses the
// exemplar text verbatim. Masking (`maskSecrets`) covers secret SHAPES; it
// does nothing about INSTRUCTIONS, and nothing here can, because the model
// reads the text either way. So the containment is not "clean the text", it
// is CONFINE THE CHILD — see CONFINEMENT_ARGS below. Any future caller of
// this seam inherits that threat model and must not weaken it.
import os from 'node:os';
import { have, run } from './exec.mjs';
import { HOST_REGISTRY } from './adapters/index.mjs';

/** The one host this v1 seam knows how to invoke. Matches the kit's own id
 *  for Claude Code everywhere else (HOST_ADAPTERS, HOSTS, hostAuthState). */
const CLAUDE_HOST_ID = 'claude';

/** Spawn timeout for one invocation (spec: "spawn with timeout 120s"). */
const INVOKE_TIMEOUT_MS = 120_000;

/** THE CONFINEMENT ARGV (security review SEC-1, CRITICAL — do not drop any of
 *  these, and read the header above before you think about it). This call
 *  needs exactly one thing from the child: text on stdout. It needs no tools,
 *  no MCP servers, and no ability to change anything — so it is given none,
 *  and a prompt injection riding in on exemplar text has nothing to reach.
 *
 *  - `--allowedTools ''`   no tool surface at all.
 *  - `--strict-mcp-config` with no `--mcp-config`, drops EVERY ambient MCP
 *                          server the operator has configured. On a developer
 *                          machine that set routinely includes shell
 *                          execution, HTTP fetch, and mail/drive access.
 *  - `--permission-mode plan`  a non-mutating session, behind the tool gate.
 *  - `--output-format text`    the response contract the engine parses.
 *
 *  `--allowedTools` GOES LAST because it is declared variadic (`<tools...>`):
 *  a flag placed after it risks being consumed as a tool name.
 *
 *  DELIBERATELY NOT `--bare`, though it exists and would also skip hooks and
 *  CLAUDE.md discovery: its own help states that under `--bare` "OAuth and
 *  keychain are never read", which would break the subscription auth path
 *  DESCRIBE_TEXT promises the operator is being billed through. `cwd` below
 *  covers the CLAUDE.md/project-settings half of what it would have bought. */
const CONFINEMENT_ARGS = [
  '--output-format', 'text',
  '--strict-mcp-config',
  '--permission-mode', 'plan',
  '--allowedTools', '',
];

/** How many trailing characters of stderr a thrown error keeps — enough to
 *  carry the actual reason without letting a runaway child's stderr balloon
 *  an error message that gets logged/rendered. */
const STDERR_TAIL_CHARS = 2000;

/** The one-line billing statement `describe()` returns — what invoking this
 *  seam actually costs, stated plainly rather than left for the operator to
 *  infer from a bill later. */
export const DESCRIBE_TEXT = 'Claude Code CLI — your subscription';

/** The one honest line `ak usage prompts --enrich` prints when no invocation
 *  path is available (spec: exits 0, deterministic tiers unaffected — never
 *  a stack trace, never a partial store write). Exported so the CLI and this
 *  module's own tests share exactly one copy of the string. */
export const UNAVAILABLE_MESSAGE = 'enrichment needs the Claude Code CLI; deterministic tiers are unaffected';

/**
 * @param {{ hosts?: ReadonlyArray<{ id: string, install?: { bin?: string } }>,
 *   deps?: { have?: typeof have, run?: typeof run } }} [opts]
 * @returns {Promise<{ invoke: (prompt: string) => Promise<string>, describe: () => string }|null>}
 */
export async function makeInvoke({ hosts = HOST_REGISTRY, deps = {} } = {}) {
  const haveFn = deps.have ?? have;
  const runFn = deps.run ?? run;

  const entry = (hosts ?? []).find((h) => h?.id === CLAUDE_HOST_ID);
  const bin = entry?.install?.bin;
  if (typeof bin !== 'string' || !bin) return null;

  const present = await haveFn(bin);
  if (!present) return null;

  /**
   * One confined invocation: `<bin> -p` plus CONFINEMENT_ARGS, with the prompt
   * on STDIN. Three properties, each load-bearing:
   *
   * - The prompt is ONE stdin payload, never a shell string — `run()` spawns
   *   with shell ALWAYS false (see exec.mjs's header), so there is nothing to
   *   interpret it. Keeping it off argv also keeps it out of the process
   *   table, which is world-readable to local users on Linux (SEC-7).
   * - `cwd` is a scratch directory, NOT the operator's repo. Inheriting the
   *   caller's cwd is what makes the child load that project's
   *   `.claude/settings.local.json` — on this very machine a 16-entry
   *   pre-approved allowlist including `Bash(node -e ' *)` — and its
   *   CLAUDE.md (SEC-1).
   * - `run()`'s timeout reaps the child's whole process GROUP, so a timeout
   *   mid-call cannot leave unsupervised subprocesses behind (SEC-8).
   *
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  async function invoke(prompt) {
    const result = await runFn(bin, ['-p', ...CONFINEMENT_ARGS], {
      timeout: INVOKE_TIMEOUT_MS,
      cwd: os.tmpdir(),
      input: String(prompt),
    });
    if (result.code !== 0) {
      const stderr = String(result.stderr ?? '');
      const tail = stderr.length > STDERR_TAIL_CHARS ? stderr.slice(-STDERR_TAIL_CHARS) : stderr;
      throw new Error(`${bin} exited ${result.code}: ${tail || '(no stderr)'}`);
    }
    return String(result.stdout ?? '').trim();
  }

  function describe() {
    return DESCRIBE_TEXT;
  }

  return { invoke, describe };
}
