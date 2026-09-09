import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackEntries } from '../../src/lib/footprint/stack-registry.mjs';
import { mntLanguageLogo } from '../../src/lib/dashboard/client/maintenance-language-logos.mjs';

test('every registry language has a bounded, self-contained SVG image', () => {
  for (const language of stackEntries('language')) {
    const data = mntLanguageLogo(language.id);
    assert.match(data, /^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(data.split(',')[1], 'base64').toString();
    assert.match(svg, /<svg\b/);
    assert.ok(svg.length < 100_000, language.id);
    assert.doesNotMatch(svg, /<(?:script|image|foreignObject|iframe)\b|\bon\w+\s*=|@import/i);
    assert.doesNotMatch(svg, /(?:href\s*=\s*["']|url\(\s*["']?)(?!#)/i);
  }
});

test('available language marks are distinct and unknown IDs use an inert code glyph', () => {
  const logos = ['javascript', 'python', 'rust', 'java', 'ada'].map(mntLanguageLogo);
  assert.equal(new Set(logos).size, logos.length);
  const fallback = mntLanguageLogo('unknown-language');
  assert.equal(mntLanguageLogo('__proto__'), fallback);
  assert.equal(mntLanguageLogo('<img onerror=alert(1)>'), fallback);
  assert.ok(logos.every(logo => logo !== fallback));
});
