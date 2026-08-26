# Authoring a host adapter

A walkthrough for adding a new agent CLI to `ak` without touching `ak`. The running example is
**Hermes** — the fourth-host candidate this contract was designed against, and the adapter that
would graduate it. Substitute your own host throughout.

Read this alongside [ADR-0029](adr/0029-host-adapter-extension-point.md) (the contract) and
[ADR-0031](adr/0031-capability-graduation-and-upstream-requests.md) (how a capability is earned).
For what the kit does with a host once it knows about one, see
[HOST-SUPPORT.md](HOST-SUPPORT.md) and [PROVIDERS.md](PROVIDERS.md).

> **Experimental.** The whole surface is inert unless `AK_EXPERIMENTAL_HOST_ADAPTERS=1` is set, and
> `contract: 1` can still change between alpha releases. See [The freeze](#9-the-freeze-and-why-you-matter).

## 1. What you're actually building

Two things:

- **One JSON manifest** — a description of your host. Every value is JSON-serializable. A manifest
  that cannot express a closure cannot smuggle one in.
- **A handful of small hook scripts** — the only part that ever executes.

**Nothing you write runs inside the `ak` process.** Every hook is a subprocess `ak` spawns,
supervises, and owns the termination of. `ak` never calls `import()` or `require()` on a path you
supply, and registering your adapter adds no npm dependency to `@pacphi/agentic-kit`.

That constraint is also your leverage. ADR-0029 records what adding a host used to cost: a dedicated
owner module, native surfaces reverse-engineered from scratch, and edits across roughly a dozen
files and eight test suites — plus a permanent maintenance obligation on a maintainer who may not
run your CLI. That collapses to a manifest and some hooks. You write no `ak` code, own no module in
this repository, and reverse-engineer no internals.

What you give up in exchange is real and is covered in [section 8](#8-what-earning-actually-gets-you-today).

## 2. Write the manifest

Name it whatever you like as a file; name it exactly `ak-adapter.json` at the package root if you
publish it on npm. Here is a complete, valid one — this shape validates against `ak`'s real
validator:

```json
{
  "name": "hermes",
  "version": "0.1.0",
  "contract": 1,
  "host": {
    "id": "hermes",
    "label": "Hermes",
    "install": { "bin": "hermes", "externalInstallPolicy": "detect-never-overwrite" },
    "capabilities": {
      "canDriveSession": false,
      "canBePrimary": false,
      "canRouteActivities": true,
      "commandStatusline": false,
      "transcripts": false,
      "usage": false,
      "nativeMcpConfig": false,
      "nativeGuidance": false
    },
    "trust": { "approvalPolicy": "unchanged", "changes": [] },
    "enabledByDefault": false,
    "configProjection": "ruflo",
    "observability": []
  },
  "detection": {
    "bin": "hermes",
    "versionArgs": ["--version"],
    "versionPattern": "\\d+\\.\\d+\\.\\d+"
  },
  "driving": { "surfaces": ["cli-subprocess"] },
  "lifecycle": {
    "detect": { "hook": { "command": ["node", "detect-hook.mjs"], "files": ["detect-hook.mjs"], "timeoutMs": 5000 } }
  },
  "execution": {
    "run": { "hook": { "command": ["node", "run-hook.mjs"], "files": ["run-hook.mjs"], "timeoutMs": 120000 } }
  },
  "trust": {
    "changes": [
      {
        "id": "hermes-subprocess-hooks",
        "kind": "third-party-adapter",
        "scope": "project",
        "owner": "hermes",
        "value": "subprocess hooks",
        "effect": "run consented lifecycle and execution hooks for hermes"
      }
    ]
  }
}
```

Field by field:

| Field | What it's for |
| --- | --- |
| `name` / `host.id` | Your host's id. They must agree, and must not collide with a built-in. |
| `host.label` | Human-readable name shown in status output. |
| `host.install.bin` | Your CLI's binary name. `externalInstallPolicy: "detect-never-overwrite"` is the honest posture — `ak` finds your CLI, never installs or upgrades it. |
| `host.capabilities` | All eight keys are **required**. Declare what your host legitimately does. |
| `host.trust` / `trust.changes` | Up-front disclosure of what your adapter touches. `trust.changes` is what the user reads before consenting. |
| `detection` | How `ak` proves your CLI is present: the binary, the version arguments, and a regular-expression source for the version. |
| `driving.surfaces` | Declare `cli-subprocess`. See below. |
| `lifecycle` / `execution` | Your hooks ([section 3](#3-write-the-hooks)). Both are optional; a manifest with neither is a pure description. A file-backed hook must list its adapter-owned files in `hook.files`. |
| `aqe.provider` | Optional Agentic-QE 3.13.12+ external-provider candidate. Requires `cli-subprocess`, activity routing, and both `execution.run.hook` and `aqe.provider.hook`; activation still requires the passed tier and grant. |

> **Capabilities describe what the adapter *delivers through `ak`*, not what your host can do in
> principle.** A real Hermes adapter's first draft declared `nativeMcpConfig: true` and
> `nativeGuidance: true` — both true of Hermes itself (`hermes mcp add`, reading `AGENTS.md` from
> cwd) but false of the adapter, which shipped no `apply`/`undo` hooks to actually *wire* either.
> If your manifest has no hooks for a capability, declare it `false` even when the underlying CLI
> supports it — the example manifest above is right (all three `false`) precisely because it has
> no `lifecycle.apply`/`lifecycle.undo` hooks yet.

### Driving surfaces

The vocabulary has three names — `cli-subprocess`, `acp`, `mcp` — but **`cli-subprocess` is the only
one with a working implementation.** Declare an `execution` block without `cli-subprocess` in
`driving.surfaces` and you get no execution adapter at all — the registration is refused
`surface-unsupported`, never silently downgraded to a surface you didn't test against. `acp` and
`mcp` are reserved for forward compatibility, and nothing drives them today.

### The three capabilities you cannot claim

`canBePrimary`, `commandStatusline`, and `aqeProvider` are **not yours to assert**:

- `canBePrimary` and `commandStatusline` are required keys, and the schema accepts them **only at
  `false`**. Writing `true` is rejected before anything runs (`cap-can-be-primary`,
  `cap-command-statusline`). You cannot write down the claim; you **earn** the capability through a
  conformance tier plus an explicit maintainer grant, recorded outside your manifest entirely
  (ADR-0031 §1).
- `host.legacy.aqeProvider` must be absent — `cap-aqe-provider` refuses any value. Candidate data
  belongs under `aqe.provider`; it becomes live only after the real `aqe-provider` tier passes at
  the current content hash and a maintainer grants `aqeProvider`.

Self-declaration is the attack surface, so it stays closed permanently. The *capability* is a ladder;
the *declaration* is a wall.

### The AQE provider hook

Agentic-QE 3.13.12 added `externalProviders`. A candidate adapter may describe the safe subset that
agentic-kit projects:

```json
{
  "aqe": {
    "provider": {
      "hook": {
        "command": ["node", "aqe-provider.mjs"],
        "files": ["aqe-provider.mjs"],
        "timeoutMs": 180000,
        "passEnv": ["HERMES_API_KEY"]
      },
      "billingMode": "subscription",
      "models": ["default", "fast"],
      "defaultModel": "default",
      "maxConcurrency": 2,
      "stripEnv": ["OPENAI_API_KEY"],
      "displayName": "Hermes subscription"
    }
  }
}
```

The provider id is always `host.id`; adapters cannot choose a built-in/reserved id. The hook reads
one prompt from stdin and writes only the completion to stdout. Model and project identity arrive in
protected `AK_AQE_*` variables; only names in `passEnv` cross from the parent environment. Do not
print partial output before success: the bridge intentionally suppresses stdout for refusal, auth,
timeout, and failure because AQE treats non-empty stdout as a completion even on a non-zero exit.
Billing mode is declared provenance, not a verified charge or vendor fact.

### One structural coupling worth knowing

Declaring `execution` while `canRouteActivities` is `false` is a contradiction the schema refuses
outright (`execution-not-routable`). The converse is fine: a routable host with no `execution` block
is legal and degrades honestly at run time as `cli_unavailable`.

## 3. Write the hooks

Hooks are ordinary executables. They read stdin, read a few environment variables, print to stdout,
and exit with a code. No SDK, no imports from `ak`.

### The `detect` hook (lifecycle)

Reports that your host is present and describes what it found. It prints a JSON object on stdout;
`ak` parses it and returns it verbatim as the `detect` result.

```js
// detect-hook.mjs
process.stdout.write(JSON.stringify({
  observed: { host: 'hermes', bin: 'hermes', version: '1.4.2' },
}));
```

`detect`, `plan`, `apply`, `verify`, and `undo` are the five lifecycle verbs. Declare only the ones
you need — an undeclared verb is an honest no-op, not a fabricated success. `apply` and `undo` are
what wire (and unwire) your host's own configuration when the user runs `ak setup` / `ak uninstall`.

### The `execution.run` hook

This is the one that actually drives your host as a worker under `ak run`.

- **stdin** carries the worker prompt.
- **the environment** carries `AK_WORKER_ID`, `AK_WORKER_ACTIVITY`, `AK_WORKER_ROLE`,
  `AK_WORKER_MODEL`, and `AK_WORKER_CWD` (the repository being worked on — your hook does *not*
  spawn there, see below). **`AK_WORKER_CWD` is advisory, not a sandbox boundary** — `ak` tells
  your hook which directory to work in, but nothing confines an auto-approving host to it once your
  hook hands control to it. If your host has no permission event to intercept (many local-model
  CLIs don't), it is your hook's job to make that boundary real.
- **stdout** carries either a JSON object — `{summary, observedModel, provider, usage}`, all
  optional — or plain text, which is taken as the summary.
- **the exit code** is the sole authority for success.

```js
// run-hook.mjs
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  const outcome = await driveHermes(prompt, {
    cwd: process.env.AK_WORKER_CWD,
    model: process.env.AK_WORKER_MODEL || undefined,
  });
  if (outcome.needsLogin) process.exit(78);
  process.stdout.write(JSON.stringify({
    summary: outcome.text,
    observedModel: outcome.model,
    provider: 'hermes',
  }));
});
```

### Exit codes

| Code | Meaning | What the runner does |
| --- | --- | --- |
| `0` | Success | Reads your stdout payload. |
| `77` | Permission refused — you need consent you don't have | Records `blocked` / `permission_required` and **never escalates**. Escalating around a consent boundary is the safety violation ADR-0019 forbids. |
| `78` | Authentication required | Records `failed` / `auth_required`; the runner may retry on another host. |
| other non-zero | Ordinary failure | Records `failed` / `worker_error`; may be escalated. |

Codes `77` and `78` exist so you can say "I refused" or "I'm not logged in" honestly, instead of a
bare non-zero exit that reads as a generic failure.

### Rules `ak` enforces on every hook

These aren't suggestions — they're the supervision that makes running your code safe, and they shape
how you write it:

- **Anchored working directory.** A hook spawns with its cwd pinned to *your adapter's own resolved
  directory*, never `ak`'s. So `["node", "run-hook.mjs"]` resolves to **your** `run-hook.mjs`, and a
  file planted in the operator's cwd is unreachable. This is why `AK_WORKER_CWD` exists: it's how
  you learn which repository to work on. A *remote*-sourced manifest (`npm:` / `https://`) has no
  local directory to anchor to, so a relative command from such a source is refused
  (`execution-unanchored` / `lifecycle-unanchored`) — publish remotely and contract v1 requires
  path-independent PATH binaries or inline evaluator commands.
- **Declared hook-file integrity.** A relative/script-like hook argument must be covered by that
  hook's `files` array, with a path relative to the manifest directory. `ak` reads each declared
  regular file, records its SHA-256 digest alongside the manifest identity, discloses the digest during
  `trust`, and rechecks it immediately before every spawn. Edit, remove, or replace a declared file
  and admission/grants go stale; an edit after admission is refused at spawn time. The inventory is
  explicit, not a transitive import scanner: list every adapter-owned file your hook executes.
- **Remote path restriction.** npm/URL manifests are read and discarded rather than retained as a
  local bundle. Contract v1 therefore refuses script-like hook paths from those sources; use a PATH
  binary or inline evaluator command. A future immutable bundle/signature contract may widen this.
- **Minimal environment.** Your hook gets `PATH`, `HOME`, and whatever `ak` injects for that verb —
  never `ak`'s full environment. Don't expect to inherit the operator's secrets.
- **Bounded output.** Captured output is capped at 256 KB and truncated with a marker beyond that.
- **Bounded time.** Your declared `timeoutMs` and `ak`'s own budget both apply, and the tighter one
  wins; with neither, a hook gets 30 seconds. On timeout the whole process group is killed — there is
  no grace period, because the budget is already spent.
- **No shell.** `command` is an argv array, spawned directly. There is no shell to quote against.
- **stderr is never promoted.** Diagnostics you write to stderr are captured for the operator but
  never folded into a downstream worker's prompt. Practical consequence: **write your JSON payload
  to stdout only** — stderr chatter won't corrupt a valid JSON parse, but a plain-text summary is
  discarded if you also wrote to stderr.
- **Results never launder trust.** A `provider` you declare in your payload is stamped `inferred`,
  never `observed` — `ak` didn't verify it against anything.

## 4. Publish it, and let a user opt in

Ship the manifest any of three ways:

| Source form | Example | Note |
| --- | --- | --- |
| File | `~/.config/ak/adapters/hermes.json` | Fully anchored; relative hook commands work. |
| npm | `npm:@you/ak-adapter-hermes` | Must ship `ak-adapter.json` at the package root. `ak` reads it from the tarball to stdout — nothing is extracted to disk and your package scripts never run. |
| URL | `https://example.com/hermes.json` | No redirects, bounded time and bytes, no credentials attached. |

A user then registers it in their own `kit.json`:

```json
{
  "hostAdapters": [
    { "name": "hermes", "source": "~/.config/ak/adapters/hermes.json", "contract": 1 }
  ]
}
```

and opts in:

```bash
export AK_EXPERIMENTAL_HOST_ADAPTERS=1
ak host adapters trust hermes
```

`trust` prints the full validated manifest, every declared hook-file digest, and every hook command
that will spawn — then asks for confirmation before pinning a hash of that combined content. **Edit
the manifest or a declared hook file afterwards and consent invalidates**: the adapter is not admitted
again until the user re-confirms the new content. Consent lives outside your code, attached to a
specific byte sequence, never to a name your content could drift underneath.

Three more notes for your install docs:

- Unattended consent to a **remote** source (`npm:` / `https://`) requires `--yes --expect-hash
  <sha256>`. `--yes` alone is refused for a non-file origin, so a CI run can never blanket-consent to
  whatever the remote happens to serve. Publish the hash alongside your adapter.
- With the flag unset, a `hostAdapters` entry is parsed and preserved but never admitted. It is
  reported present-but-inactive, not silently dropped.
- Your **lifecycle** hooks only run during `ak setup` / `ak sync` / `ak uninstall` when the user has
  *also* explicitly enabled your host under `integrations.hosts` in `kit.json`. There is no pick-UI
  for external hosts yet.

## 5. Self-test with the conformance kit

```bash
ak host adapters conformance hermes
```

This runs the tiered black-box harness against your **real** host — spawning your actual hooks — and
prints an honest per-tier verdict. It warns first, listing every hook command it is about to run as
a real subprocess. Here is a real run against the repository's conformance fixture
(an adapter shaped exactly like the manifest in section 2):

`activity-routing` and `primary-eligible` drive a genuine worker through your `execution.run` hook,
so two things are handled for you: the outer time budget honors your manifest's own declared
`execution.run.hook.timeoutMs` automatically (pass `--timeout <ms>` to override it), and the worker's
cwd is a throwaway scratch directory, never wherever you happened to run the command from — an
auto-approving agentic host has no business landing in your real working directory during a
self-test.

```text
host adapter conformance — acme  (56fa107674d2)
admission          passed   host id 'acme', contract 1
session-driving    skipped  not declared — nothing to prove
activity-routing   passed   registered for 'acme'
aqe-provider        passed   admitted provider hook returned the expected bounded probe
primary-eligible   passed   'acme' completed a direct (non-escalated) run to a succeeded result, and…
statusline         gated    ak-local: awaiting maintainer grant for 'commandStatusline' (not an…
```

(Detail columns elided at the right margin; the real ones run longer.)

What each tier means for you:

| Tier | What it proves | What to expect |
| --- | --- | --- |
| `admission` | Your manifest validates, admits through the fail-closed gate, joins the registry, and your `detect` hook runs as a real subprocess. | **Can genuinely pass.** A failure here short-circuits every downstream tier, so nothing gets laundered. |
| `session-driving` | Gates `canDriveSession`. | `skipped` if you don't declare it. **`gated` if you do** — `ak` has no external session-driving path, and being a native ruflo backend is upstream-owned. |
| `activity-routing` | Gates `canRouteActivities`. A real one-worker `ak run` routed to your host returns a succeeded `WorkerResult`. | **Can genuinely pass.** |
| `aqe-provider` | Earns `aqeProvider`. The harness runs the real admitted stdin/stdout hook with its declared model and requires the bounded probe response. | **Can genuinely pass** when `aqe.provider` is declared; then a maintainer may grant `aqeProvider`. |
| `primary-eligible` | Earns `canBePrimary`. Your host anchors a real run *and* receives a genuine ADR-0019 escalation onto itself — a second real subprocess. | **Can genuinely pass**, with no pre-existing grant. |
| `statusline` | Earns `commandStatusline`. | **`gated`.** There is no admitted-host footer-render path yet, so even a granted capability has nothing real to drive. |

Use `ak host adapters conformance <name> --dev` while iterating. It runs the same real subprocess
checks but loudly persists no consent, tier evidence, or capability grant; a dev run cannot graduate
the adapter. Use the default command when you want the reproduced evidence that a maintainer may
review.

**A `gated` or `skipped` result on `session-driving` and `statusline` is expected, not your adapter
failing.** The harness never fabricates a pass, and there is no injection seam through which a caller
could substitute one. Only `failed` means something is wrong with your adapter.

Evidence is hash-pinned to your combined manifest/file identity, so any declared edit voids it. And it's a two-way street: if a
grant-bearing tier later re-runs `failed` at the same adapter-content hash, the stored evidence *and* the
live capability are auto-voided.

## 6. Propose it for graduation

You don't need a maintainer to ship. Publish, and any user can opt in behind the flag with pinned
consent — that path is entirely yours.

To go further, hand a maintainer your conformance report. They:

1. **Re-run the conformance kit** themselves — conformance is objective, and trust rests on
   reproduced evidence rather than your report.
2. **Read your hook scripts** — the only part that executes.
3. **Decide** the tier and the destination.

Two destinations, the maintainer's call:

- **Blessed external adapter** — `ak host adapters bless hermes <capability>` (`grant` is the same
  command). Your adapter stays out-of-tree and experimental, holding exactly the capabilities its
  tiers earned. A grant is refused unless the gating tier is recorded `passed` at the current
  adapter-content hash, and it's re-checked at read time, not just at write time.
- **Promoted built-in** — your host descriptor is adopted into the first-party registry. This is now
  an ordinary PR: a registry entry, a lifecycle adapter, an About card. Once built-in, the caps no
  longer apply, because it is first-party code the maintainer vouches for. That's what promotion
  means.

A tier you can't clear because the capability lives upstream is recorded as
**`gated: <repo>#NNN`**, not failed:

```bash
ak host adapters gate hermes session-driving ruvnet/ruflo#1234
ak host adapters status hermes
```

The maintainer champions that request upstream with a named extension point, and `status` shows
exactly what your adapter is waiting on.

## 7. The commands, in one place

```bash
ak host adapters list                       # configured adapters and their consent state
ak host adapters trust <name>               # disclose the manifest, confirm, pin the hash
                                            #   (--yes --expect-hash <sha256> for unattended/remote)
ak host adapters revoke <name>              # withdraw consent (works with the flag off)
ak host adapters conformance <name>         # run the tiered harness
ak host adapters conformance <name> --dev   # real self-test; persist no evidence or grants
ak host adapters status <name>              # per-tier state + granted capabilities
ak host adapters grant <name> <capability>  # maintainer: confer an earned capability (alias: bless)
ak host adapters revoke-grant <name> [cap]  # withdraw a granted capability
ak host adapters gate <name> <tier> <ref>   # record an upstream blocker against a tier
```

## 8. What earning actually gets you today

Be clear-eyed about this, because the machinery is ahead of its consumers:

- **A granted `canBePrimary`** raises the capability on your host's effective registry entry, so
  `hostTierLabel` and the primary-eligible host set reflect it. But **no path yet *selects* an
  external host as primary** — `ak host pick` is still built-in-scoped. You show as eligible; nothing
  acts on it.
- **A granted `commandStatusline` is currently inert.** There is no runtime reader for an
  admitted host's command-backed footer. The grant records what you earned; nothing renders it yet.

Both gaps are disclosed at grant time, and both are `ak`-local work rather than upstream ceilings —
they will light up without needing anything from you. What works end-to-end today includes
`activity-routing` and, on Agentic-QE 3.13.12+, an earned `aqeProvider`: a real provider hook,
project-only declaration/default, fallback and activity-route projection, plus precise ownership
receipts. `ak x verify providers` proves that configuration but honestly does not claim a served
model response; release proof must also exercise a fresh AQE CLI/MCP process.

## 9. The freeze, and why you matter

One ceiling is genuinely not `ak`'s to lift:

- **Native ruflo backend** (`session-driving`). ruflo's backend enablement is per-host and defined
  inside ruflo, not through an outside registration surface. *Interim:* your host runs through `ak`'s
  own supervised execution — just not as a ruflo-native backend.

Agentic-QE provider identity is no longer an upstream ceiling on AQE 3.13.12+. Issue #628 supplied
the external-provider registry. The remaining boundary is local and evidence-based: candidate data,
a passed `aqe-provider` tier, explicit grant, and current content hash.

Neither is faked, hidden, or shimmed. Each gets a tracked capability request and an honest interim
behaviour ([ADR-0031 §4](adr/0031-capability-graduation-and-upstream-requests.md)).

And the contract itself stays experimental until a **real external adapter clears the full
conformance kit and survives one release of soak in the field with no contract-shape change**. That
adapter could be yours. Until then, `contract: 1` may change between alpha releases — bounded
instability that exists precisely so the first real adapter's conformance run can surface shape
problems cheaply.

So a real Hermes isn't just a beneficiary of this machinery. It's the test that graduates the
contract from experimental to frozen.
