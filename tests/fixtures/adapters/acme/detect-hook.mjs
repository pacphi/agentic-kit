// Fixture lifecycle hook for the "acme" conformance adapter
// (tests/kit/adapter-conformance.test.mjs). A real, standalone subprocess —
// no dependencies, no network, no filesystem writes — invoked exactly as an
// admitted external adapter's declared hook would be, through the real
// runAdapterHook. It echoes a 'detect' verb payload shaped per the Adapter
// Contract Dossier: buildAdmittedLifecycleAdapter (lifecycle-registry.mjs)
// parses this stdout as JSON and returns it verbatim for 'detect'.
//
// ACME_HOOK_FAIL=1 makes the hook fail deliberately, for any future negative
// test of the hook-execution path itself (unused by the current harness, but
// kept honest rather than removed since it costs nothing to leave in).
if (process.env.ACME_HOOK_FAIL === '1') {
  process.stderr.write('acme fixture hook: deliberate failure\n');
  process.exit(3);
}

process.stdout.write(JSON.stringify({
  observed: {
    host: 'acme',
    bin: 'acme',
    pid: process.pid,
    argv: process.argv.slice(2),
  },
}));
