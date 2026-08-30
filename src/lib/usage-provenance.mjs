// usage-provenance.mjs — WHO wrote a prompt-kind turn (ADR-0039 "Provenance is
// a closed four-tag vocabulary, one-directional by design").
//
// The parsers already answer "is this a user-role turn the harness did not
// write" (usage-parsers' isHumanPrompt/userTurnKind and isCodexHumanMessage).
// That is NOT the same question as "did the maintainer TYPE this": measured on
// this machine's corpus (2026-08-29, 5,527 parser-visible user-role turns),
// only 27.6% were human-typed. The rest is agent-to-agent delivery, tool-
// authored headless templates, and person-initiated control records — all of
// which reach kind 'prompt' and would otherwise be counted as things the
// operator asked for.
//
// One closed vocabulary; every rule below is a recorded judgment call pinned by
// tests, exactly as usage-modes.mjs pins the permission-posture taxonomy.
//
// RESIDUAL RISK IS ONE-DIRECTIONAL BY DESIGN: an unrecognized machine template
// falls through to 'human'. Over-stating what the operator typed is a visible,
// self-correcting error; silently attributing a human prompt to a machine is
// not. Every rule is therefore a NARROW, anchored match on a shape observed in
// the corpus — never a heuristic.
export const PROVENANCE_TAGS = ['human', 'control', 'agent', 'adapter'];

/**
 * Ordered rules; FIRST match wins. Every pattern is anchored at the start of
 * the turn's text, because each of these shapes is an OPENER — a marker quoted
 * mid-prompt is the operator writing about the marker, not the marker itself.
 * Anchored `^\s*` + literal is linear-time (one quantifier, no nesting, no
 * overlapping alternation), so none of these is a ReDoS shape.
 *
 * The counts in the comments are occurrences in the 2026-08-29 corpus survey.
 *
 * @type {ReadonlyArray<[('human'|'control'|'agent'|'adapter'), RegExp]>}
 */
const RULES = [
  // ── agent: machine-authored, delivered INTO a user turn ───────────────────
  // The cross-session delivery prefix Claude Code prepends to a message sent
  // from another session (451 on claude).
  ['agent', /^\s*Another Claude session sent a message:/],
  // The teammate SendMessage delivery envelope, arriving bare (no prefix).
  ['agent', /^\s*<teammate-message/],

  // ── adapter: a tool's OWN headless template, typed by nobody ──────────────
  // The security-guidance plugin's headless review hook opener (974) — by far
  // the largest single machine-authored shape on this machine.
  ['adapter', /^\s*Review this change for security vulnerabilities\./],
  // qe-court's read-only participant transport probe opener (~70).
  ['adapter', /^\s*Read-only qe-court participant transport probe/],
  // qe-court's dependency-handoff probe (20).
  ['adapter', /^\s*Read the dependency handoff only\./],
  // agentic-kit's own managed worker/agent templates, which all carry this
  // provenance header (src/templates/opencode-worker-prompt.md; 2 on opencode).
  ['adapter', /^\s*<!--\s*generated-by:\s*agentic-kit/],

  // ── control: person-initiated, but not a typed instruction ────────────────
  // The interrupt record ("[Request interrupted by user]" and its "for tool
  // use" variant; 162).
  ['control', /^\s*\[Request interrupted by user/],
  // The slash-command RECORD Claude Code writes for an invoked command, in
  // either order (name 107, message 52). The person picked the command — they
  // did not type this XML. `<command-args>` is deliberately NOT here: zero
  // turns open with it anywhere in the measured corpus — it only ever follows
  // one of these two inside the same turn, which the anchor already covers —
  // and an unevidenced pattern is what this module refuses to carry.
  ['control', /^\s*<command-(?:name|message)>/],
  // Bash mode (`! cmd`): the person ran a command, they did not instruct the
  // model (32).
  ['control', /^\s*<bash-input>/],
  // A pasted-image reference with nothing else in the turn (12).
  ['control', /^\s*\[Image #\d+\]\s*$/],
  // Resuming a compacted or continued session. The person asked for that (a
  // `/compact`, a `--continue`); the sentence itself is the harness's, so it is
  // not a typed instruction. Measured 18 turns reaching kind 'prompt' across
  // the full corpus — which is the ENTIRE residue once `in-app-browser-context`
  // joined the harness gate. Sibling shapes stay out on the same evidence
  // standard: `<system-reminder`, "Please continue the conversation…" and the
  // "Caveat:" prose each measured ZERO here (the latter two are `isMeta`).
  ['control', /^\s*This session is being continued from a previous conversation/],
];

/**
 * Which of PROVENANCE_TAGS wrote this prompt-kind turn.
 *
 * `kind` is the parser's own `userTurnKind` classification for the turn. It is
 * load-bearing for exactly one case: a turn with NO text at all. Text alone
 * cannot tell an attachment-only paste apart from a source that failed to yield
 * text, so the control reading requires the parser to have already said this
 * was a prompt turn; without that evidence the conservative default applies.
 *
 * @param {string} text The turn's text, exactly as fingerprinted.
 * @param {{ kind?: string }} [opts]
 * @returns {'human'|'control'|'agent'|'adapter'}
 */
export function provenanceOf(text, { kind } = {}) {
  const t = typeof text === 'string' ? text : '';
  for (const [tag, re] of RULES) if (re.test(t)) return tag;
  // An attachment-only paste: the person acted, but typed nothing.
  if (kind === 'prompt' && !t.trim()) return 'control';
  return 'human';
}
