# Host realignment evidence — 2026-09-10

Decision: [ADR-0051](../adr/0051-supported-peer-delegation-and-host-realignment.md).
Instructions: [Upgrading — supported host delegation](../UPGRADING.md#supported-host-delegation-and-realignment).

## Applied machine changes

The updated alignment path inspected user configuration and 44 project locations
from the bounded census, existing configuration-declared projects, and an explicit
emailibrium worktree. It found and removed 17 exact retired `codex mcp-server`
registrations, preserving a fresh recovery copy beside each changed file.

| Location | Claude `.mcp.json` | Codex `.codex/config.toml` |
| --- | --- | --- |
| emailibrium | Removed retired entry | Removed self-registration |
| finima | Removed retired entry | Removed self-registration |
| keel | Removed retired entry | Removed self-registration |
| prompt-genie | Removed retired entry | Removed self-registration |
| reelbox-cli | Removed retired entry | Removed self-registration |
| chrisphillipson.me/site | Removed retired entry | Removed self-registration |
| retort | Removed retired entry | No change |
| claude-autopilot | Removed retired entry | No change |
| ruflo-local | Removed retired entry | No change |
| emailibrium worktree agent-a940e1661237474ba | Removed retired entry | No change |
| Home directory | Removed retired entry | No change |

The second full alignment reported zero findings and zero proposed repairs.
Sixteen protected state items matched their pre-repair snapshots, including
available AQE routing files, Ruflo configuration, host plugin settings, and
agentic-kit's routing/provider preferences. No provider fallback was changed.

The first apply attempt stopped before writing because differently ordered
project inputs produced a different preview digest. A regression reproduced that
problem; sorting source paths made preview/apply deterministic before the
successful retry. There were no partial configuration mutations from that attempt.

Recovery files use `<config>.ak-host-align-<uuid>.bak`. They contain the exact
pre-repair configuration. Review them before restoring, because later intentional
edits must not be overwritten. Cleanup did not commit or push any affected
application project. Agentic-kit's implementation follows its separate PR workflow.

## Evidence limits

Ruflo 3.41.1 and AQE 3.14.1 native delegation mechanisms were inspected in installed
source and compared with upstream. AQE's live local resolver selected the expected
Claude/Codex providers before cleanup. Configuration preservation proves those
routes were not rewritten; it does not establish every model's current entitlement
or a successful paid inference request. No new provider API spending was initiated.

The alignment guard governs agentic-kit workflows and scoped corrective actions.
Other programs can still edit configuration. Future matching, approved repairs
can be reapplied; unfamiliar or custom entries remain explicit review items.
