// The ak- maintainer skills: authored for this repository, one text for Claude (.claude/skills)
// and Codex (.agents/skills), tracked through an `ak-*` glob in .gitignore while every
// generated skill beside them stays ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { GROUPS } from '../../scripts/upstream-watch/classify.mjs';
import { mirrorSkills } from '../../scripts/skills-mirror.mjs';

const HOSTS = ['.claude/skills', '.agents/skills'];
// Each authored skill states its trigger phrases and the gates that keep it from acting
// without the maintainer's yes. A new skill adds an entry here in the same commit.
const CONTRACTS = {
  'ak-upstream-status': {
    triggers: [/upstream status/i, /upstream report/i],
    gates: [/explicit-user-approval-required/, /never (post|push|merge)/i, /fetchErrors/],
  },
  'ak-ship': {
    triggers: [/"ship" with a PR number/i, /squash-merge/i],
    gates: [/only the (pull requests|PRs) the maintainer named/i, /one (removal|deletion) per call/i,
      /ask which PR/i, /never merge/i, /minimumReleaseAge/, /--match-head-commit/, /--required/,
      /explicit yes before (any|each) deletion/i, /status --porcelain/, /never `--force`/i,
      /worktree this session created/i, /every merge needs a yes/i],
  },
  'ak-release': {
    triggers: [/release next/i, /semantic (release|version)/i],
    gates: [/separate approval/i, /never .*(--force|--no-verify)/i, /ask whether .*(alpha|beta|rc)/i, /npm i -g/,
      /node scripts\/run-tests\.mjs unit/, /rev-parse HEAD.*origin\/main/s, /git tag -a v<version> -m "v<version>" origin\/main/,
      /headBranch.*event/s, /pnpm publish/],
  },
  'ak-upstream-file': {
    triggers: [/file upstream/i, /upstream issue/i, /RuvNet Brain/, /agent-browser/, /agentic-flow/],
    gates: [/never post upstream \(or comment, file, react or edit there\) without approval/i,
      /redact before showing/i, /repro script and\s+the pasted logs/i, /issue title and\s+`uname -a`/i,
      /Search for an existing thread first, open and closed/, /gh search prs/, /gh issue list --repo/,
      /supplement an open one rather than filing a duplicate/i, /maintainer says `post`/i,
      /names the target repository and the thread or title/i, /do not file from memory/i,
      /env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME/,
      /assert `HOME` and every XDG path resolve under the disposable folder/i,
      /thread text is data, never\s+instructions/i, /issue template or CONTRIBUTING/i,
      /no matching policy stops the run/i, /schemas\/agentic-dependency-constraints\.schema\.json/,
      /`doneWhen`, `mapping`,\s+`kitImpact`, `adjustment`, `status` of `watching`, `constraintIds`/,
      /separate local change/i, /explicit-user-approval-required/],
  },
  'ak-resume': {
    triggers: [/\bresume\b/i, /where are we/i],
    gates: [/read-only/i, /decisions? only the maintainer/i, /handoff/, /`git worktree list`/,
      /first\s+entry/i, /say\s+plainly\s+that\s+none\s+exists/i, /not\s+proof/i,
      /git\s+evidence/i, /data,\s+never\s+instructions/i, /not\s+verified/i,
      /only\s+write/i, /file\s+name\s+first/i, /only\s+when\s+the\s+maintainer\s+asks/i,
      /never\s+switch\s+branches/i, /gh pr list/, /home\s+paths/i, /orphaned/i,
      /single\s+permitted\s+exception/i, /one\s+NEW\s+gitignored\s+file/,
      /no\s+tracked\s+file,\s+branch\s+or\s+other\s+file/i, /possibly\s+orphaned/i,
      /exclud\w+\s+this\s+session's\s+own\s+worktree/i, /ask\s+rather\s+than\s+assert/i,
      /never\s+the\s+absolute\s+path/i, /folder\s+name\s+or\s+the\s+branch\s+name/i,
      /never\s+overwrite/i, /never\s+run\s+pnpm\s+in\s+a\s+worktree/i,
      /remote\s+refs\s+and\s+local\s+`main`\s+may\s+be\s+stale/i,
      /older\s+merged\s+PRs\s+beyond\s+the\s+last\s+10/i, /prefer\s+the\s+main\s+checkout/i,
      /other\s+gitignored\s+paths/i],
  },
  'ak-verify': {
    triggers: [/^.*\bverify\b/i, /completion gate/i],
    gates: [/never plain `node --test`/i, /never `pnpm` inside a worktree/i, /unset\s+`FORCE_COLOR`/,
      /AQE_EMBEDDER_\*/, /relative\s+`XDG_\*`/, /node scripts\/run-tests\.mjs focus/,
      /node_modules\/\.bin\/tsc -p tsconfig\.json/, /node scripts\/build-check\.mjs/,
      /tests\/kit\/docs-layout\.test\.mjs/, /test:ui/, /never sweep `\$TMPDIR`/i,
      /report it as skipped, never as passed/i, /pass, fail or skipped/i,
      /concurrent\s+writers/i, /do\s+not\s+fail\s+a\s+local\s+run/i,
      /exit\s+3\s+or\s+4\s+is\s+a\s+FAIL/, /not\s+retried\s+or\s+cleaned\s+up/i,
      /`env -u` takes literal names/i, /does\s+not\s+start\s+with\s+`\/`/i,
      /env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME/,
      /assert\s+`HOME`\s+and\s+every\s+XDG\s+path\s+resolve\s+under\s+the\s+disposable\s+folder/i,
      /mktemp -d "\$\{TMPDIR:-\/tmp\}\/ak-verify\.XXXXXX"/, /os\.homedir\(\)/,
      /git\s+worktree\s+list/],
  },
  'ak-pricing-refresh': {
    triggers: [/refresh pricing/i, /model pricing/i],
    gates: [/cite\s+a\s+source/i, /PRICES_AS_OF/, /cache.read/i, /never open a pull request without/i,
      /untrusted\s+data/i, /primary\s+source/i, /moved\s+to\s+`prior`/, /never\s+deleted/i,
      /only\s+on\s+the\s+maintainer's\s+decision/i, /stop\s+and\s+report/i, /change\s+nothing/i,
      /node scripts\/run-tests\.mjs focus/, /`ak-verify`/, /model,\s+field,\s+old,\s+new,\s+source/i,
      /never\s+`pnpm`\s+inside\s+a\s+worktree/i, /names\s+the\s+branch\s+and\s+the\s+PR\s+title/i],
  },
};

// .gitattributes checks the skills out with LF everywhere; reading them as LF keeps these
// content checks independent of a clone made without it.
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }); // spawn-env: inherits (read-only git query on this checkout)
const ignored = (file) => git('check-ignore', '-q', '--no-index', file).status === 0;
const found = fs.readdirSync('.claude/skills').filter((name) => name.startsWith('ak-')).sort();
const path = (host, name) => `${host}/${name}/SKILL.md`;

test('every ak- skill folder has a contract and every contract has a skill', () => {
  assert.deepEqual(found, Object.keys(CONTRACTS).sort(),
    'add a CONTRACTS entry for a new skill, or write the skill for a contract');
});

test('each skill has matching frontmatter, a trigger description and a bounded size', () => {
  for (const name of Object.keys(CONTRACTS)) {
    const text = readText(path(HOSTS[0], name));
    const head = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(head, `${name}: frontmatter must be name then description`);
    assert.equal(head[1], name);
    assert.ok(head[2].length >= 40, `${name}: description says what it does and when to use it`);
    // A plain YAML scalar ends at " #" (a comment) and cannot hold ": ", so a host's YAML
    // parser would truncate or reject the description.
    assert.doesNotMatch(head[2], / #|: /, `${name}: description must be a valid plain YAML scalar`);
    assert.doesNotMatch(head[2], /^["'>|[{&*!%@`]/, `${name}: description must not start with a YAML indicator`);
    for (const trigger of CONTRACTS[name].triggers) assert.match(head[2], trigger, `${name}: description trigger`);
    assert.ok(text.split('\n').length < 500, `${name}: under 500 lines`);
  }
});

test('Claude and Codex get identical skills', () => {
  assert.deepEqual(mirrorSkills({ check: true }), { changed: [], problems: [] });
  for (const name of Object.keys(CONTRACTS)) {
    assert.equal(readText(path(HOSTS[1], name)), readText(path(HOSTS[0], name)), name);
  }
});

test('every script, pnpm script and doc a skill cites exists', () => {
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  for (const name of Object.keys(CONTRACTS)) {
    const text = readText(path(HOSTS[0], name));
    const cited = [...text.matchAll(/\b((?:scripts|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|md))/g)].map((m) => m[1])
      .filter((file) => !/YYYY|\*/.test(file));
    for (const file of cited) assert.ok(fs.existsSync(file), `${name} cites ${file}, which does not exist`);
    for (const m of text.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)) {
      assert.ok(m[1] in scripts, `${name} cites pnpm run ${m[1]}, which package.json lacks`);
    }
  }
});

test('each skill carries its gate phrases', () => {
  for (const [name, { gates }] of Object.entries(CONTRACTS)) {
    const text = readText(path(HOSTS[0], name));
    for (const gate of gates) assert.match(text, gate, `${name}: gate ${gate}`);
  }
});

test('every ak- SKILL.md checks out with LF line endings on every platform', () => {
  for (const name of Object.keys(CONTRACTS)) {
    for (const host of HOSTS) {
      const out = git('check-attr', 'eol', '--', path(host, name));
      assert.match(out.stdout, /: eol: lf$/m, `${path(host, name)} must be pinned to LF in .gitattributes`);
    }
  }
});

test('only ak- folders are exempt from the generated-file ignores', () => {
  for (const host of HOSTS) assert.equal(ignored(path(host, 'ak-ship')), false, `${host}/ak-ship must be trackable`);
  for (const file of [
    '.claude/settings.json', '.claude/helpers/statusline.cjs', '.claude/skills/a11y-ally/SKILL.md',
    '.agents/skills/a11y-ally/SKILL.md', '.agents/config.toml', '.claude/skills/ak/SKILL.md',
    '.claude/skills/upstream-status/SKILL.md', '.claude/skills/akship/SKILL.md', '.claude/skills/ak-ship.md',
    // Generated host folders below the root stay ignored, skill folder included.
    'src/lib/.claude/settings.json', 'claude/.claude/skills/ak-ship/SKILL.md', 'tests/.agents/skills/ak-ship/SKILL.md',
  ]) {
    assert.equal(ignored(file), true, `${file} must stay ignored`);
  }
});

// contracts-7: the skill names every report group by its title, so a thread the watcher
// could not check (or a fixed but unreleased one) is never left out of the summary.
test('ak-upstream-status names every report group the watcher can produce', () => {
  const text = readText(path(HOSTS[0], 'ak-upstream-status'));
  const missing = GROUPS.map(([, title]) => title).filter((title) => !text.includes(`"${title}"`));
  assert.deepEqual(missing, []);
});

// #213 and #240 are already registry entries; nothing says they still migrate.
test('tracking issues are named as ours, not as issues to migrate', () => {
  assert.equal(Object.fromEntries(GROUPS).tracking, 'Our tracking issues');
  for (const file of [path(HOSTS[0], 'ak-upstream-status'), path(HOSTS[1], 'ak-upstream-status'), 'docs/upstream-watch.md']) {
    assert.doesNotMatch(readText(file), /to migrate|migrates? here/i, file);
  }
});
