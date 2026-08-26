import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../../src/lib/dashboard/page.mjs';

test('Providers distinguishes registration, selection, and observed execution', () => {
  const html = renderPage({ name: 'agentic-kit', version: 'test' });
  assert.match(html, /A registered provider is eligible configuration/);
  assert.match(html, /Direct Ruflo agents must select/);
  assert.match(html, /independently observed provider and model evidence/);
});
