// usage-provenance — WHO wrote a prompt-kind turn. One closed vocabulary; every
// rule is a recorded judgment call pinned here. The risk stance is
// one-directional by design: an unrecognized machine template must fall through
// to 'human' (over-count the human, never under-count them), so the
// "unmatched → human" cases below are load-bearing, not filler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVENANCE_TAGS, provenanceOf } from '../../src/lib/usage-provenance.mjs';

test('PROVENANCE_TAGS is the closed vocabulary the view renders', () => {
  assert.deepEqual(PROVENANCE_TAGS, ['human', 'control', 'agent', 'adapter']);
});

test('agent: cross-session and teammate delivery envelopes', () => {
  assert.equal(
    provenanceOf('Another Claude session sent a message: <teammate-message teammate_id="architect">go</teammate-message>'),
    'agent',
  );
  assert.equal(provenanceOf('<teammate-message teammate_id="coder" summary="W1">do it</teammate-message>'), 'agent');
});

test('adapter: tool-authored headless templates', () => {
  assert.equal(
    provenanceOf('Review this change for security vulnerabilities.\n\nChanged files (you may Read them):\n- src/a.mjs'),
    'adapter',
  );
  assert.equal(
    provenanceOf('Read-only qe-court participant transport probe 1; seat=convener; leader=claude.'),
    'adapter',
  );
  assert.equal(
    provenanceOf('Read the dependency handoff only. Make no tool calls and no file changes.'),
    'adapter',
  );
  assert.equal(
    provenanceOf('<!-- generated-by: agentic-kit — invocation-only worker template -->\n\nYou are an agentic-kit managed OpenCode execution worker.'),
    'adapter',
  );
});

test('control: person-initiated turns that are not typed instructions', () => {
  assert.equal(provenanceOf('<command-name>/clear</command-name>\n<command-message>clear</command-message>'), 'control');
  assert.equal(provenanceOf('<command-message>loop</command-message>\n<command-name>/loop</command-name>'), 'control');
  assert.equal(provenanceOf('[Request interrupted by user]'), 'control');
  assert.equal(provenanceOf('[Request interrupted by user for tool use]'), 'control');
  assert.equal(provenanceOf('<bash-input>git checkout main && git pull</bash-input>'), 'control');
  assert.equal(provenanceOf('[Image #1]'), 'control');
  // Resuming a compacted session: the person asked for it, the sentence is the
  // harness's. 17 such turns reach kind 'prompt' on the reference corpus.
  assert.equal(
    provenanceOf('This session is being continued from a previous conversation that ran out of context.'),
    'control',
  );
});

// The evidence standard, pinned as behaviour: a shape measured at ZERO gets no
// rule, even when it looks like a sibling of one that does. `<command-args>`
// never opens a turn (it only ever follows command-name/-message inside one,
// which the anchored rule above already covers), so it must fall through — the
// same standard that kept the two unobserved qe-court patterns out.
test('an unevidenced sibling shape is NOT special-cased', () => {
  assert.equal(provenanceOf('<command-args>--force</command-args>'), 'human');
  assert.equal(
    provenanceOf('<command-name>/loop</command-name>\n<command-args>5m</command-args>'),
    'control',
    'the real shape is still caught by its opener',
  );
});

// Measured ZERO reaching kind 'prompt', so deliberately not rules. Pinned so a
// future reader sees the omission is a decision, not an oversight.
test('shapes measured at zero stay human rather than being guessed at', () => {
  assert.equal(provenanceOf('<system-reminder>do not forget</system-reminder>'), 'human');
  assert.equal(provenanceOf('Please continue the conversation from where we left it off'), 'human');
});

test('an attachment-only prompt turn is control, but only when the KIND says it was a prompt', () => {
  // claudeText renders an image block as '[image]', so a genuinely text-less
  // turn only reaches here from a source that carries no text at all. Without
  // the kind evidence there is nothing to say it was a person acting, so the
  // conservative default applies.
  assert.equal(provenanceOf('   ', { kind: 'prompt' }), 'control');
  assert.equal(provenanceOf('', { kind: 'prompt' }), 'control');
  assert.equal(provenanceOf(''), 'human', 'no kind evidence → the conservative default');
});

test('human: anything the rules do not recognize', () => {
  assert.equal(provenanceOf('why is the build failing on macos?'), 'human');
  assert.equal(provenanceOf('/code-review high'), 'human', 'a slash command TYPED as text is still the person instructing');
  assert.equal(provenanceOf('ship it'), 'human');
  // The one-directional stance, stated as a test: an unrecognized machine
  // template counts as human rather than being silently attributed away.
  assert.equal(provenanceOf('[[unrecognized-harness-shape]] do the thing'), 'human');
});

test('rules are anchored: a marker quoted mid-prompt does not reclassify the turn', () => {
  assert.equal(
    provenanceOf('Please explain why "Another Claude session sent a message:" shows up in my transcripts'),
    'human',
  );
  assert.equal(provenanceOf('grep for <bash-input> in the parser'), 'human');
});

test('non-string input is human, never a throw', () => {
  assert.equal(provenanceOf(null), 'human');
  assert.equal(provenanceOf(undefined), 'human');
  assert.equal(provenanceOf(42), 'human');
});

test('every rule returns a member of the closed vocabulary', () => {
  const samples = [
    'Another Claude session sent a message: x', '<teammate-message a="b">x</teammate-message>',
    'Review this change for security vulnerabilities.', 'Read-only qe-court participant transport probe 1;',
    'Read the dependency handoff only.', '<!-- generated-by: agentic-kit -->',
    '<command-name>/x</command-name>', '[Request interrupted by user]', '<bash-input>ls</bash-input>',
    '[Image #2]', 'plain prose',
  ];
  for (const s of samples) assert.ok(PROVENANCE_TAGS.includes(provenanceOf(s)), `${s} → ${provenanceOf(s)}`);
});
