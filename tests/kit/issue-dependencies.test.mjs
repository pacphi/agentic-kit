import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlockedBy, planChanges } from '../../scripts/issue-dependencies.mjs';

test('reads the Blocked by line in its bold and plain forms', () => {
  assert.deepEqual(parseBlockedBy('## Dependencies\n**Blocked by:** #12, #4\n**Blocks:** #56'), [4, 12]);
  assert.deepEqual(parseBlockedBy('Blocked by: #7 and #7'), [7]);
  assert.deepEqual(parseBlockedBy('**Blocked by**: #3'), [3]);
});

test('treats None, an absent line and other repositories as no blockers', () => {
  assert.deepEqual(parseBlockedBy('**Blocked by:** None\n**Blocks:** #9'), []);
  assert.deepEqual(parseBlockedBy('**Blocks:** #9'), []);
  assert.deepEqual(parseBlockedBy('**Blocked by:** ruvnet/ruflo#3196'), []);
  assert.deepEqual(parseBlockedBy(null), []);
});

test('plans only the missing links and leaves extra native links unless pruning', () => {
  const cards = [{ number: 20, body: '**Blocked by:** #10, #11', labels: ['v4.0.0'] }];
  const existing = new Map([[20, [11, 12]]]);
  const plan = planChanges({ cards, existing, excluded: new Set() });
  assert.deepEqual(plan.add, [{ issue: 20, blocker: 10 }]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.unpruned, [{ issue: 20, blocker: 12 }]);
  const pruned = planChanges({ cards, existing, excluded: new Set(), prune: true });
  assert.deepEqual(pruned.remove, [{ issue: 20, blocker: 12 }]);
});

test('never links a needs-review issue or a card to itself', () => {
  const cards = [
    { number: 30, body: '**Blocked by:** #30, #95, #31', labels: ['v4.1.0'] },
    { number: 95, body: '**Blocked by:** #31', labels: ['v4.1.0', 'needs-review'] },
  ];
  const plan = planChanges({ cards, existing: new Map(), excluded: new Set([95]) });
  assert.deepEqual(plan.add, [{ issue: 30, blocker: 31 }]);
  assert.deepEqual(plan.ignored, [{ issue: 30, blocker: 30 }, { issue: 30, blocker: 95 }]);
});

test('is a no-op when the native links already match the text', () => {
  const cards = [{ number: 40, body: '**Blocked by:** #41', labels: ['v5.0.0'] }];
  const plan = planChanges({ cards, existing: new Map([[40, [41]]]), excluded: new Set(), prune: true });
  assert.deepEqual(plan, { add: [], remove: [], ignored: [], unpruned: [] });
});
