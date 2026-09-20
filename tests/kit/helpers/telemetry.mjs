export const identity = { installationId: '11111111-1111-4111-8111-111111111111', key: 'ab'.repeat(32) };
export const now = '2026-09-20T12:00:00.000Z';
export function source(overrides = {}) {
  return { id: 'native-private-session', host: 'codex', title: 'SECRET', project: '/private/SECRET',
    start: '2026-09-19T12:00:00.000Z', input: 100, output: 20, cacheRead: 80, cacheWrite: 0,
    prompts: 2, responses: 3, exceptions: 1, aborts: 0, latHist: [1, 1, 0, 1, 0, 0], latCount: 3,
    costEvidence: { observedUsd: 0, estimatedUsd: 0.02, observedMessages: 0, estimatedMessages: 3, unpricedMessages: 0 },
    ...overrides };
}
export async function fixture({ sessions = [source()], generatedAt = now, ...rest } = {}) {
  const { createSnapshot } = await import('../../../src/lib/telemetry/projection.mjs');
  return createSnapshot({ identity, generatedAt, producerVersion: '4.0.0-alpha.51', days: 30,
    usage: { sessions, sourceHealth: { codex: { status: 'ok' } }, acquisitionCoverage: { complete: true }, pricesAsOf: '2026-09-09' },
    inventory: null, receipts: [], ...rest });
}

