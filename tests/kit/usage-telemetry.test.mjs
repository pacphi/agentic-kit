import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as telemetry from '../../src/lib/usage-telemetry.mjs';
import {
  MAX_TELEMETRY_UNKNOWN_KINDS,
  addTelemetryDiagnostics, emptyTelemetryDiagnostics,
  finalizeTelemetryDiagnostics, recordTelemetryUnit,
} from '../../src/lib/usage-telemetry.mjs';

// The module is counted evidence only. A static per-host capability matrix
// once lived here and was rendered as its own panel; it declared what a parser
// COULD report rather than what it did, so it was removed. Pinning the export
// surface keeps that declaration from reappearing beside the real counters.
test('the module exports the diagnostics envelope and nothing that declares capability', () => {
  assert.deepEqual(Object.keys(telemetry).sort(), [
    'MAX_TELEMETRY_UNKNOWN_KINDS',
    'addTelemetryDiagnostics',
    'emptyTelemetryDiagnostics',
    'finalizeTelemetryDiagnostics',
    'recordTelemetryUnit',
  ]);
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
