import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_TELEMETRY_CAPABILITIES, MAX_TELEMETRY_UNKNOWN_KINDS, TELEMETRY_CATEGORIES,
  addTelemetryDiagnostics, emptyTelemetryDiagnostics,
  finalizeTelemetryDiagnostics, recordTelemetryUnit, telemetryCapabilities,
} from '../../src/lib/usage-telemetry.mjs';

test('the host matrix uses shared meanings and never maps Codex wire items to tool calls', () => {
  assert.deepEqual(Object.keys(HOST_TELEMETRY_CAPABILITIES), ['claude', 'codex', 'opencode']);
  assert.deepEqual(TELEMETRY_CATEGORIES, [
    'prompts', 'responses', 'toolCalls', 'commandExecutions',
    'fileChanges', 'mcpCalls', 'collaboration',
  ]);
  assert.equal(HOST_TELEMETRY_CAPABILITIES.claude.toolCalls, 'supported');
  assert.equal(HOST_TELEMETRY_CAPABILITIES.opencode.toolCalls, 'supported');
  assert.equal(HOST_TELEMETRY_CAPABILITIES.codex.toolCalls, 'unsupported');
});

test('supported categories become unavailable when the source is not readable', () => {
  assert.equal(telemetryCapabilities('claude', 'ok').prompts, 'supported');
  assert.equal(telemetryCapabilities('claude', 'ok').toolCalls, 'supported');
  assert.equal(telemetryCapabilities('claude', 'absent').prompts, 'unavailable');
  assert.equal(telemetryCapabilities('claude', 'degraded').toolCalls, 'unavailable');
  assert.equal(telemetryCapabilities('claude', 'absent').commandExecutions, 'unsupported');
  assert.equal(telemetryCapabilities('unknown-host', 'ok').responses, 'unavailable');
});

test('common diagnostics distinguish observed zero from an unavailable source', () => {
  const diagnostics = emptyTelemetryDiagnostics();
  recordTelemetryUnit(diagnostics, { prompts: 1, responses: 2, usage: [{ model: 'm' }] });
  recordTelemetryUnit(diagnostics, { prompts: 0, responses: 0, usage: [] });
  recordTelemetryUnit(diagnostics, null);
  addTelemetryDiagnostics(diagnostics, {
    warnings: ['unknown-item-types', 'unknown-item-types'],
    unknownKinds: { CommandExecution: 2 },
  });
  assert.deepEqual(finalizeTelemetryDiagnostics(diagnostics), {
    unitsSeen: 3,
    unitsParsed: 2,
    unitsWithUsage: 1,
    unitsWithPrompts: 1,
    unitsWithResponses: 1,
    prompts: 1,
    responses: 2,
    warnings: ['unknown-item-types'],
    unknownKinds: { CommandExecution: 2 },
    unknownKindOverflow: 0,
  });
});

test('unknown-kind diagnostics are bounded and retain overflow volume', () => {
  const unknownKinds = Object.fromEntries(Array.from(
    { length: MAX_TELEMETRY_UNKNOWN_KINDS + 2 }, (_, i) => [`FutureKind${i}`, 1],
  ));
  const diagnostics = emptyTelemetryDiagnostics();
  addTelemetryDiagnostics(diagnostics, { unknownKinds });
  const out = finalizeTelemetryDiagnostics(diagnostics);
  assert.equal(Object.keys(out.unknownKinds).length, MAX_TELEMETRY_UNKNOWN_KINDS);
  assert.equal(out.unknownKindOverflow, 2);
});
