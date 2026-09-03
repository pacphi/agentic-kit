// One reviewed lifecycle-script policy for every npm GLOBAL install agentic-kit
// performs. npm 11 accepts --allow-scripts for global installs; depending on
// the npm release and local policy, an unlisted lifecycle may be warned about
// or denied. Passing the reviewed list keeps installation behavior explicit and
// prevents the initial-host path from drifting from the upgrade/heal path.
export const REVIEWED_GLOBAL_INSTALL_SCRIPTS = Object.freeze([
  'ruflo',
  'agentic-qe',
  '@claude-flow/cli',
  'better-sqlite3',
  'hnswlib-node',
  'agentdb',
  'agentic-flow',
  'argon2',
  'onnxruntime-node',
  'sharp',
  'protobufjs',
  '@google/genai',
  'tldjs',
  'vibium',
  // Ruflo's shipped browser MCP shells out to this native CLI. Its postinstall
  // downloads the platform binary and rewires the global shim; npm exit zero
  // alone is not viability evidence, so the dedicated lifecycle also verifies
  // the package-owned binary and its reported version.
  'agent-browser',
  // Claude Code's npm package materializes the platform executable from its
  // postinstall. Without this entry npm can report an installed package while
  // leaving a non-viable `claude` command under strict lifecycle policy.
  '@anthropic-ai/claude-code',
  // OpenCode's npm wrapper also materializes its platform executable in
  // postinstall. The shared policy must cover every managed host whose package
  // declares an install lifecycle, not only the incident that exposed it.
  'opencode-ai',
]);

export const reviewedGlobalInstallScripts = () => REVIEWED_GLOBAL_INSTALL_SCRIPTS.join(',');

export function globalInstallArgs(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new TypeError('global npm install spec is required');
  return ['install', '-g', `--allow-scripts=${reviewedGlobalInstallScripts()}`, spec];
}
