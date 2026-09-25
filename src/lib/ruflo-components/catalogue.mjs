// ADR-0058: the one list of ruflo components ak manages. Every surface reads this.
const c = (id, label, minRuflo, scope, explain, extra = {}) =>
  Object.freeze({ id, label, minRuflo, scope, explain: Object.freeze(explain), ...extra });

export const COMPONENTS = Object.freeze([
  c('typesafePicker', 'Typesafe agent picker', '3.43.0', 'machine', {
    does: 'Chooses which agent handles a task by comparing what the task means with what each agent is for, using @ruvector/typesafe.',
    benefit: 'Fewer misroutes from spelling matches such as "latest" going to the tester; it abstains when unsure and falls back.',
    cost: 'One global npm package; a few milliseconds per prompt. Ruflo has not yet made it the default.',
    change: 'Set rufloComponents.typesafePicker to false in kit.json, then run ak sync.',
  }),
  c('minilmPicker', 'MiniLM agent picker', '3.44.0', 'machine', {
    does: 'Lets ruflo\'s semantic picker use the MiniLM language model it already ships for memory search.',
    benefit: 'Routes by meaning instead of word fragments.',
    cost: 'About 5 ms per prompt and a one-time 0.3 s model load. Ruflo has not yet made it the default.',
    change: 'Set rufloComponents.minilmPicker to false in kit.json, then run ak sync.',
  }),
  c('mcpGovernance', 'MCP tool governance', '3.42.0', 'project', {
    does: 'Writes .harness/mcp-policy.json (audit on, calls capped per rolling minute) and projects RUFLO_MCP_ENFORCE_POLICY=1 for the project. Ruflo 3.44.0 and earlier do not yet apply the policy on the stdio MCP launches Claude Code, Codex and OpenCode use (upstream request 6).',
    benefit: 'Ready when ruflo wires enforcement: then an audit trail of which ruflo tools ran, and a stop for runaway loops.',
    cost: 'A small file in each ruflo repository; once ruflo enforces it, calls beyond the cap are refused until the minute rolls over.',
    change: 'Set rufloComponents.mcpGovernance to false, or change maxCallsPerMinute, then run ak sync.',
  }),
  c('learningProfile', 'Learning profile', '3.42.1', 'machine', {
    does: 'Sets the SONA learning profile every ruflo session uses by default (RUFLO_INTELLIGENCE_MODE).',
    benefit: 'One explicit, visible setting instead of an implicit default.',
    cost: 'Higher profiles use more time and memory per learning step; the engine must be loaded for any profile to matter.',
    change: 'Set rufloComponents.learningProfile to real-time, balanced, research, edge or batch, then run ak sync.',
  }, { options: Object.freeze([
    { value: 'real-time', detail: '0.5 ms per step, 25 MB, LoRA rank 2' },
    { value: 'balanced', detail: '18 ms per step, 50 MB, LoRA rank 4 (ruflo default)' },
    { value: 'research', detail: '100 ms per step, 100 MB, LoRA rank 16 (most capacity)' },
    { value: 'edge', detail: '1 ms per step, 5 MB, LoRA rank 1' },
    { value: 'batch', detail: '50 ms per step, 75 MB, LoRA rank 8' },
  ]) }),
  c('turnCredit', 'MetaHarness turn-credit', '3.36.0', 'none', {
    does: 'Ruflo bundles @metaharness/turn-credit; ak confirms it is present and loadable.',
    benefit: 'Turn-level credit assignment for MetaHarness scoring works without extra setup.',
    cost: 'None; ruflo installs it.',
    change: 'Set rufloComponents.turnCredit to false to stop reporting it.',
  }),
  c('memoryFix2887', 'Memory durability fix (#2887)', '3.36.0', 'none', {
    does: 'Confirms @claude-flow/memory is at least 3.0.0-alpha.22, which stops hierarchical memory writes from reporting success when nothing was saved.',
    benefit: 'Memory writes that claim success are really stored.',
    cost: 'None; ak only checks the version ruflo resolves.',
    change: 'Set rufloComponents.memoryFix2887 to false to stop reporting it.',
  }),
  c('funnel', 'Ruflo funnel (promotions)', null, 'machine', {
    does: 'Turns off ruflo\'s Cognitum tips, enrollment prompts and statusline promotions (ruflo funnel disable).',
    benefit: 'No promotional content in your statusline or CLI output.',
    cost: 'You will not see ruflo\'s educational tips.',
    change: 'Set rufloComponents.funnel to true to let ruflo decide, then run ak sync; it re-enables the funnel only if ak disabled it.',
  }),
  c('encryptionAtRest', 'Encryption at rest', null, 'project', {
    does: 'Keeps ruflo\'s project data encrypted on disk (ADR-0059).',
    benefit: 'Memory and learning data are not readable by other local processes, backups or accidental commits.',
    cost: 'Defined by ADR-0059; ak does not manage it yet.',
    change: 'Nothing to change yet; ADR-0059 will add the setting.',
  }),
]);

export const componentById = (id) => COMPONENTS.find((entry) => entry.id === id);
