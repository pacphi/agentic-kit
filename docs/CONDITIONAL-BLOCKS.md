# Conditional CLAUDE.md blocks — design & how to add one

This kit's job is to give every repo on the machine a **common Claude experience** by
merging managed text into the global `~/.claude/CLAUDE.md`. Some of that text should appear
only when a companion tool is installed. This doc explains how that works, why it's built the
way it is, and how to add support for a new tool (a CLI, a plugin, a skill-set) so it *plays
nicely with the others* instead of fighting them.

If you've never touched this machinery, read the "mental model" first — the rest is reference.

---

## The mental model: three layers, not three rivals

When you sit down to work, three different kinds of thing can show up:

- **ruflo** is the **workshop** — the power tools, the persistent memory, a crew of specialist
  agents, the security scanner. It's *what work gets done with*. This kit exists to install
  and heal it.
- **agentic-qe** is a **specialist QE crew** you add on top — test generation, coverage,
  quality gates. More unique capability, same workshop.
- **superpowers** is a **disciplined project manager** — it insists on a process (brainstorm →
  plan → TDD → verify). It's *how the work flows*. It ships **zero** CLIs, agents, or memory.

The trap people hit: superpowers fires a loud "you MUST use a skill for everything" announcement
at session start, while ruflo and agentic-qe sit quietly in a reference doc. **Loud-and-first
beats quiet-and-waiting**, so superpowers grabs every task and ruflo never comes to the party —
even though they're different layers (capability vs. choreography) that should *stack*, not
collide.

The fix is **house rules** posted where Claude reads them first: superpowers runs the meetings,
ruflo/agentic-qe do the actual work. Crucially, superpowers' own rules say *the user's CLAUDE.md
outranks superpowers skills* — so a rule written into CLAUDE.md is the **sanctioned** way to
direct the split, not a fight with the plugin. That house-rules text is the
`ruflo-superpowers-reference` block.

---

## What a "block" is, in source

Strip away the prose and a managed block is **three things**:

1. **A template file** in `claude/` — markdown wrapped in two HTML-comment markers:
   ```
   <!-- BEGIN ruflo-aqe-reference -->
   …content Claude reads…
   <!-- END ruflo-aqe-reference -->
   ```
   The markers are the whole trick: they let the kit find and replace *only this region* of
   `~/.claude/CLAUDE.md`, leaving your hand-written notes and every other block untouched. The
   generic `_ruflo_block_upsert` / `_ruflo_block_strip` primitives in `shell/ruflo-lib.sh` do
   the surgical replace; they were always block-agnostic.

2. **A detector** — a yes/no command: *"is this tool installed?"* `have aqe` checks PATH;
   `have_superpowers` checks for the plugin directory on disk.

3. **Gate logic** that ties them together:
   > detector says yes → drop the template between its markers (upsert); says no → cut that
   > region out (strip).

Parts 1 and 2 are *data*. Part 3 is the only *logic* — and it's identical for every block.

---

## The registry: one list, not copy-pasted gates

Because the gate logic is the same for every block, it lives in **one place** and loops over a
**registry** of blocks. The registry is `_ruflo_cond_blocks` in `shell/ruflo-lib.sh`:

```sh
# <slug> | <source file in claude/> | <staged template in ~/.config/ruflo/> | <detector>
_ruflo_cond_blocks() {
	cat <<'EOF'
ruflo-aqe-reference|aqe-reference.md|aqe-md-template.md|have aqe
ruflo-superpowers-reference|superpowers-reference.md|superpowers-md-template.md|have_superpowers
EOF
}
```

Each field maps to the three things a block *is*:

| Field | Meaning |
|-------|---------|
| `slug` | doubles as the sentinel name — `<!-- BEGIN <slug> -->` … `<!-- END <slug> -->` |
| source file | the authored markdown in `claude/`, staged at install time |
| staged template | where it lands under `~/.config/ruflo/` (so resync works with no repo nearby) |
| detector | any command; **exit 0 = "tool present, include the block"** |

Because the detector is "just a command that exits 0 or 1," the registry doesn't care *how* a
tool is detected — `have aqe` (PATH) and `have_superpowers` (plugin dir) coexist cleanly. Each
row brings its own test.

Every consumer **loops the registry** instead of hardcoding a tool:

| Consumer | What it does with the registry |
|----------|--------------------------------|
| `install.sh` | stages each template, then upserts/strips each block per its detector |
| `_ruflo_sync_cond_blocks` (lib) | the shared reconcile loop — used by install and resync |
| `ruflo-resync` / `ruflo-reference-refresh --sync-blocks` | re-asserts every block after an upgrade |
| `ruflo-reference-refresh status` | reports each block: present / missing / stale |
| `uninstall.sh` | removes each staged template and strips each block |

`_ruflo_sync_aqe_block` in `shell/ruflo-functions.sh` is kept as a thin back-compat shim that
calls `_ruflo_sync_cond_blocks` (so the older `--sync-aqe` flag still works); it now reconciles
**every** block, not just agentic-qe.

---

## Adding support for a new tool

Two steps. No new logic, ever.

1. **Write the template** — `claude/<name>-reference.md`, wrapped in
   `<!-- BEGIN ruflo-<name>-reference -->` … `<!-- END ruflo-<name>-reference -->`. Keep the
   `ruflo-` sentinel prefix — `uninstall.sh` keys off it.
2. **Add one registry row** to `_ruflo_cond_blocks` in `shell/ruflo-lib.sh`:
   ```
   ruflo-<name>-reference|<name>-reference.md|<name>-md-template.md|<detector>
   ```
   If the detector isn't a simple `have <binary>`, add a small `have_<name>` function next to
   `have_superpowers` in the same file.

Install, resync, status, and uninstall pick it up automatically.

### Where "play nicely with others" comes from

This is the key distinction: **the registry decides *presence* (is the block in the file);
the template's *content* decides *behavior* (how the tool coordinates with the rest).** They're
independent concerns — which is exactly why this scales: the machinery never changes, you only
ever author markdown.

So the convention is: **every conditional block's template includes a short "how this
coordinates with the others" section.** Skeleton:

```markdown
<!-- BEGIN ruflo-foobar-reference -->
## Foobar — operating guidance
> Applies when **foobar** is installed.

### How this coordinates with the others        ← the "play nice" part
- foobar owns <its lane>; defer to ruflo for memory/agents/security.
- In overlap with superpowers' process skills, let superpowers choreograph and foobar/ruflo execute.

### Capabilities / how to drive it
…tool-specific notes…
<!-- END ruflo-foobar-reference -->
```

Note the two emphases this kit already ships:
- **`ruflo-aqe-reference`** is mostly a *capability* block — it teaches Claude about a CLI/MCP
  it wouldn't otherwise know to use.
- **`ruflo-superpowers-reference`** is the *opposite* — Claude already knows superpowers (too
  well, because it self-injects), so that block is almost entirely *arbitration*: the house
  rules that keep superpowers from crowding ruflo out. Same machinery slot, opposite purpose.

---

## Detection notes & caveats

- **`have_superpowers`** tests presence-on-disk at
  `~/.claude/plugins/cache/<marketplace>/superpowers/<version>/`. That mirrors how `have aqe`
  means "installed," **not** "provably active this session" (a plugin could be installed but
  disabled). On-disk presence is the right gate for a CLAUDE.md block.
- We deliberately **do not** touch superpowers' own `SessionStart` hook. Mutating a
  third-party plugin's files is fragile and outside this kit's "merge a managed block into
  CLAUDE.md" charter. The arbitration block achieves the same outcome through the sanctioned
  channel (CLAUDE.md precedence).

---

## Verifying a change

```bash
bash -n install.sh uninstall.sh shell/ruflo-lib.sh shell/ruflo-functions.sh   # syntax
./install.sh --dry-run            # preview staging + per-block upsert/strip decisions
```

For an end-to-end check, stage the templates into a scratch `cfg/` dir, point a throwaway
`CLAUDE.md` at it, stub the detectors, and call `_ruflo_sync_cond_blocks "$REF" "$CFG"` —
asserting that present→added, absent→stripped, surrounding content is preserved, and re-running
doesn't duplicate. (This is the same shape as `bin/ruflo-parity-test`'s isolated-dir approach.)
