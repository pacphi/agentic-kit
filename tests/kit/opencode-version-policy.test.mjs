import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractStockOpenCodeVersion,
  isSupportedStockOpenCodeVersion,
  STOCK_OPENCODE_VERSION_RANGE,
} from './helpers/opencode-version-policy.mjs';

test('stock OpenCode policy accepts the tested floor and later patch releases', () => {
  assert.equal(isSupportedStockOpenCodeVersion('1.18.18'), true);
  assert.equal(isSupportedStockOpenCodeVersion('1.18.22'), true);
  assert.equal(STOCK_OPENCODE_VERSION_RANGE, '>=1.18.18 <1.19.0');
});

test('stock OpenCode policy rejects versions outside the tested stable line', () => {
  assert.equal(isSupportedStockOpenCodeVersion('1.18.17'), false);
  assert.equal(isSupportedStockOpenCodeVersion('1.19.0'), false);
  assert.equal(isSupportedStockOpenCodeVersion('2.0.0'), false);
  assert.equal(isSupportedStockOpenCodeVersion('1.18.22-beta.1'), false);
  assert.equal(isSupportedStockOpenCodeVersion('not-a-version'), false);
});

test('stock OpenCode policy extracts a version from CLI output', () => {
  assert.equal(extractStockOpenCodeVersion('1.18.22\n'), '1.18.22');
  assert.equal(extractStockOpenCodeVersion('OpenCode v1.18.22'), '1.18.22');
  assert.equal(extractStockOpenCodeVersion('OpenCode development build'), null);
});
