# Installing agentic-kit: package scope and operational scope

The recommended installation is:

```bash
npm install -g @pacphi/agentic-kit@next
ak setup
```

The first command decides where the **agentic-kit package and its `ak` binary**
live. The second command performs agentic-kit's machine/user and optional project
work. Those scopes are independent: running a local or one-shot `ak setup` does
not make setup local or temporary.

The package requires Node.js 22 or newer. The `next` tag is the 4.0 prerelease
channel; after 4.0 GA, use the release channel documented in the README.

## The two independent scope decisions

| Decision | Controlled by | What it affects |
| --- | --- | --- |
| Where the `ak` package lives | `npm install`, `npm install -g`, `npm exec`, a tarball, Git, or a checkout | Package files and how the `ak` executable is resolved |
| What an `ak` command changes | The command, flags, current directory, saved `kit.json`, and active npm prefix | Global tools, current-user configuration, MCP registration, Brain data, and possibly repository files |

Installing the package is low impact: agentic-kit has zero runtime dependencies and
publishes its CLI, source/templates, and selected documentation. Running `ak setup`
is intentionally broader. It can install Ruflo, AQE, AgentDB, and enabled host CLIs
globally; install the user-level RuvNet Brain; update current-user guidance and MCP
configuration; and initialize the current project.

## `npm install` versus `npm install -g`

| Property | `npm install @pacphi/agentic-kit@next` | `npm install -g @pacphi/agentic-kit@next` |
| --- | --- | --- |
| npm mode | Local, the default | Global-prefix mode |
| Package location | Nearest package root's `node_modules/@pacphi/agentic-kit` | Active npm prefix's global `node_modules` |
| Binary location | `node_modules/.bin/ak` | `{prefix}/bin/ak` on Unix; directly under the prefix on Windows |
| Shell availability | Through npm scripts, `npm exec`, or `npx`; not normally on the general `PATH` | On `PATH` when the prefix's binary directory is configured |
| Project manifest | Normally adds a dependency and updates the lockfile | Does not change the current project's manifest or lockfile |
| Version ownership | Project/lockfile controls the version | Active npm prefix controls the version |
| Who sees it | That package/workspace and its npm scripts | Every shell/project using that same prefix and OS account |
| Best fit | Reproducible project automation | Interactive CLI used across many projects |
| `ak sync` self-update | May install the newer kit globally when drift is found | Updates the existing global installation |

Official npm behavior is described in
[npm's folder layout](https://docs.npmjs.com/files/folders.html/) and its
[local](https://docs.npmjs.com/downloading-and-installing-packages-locally/) and
[global](https://docs.npmjs.com/downloading-and-installing-packages-globally/)
installation guides.

### What “global” really means

`-g` means global to the **active npm prefix**, not automatically global to every
person on the computer. Inspect it with:

```bash
npm prefix -g
npm root -g
command -v ak       # Unix-like shells
where ak            # Windows
```

With `nvm`, `mise`, Volta, a user npm prefix, or similar tooling, the global prefix
is commonly private to one OS user and sometimes to one Node version. With a
system prefix, it may be shared by multiple users and may require administrator
permissions. Prefer a Node version manager or user-writable prefix; do not run
`ak setup` with `sudo`, because that can split package ownership and configuration
between root and the intended user.

Switching Node installations can switch prefixes. The old `ak`, Ruflo, AQE, and
host CLIs may then appear absent even though they still exist under the previous
prefix. Agentic-kit always evaluates the currently active `node`, `npm`, `PATH`, and
`npm root -g`.

## Installation methods

### Global registry installation — recommended

```bash
npm install -g @pacphi/agentic-kit@next
ak setup
```

Use this for an interactive machine/user tool. The command is available across
projects that share the prefix, and `ak sync` can update the same installation.
Pin an exact version when reproducibility matters:

```bash
npm install -g @pacphi/agentic-kit@4.0.0-alpha.36
```

The package installation itself does not initialize a project. The subsequent
`ak setup` command does; read [Setup scope and project changes](SETUP.md).

### Project-local development dependency

```bash
npm install --save-dev @pacphi/agentic-kit@next
npm exec -- ak status
```

This pins the CLI in the project's `package.json` and lockfile and makes it
available to npm scripts:

```json
{
  "scripts": {
    "agent:status": "ak status",
    "agent:sync": "ak sync --no-upgrade"
  }
}
```

This is useful when a repository must reproduce the same agentic-kit version in
CI or among contributors. It also means the repository is explicitly taking a
dependency on a machine-management CLI. Document that choice for contributors.

Important limitations:

- a local install does **not** put `ak` on the normal shell `PATH`;
- local npm installation may choose the nearest ancestor package/workspace root,
  rather than the literal current directory;
- `ak setup` still performs its normal global/user/project actions; and
- an ordinary `ak sync` can self-update by installing a newer agentic-kit globally.
  Use `ak sync --no-upgrade` when a lockfile must remain the sole version authority.

### One-shot execution with `npm exec` or `npx`

The explicit form avoids ambiguity between the package's `ak` and `agentic-kit`
binaries:

```bash
npm exec --yes --package=@pacphi/agentic-kit@next -- ak status
npm exec --yes --package=@pacphi/agentic-kit@next -- ak setup --dry-run
```

The shorter form also works with npm's binary inference:

```bash
npx --yes @pacphi/agentic-kit@next status
```

If the package is not already local, npm fetches it into its cache and adds that
temporary environment to `PATH`; it does not add agentic-kit to the project's
dependencies. See the official [`npx`/`npm exec` behavior](https://docs.npmjs.com/cli/commands/npx/).

One-shot describes only how the **runner package** is obtained. It does not make
the invoked operation ephemeral:

- `status` is primarily read-only, apart from ordinary version-check/cache state;
- `setup` can install global packages and write user/project configuration;
- `sync` can upgrade global packages and create a persistent global `ak`; and
- `uninstall` has its documented persistent teardown effects.

Use an exact version rather than a moving tag in automation.

### Packed release artifact

```bash
npm pack
npm install -g ./pacphi-agentic-kit-4.0.0-alpha.36.tgz
```

This installs the exact tarball that can be inspected, hashed, archived, or tested
before installation. It is the strongest option for validating the publish artifact
without depending on a registry tag at install time. npm also accepts tarball URLs;
prefer a verified digest and trusted transport.

### Git revision

```bash
npm install -g github:pacphi/agentic-kit#<commit-or-tag>
```

npm accepts Git package specifications, but this path requires Git, bypasses npm
dist-tags, and may install source that has not passed the published-artifact checks.
Pin an immutable commit, not a branch. Registry versions or verified tarballs are
preferred for normal users. See npm's supported
[package specifications](https://docs.npmjs.com/cli/install/).

### Source checkout for contributors

From a trusted checkout:

```bash
corepack enable
pnpm install
node bin/agentic-kit.mjs status
```

For a development-only global link:

```bash
npm link
ak --version
```

`npm link` makes the global binary follow the checkout. Pulling or switching the
checkout therefore changes what every shell using that prefix executes, without a
normal package upgrade. Use it only for development, and run the repository's full
validation before relying on it. Remove it with `npm unlink -g @pacphi/agentic-kit`
and reinstall the desired registry version.

Direct `node bin/agentic-kit.mjs ...` execution installs nothing, but commands such
as `setup` and `sync` retain their normal operational scope.

Other launchers such as `pnpm dlx` or `bunx` may be able to execute the published
binary, but agentic-kit's installation and native-repair path is built and tested
against Node and npm. They are not the supported machine-management contract.

## Effects by scope

| Surface | Package install only | `ak setup` machine/user phase | `ak setup` project phase |
| --- | --- | --- | --- |
| agentic-kit package | Local/cache/global according to npm method | No separate change unless later self-updated | None |
| Ruflo, AQE, AgentDB | None | Installed/repaired in the active npm global prefix | Project assets initialized from those versions |
| Claude/Codex/OpenCode CLI | None | Missing enabled hosts may be installed globally; external installs are reused | Host-specific project wiring may be generated |
| `~/.config/agentic-kit/kit.json` | None | Created/updated for the current OS user | Choices are read and project routing may be materialized |
| Claude/Codex/OpenCode user guidance | None | Managed sentinel blocks reconciled | Project guidance/assets may be created or refreshed |
| Ruflo MCP registration | None | Offered at user scope | Conflicting project-local Ruflo registration is removed |
| RuvNet Brain | None | Shared current-user KB/plugin installation; approximately 2 GB | No per-project Brain copy |
| Repository files | Local npm install can alter `package.json`, lockfile, and `node_modules` | None by package scope alone | Ruflo/AQE initialization can replace generated/config files |
| Other users | None unless they share the local tree | Only users sharing the same system prefix see packages; home-directory configuration remains user-specific | Only users of the changed repository see committed changes |
| Other projects | Global binary becomes available, but projects are not initialized | Global upgrades and user configuration can affect sessions in other projects | Only the current directory is initialized; shared global daemons/packages can still affect live sessions elsewhere |

The RuvNet Brain is user-level and shared by every project for that user. Ruflo and
AQE project memory remains repository-local. Installing the package globally does
not copy project memory into the npm prefix. Dashboard runtime discovery is
user-scoped rather than project-scoped, so supported host controllers running as
the same UID in other repositories may appear and are grouped by their observed
workspace when that identity can be established.

## Multi-user and CI guidance

### Shared workstation

- Prefer one user-writable npm prefix per OS account.
- Each user runs `ak setup` under their own account so guidance, credentials, MCP
  registration, Brain data, and `kit.json` do not land under another user's home.
- Runtime process discovery is scoped to the numeric UID running `ak dashboard`.
  Separate OS accounts are outside the normal survey; people sharing one login
  also share one UID and are therefore inside the same discovery boundary. This
  is least-privilege selection, not an OS sandbox. Never run the dashboard with
  `sudo`: it would survey root-owned sessions instead of the invoking user's.
- Do not assume one user's global install is available to another user.
- Coordinate `ak sync` when several live sessions share the same prefix, because
  package replacement and daemon stops are prefix/machine-wide for those sessions.

### CI or disposable container

- Pin an exact agentic-kit version.
- Prefer a project devDependency, a verified tarball, or explicit `npm exec`.
- Use `ak setup --dry-run` before authorizing machine/project mutation.
- Cache npm and the Brain only when the cache's size and trust model are acceptable.
- Avoid `ak sync` self-update in a lockfile-controlled job; use `--no-upgrade`.
- Never persist provider credentials in the repository or image layer.
- HOME, XDG, and npm-prefix isolation protects files but does not isolate the
  process table. Prefer a private PID namespace. A container using the host PID
  namespace can observe same-numeric-UID processes that the container permits it
  to inspect.

The current-UID rule is independent of how `ak` was acquired: local dependency,
global prefix, `npm exec`, tarball, Git checkout, and direct Node execution all
use the UID of the process running the dashboard. A service sees only the
service account's sessions. Windows does not currently provide runtime process
discovery; retained transcript/history sources remain available there.

### Repository onboarding

A project-local dependency does not initialize the repository. Conversely, a global
agentic-kit can initialize any trusted repository in which `ak setup` is run. For an
existing project, commit or back up first and review the exact mutation contract in
[Setup scope and project changes](SETUP.md).

## Updates and removal

| Goal | Command | Scope |
| --- | --- | --- |
| Update the global package manually | `npm install -g @pacphi/agentic-kit@next` | Active npm prefix |
| Update/heal the managed stack | `ak sync` | Global tools, current-user config, current project |
| Heal without package upgrades | `ak sync --no-upgrade` | Configuration/current-project heals only |
| Remove a local dependency | `npm uninstall @pacphi/agentic-kit` | Current package/workspace |
| Remove the global runner only | `npm uninstall -g @pacphi/agentic-kit` | Active npm prefix; leaves setup-created state |
| Remove managed integration state | `ak uninstall` | User/project state selected by its flags |
| Preview teardown | `ak uninstall --dry-run` | No changes |

Removing the npm package is not equivalent to `ak uninstall`. The package manager
does not know which guidance blocks, MCP entries, Brain files, project assets, or
downstream global tools were created by `ak`. Run `ak uninstall` first when the goal
is a managed teardown, then remove the runner package.

## Recommended choices

| Situation | Recommendation |
| --- | --- |
| One developer, many projects | Global registry install plus `ak setup` once |
| Team wants a reproducible CLI version | Project devDependency and `npm exec`; document setup's broader effects |
| Evaluate without retaining the runner | Exact-version `npm exec ... -- ak status` or `setup --dry-run` |
| Validate an exact release artifact | Build/verify a tarball, then install that tarball |
| Work on agentic-kit itself | Trusted checkout plus direct Node invocation or `npm link` |
| Shared or locked-down machine | Per-user prefix; coordinate with the administrator before any global setup |

Whichever package method you choose, use [Host support](HOST-SUPPORT.md) to decide
which hosts to enable and [Setup scope](SETUP.md) to decide whether the current
directory should receive project initialization.
