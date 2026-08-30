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
// NO SCHEDULED MACHINERY LIVES HERE. Spec §6.5's opt-in periodic digest is a
// documentation-and-existing-governed-machinery concern (W6); this module
// exposes exactly one on-demand invocation, called only from the CLI's
// `--enrich` path.
import { have, run } from './exec.mjs';
import { HOST_REGISTRY } from './adapters/index.mjs';

/** The one host this v1 seam knows how to invoke. Matches the kit's own id
 *  for Claude Code everywhere else (HOST_ADAPTERS, HOSTS, hostAuthState). */
const CLAUDE_HOST_ID = 'claude';

/** Spawn timeout for one invocation (spec: "spawn with timeout 120s"). */
const INVOKE_TIMEOUT_MS = 120_000;

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
   * One invocation: `<bin> -p <prompt> --output-format text`. The prompt
   * travels as ONE argv element (exec.mjs's `run()` is execFile-based, shell
   * ALWAYS false — see that module's own header — so there is no shell to
   * interpret it) and nothing is written to the child's stdin, so a CLI that
   * only reads its prompt from `-p` never blocks waiting on input that is
   * never coming; `run()`'s own timeout (below) is the backstop either way.
   *
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  async function invoke(prompt) {
    const result = await runFn(bin, ['-p', String(prompt), '--output-format', 'text'], {
      timeout: INVOKE_TIMEOUT_MS,
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
