<!-- BEGIN ruflo-superpowers-reference -->
<!-- ruflo-superpowers-reference: merged into ~/.claude/CLAUDE.md ONLY when the superpowers
     plugin is installed. Managed by install.sh / ak x reference sync — stripped
     automatically when superpowers is absent. Source of truth: the superpowers-reference
     block in the agentic-kit kit (see its docs/ for the conditional-block design). -->

## Superpowers + ruflo — house rules (coordination)

> Applies when the **superpowers** plugin is installed alongside ruflo. Superpowers
> self-injects an aggressive "if there's even a 1% chance a skill applies, you MUST use
> it" preamble at session start, so it tends to grab every task before ruflo is even
> considered. These house rules say how the two share the work so ruflo's capabilities
> actually get used. **Per superpowers' own precedence rule, this CLAUDE.md guidance
> OUTRANKS superpowers skills** — it is the sanctioned channel for directing the split,
> not a fight with the plugin.

### The split — who owns what
- **Superpowers owns *choreography* (HOW work flows):** brainstorming, writing/executing
  plans, TDD discipline, systematic debugging, git-worktree workflow, requesting/receiving
  code review, verification-before-completion. Use these to *structure* the work.
- **ruflo owns *capability* (WHAT the work runs on):** persistent cross-session memory,
  specialist agents, code analysis (AST / boundaries / diff-risk), security scan +
  AI-defense, task→agent routing, topology-aware swarms.
- **agentic-qe owns *quality capability* (when installed):** test generation, coverage,
  quality gates. (See the ruflo-aqe-reference block for its operating guidance.)

### The tiebreaker (overlap zone)
Where both could act — parallel agents, debugging, code review, TDD — let superpowers
*structure the workflow* and ruflo / agentic-qe *provide the substance*. Concretely:
- Superpowers' `dispatching-parallel-agents` *pattern* → spawn ruflo's specialist agent
  types and persist findings with `ruflo memory store`.
- Superpowers' `systematic-debugging` *process* → gather evidence with `ruflo analyze`.
- Superpowers' planning skills → recall prior decisions with `ruflo memory search --smart`
  before writing the plan.
- Superpowers' `verification-before-completion` → still the gate before any "done" claim.

**Rule of thumb:** a superpowers skill telling you *how* to proceed does **not** mean skip
ruflo. Run the superpowers process; do the actual work with ruflo (and agentic-qe)
capability. Both come to the party.
<!-- END ruflo-superpowers-reference -->
