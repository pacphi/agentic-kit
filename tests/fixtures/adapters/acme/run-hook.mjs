// Fixture execution hook for the "acme" conformance adapter (P2, ADR-0031).
// A real, standalone subprocess — no dependencies, no network, no filesystem
// writes — invoked exactly as an admitted external adapter's declared
// execution.run.hook would be, through the real runAdapterHook. It reads the
// worker prompt from stdin (proving the stdin wiring) and echoes a JSON
// result whose `summary` names the AK_WORKER_* metadata env vars it received
// (proving the env wiring), matching the {summary, observedModel, provider}
// shape buildAdmittedExecutionAdapter (execution/admitted.mjs) parses.
//
// ACME_RUN_HOOK_FAIL=1 makes the hook fail deliberately, for a negative test
// of the worker_error mapping path.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (process.env.ACME_RUN_HOOK_FAIL === '1') {
    process.stderr.write('acme fixture run hook: deliberate failure\n');
    process.exit(3);
    return;
  }
  process.stdout.write(JSON.stringify({
    summary: `acme ran worker=${process.env.AK_WORKER_ID ?? ''} activity=${process.env.AK_WORKER_ACTIVITY ?? ''} `
      + `role=${process.env.AK_WORKER_ROLE ?? ''} model=${process.env.AK_WORKER_MODEL ?? ''} `
      + `promptBytes=${Buffer.byteLength(input, 'utf8')}`,
    observedModel: process.env.AK_WORKER_MODEL || null,
    provider: 'acme',
  }));
});
