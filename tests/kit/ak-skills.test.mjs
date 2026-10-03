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
      /never\s+`pnpm`\s+inside\s+a\s+worktree/i, /names\s+the\s+branch\s+and\s+the\s+PR\s+title/i,
      /`RETIRED_MODELS`[^.]*ask\s+the\s+maintainer\s+first,\s+naming\s+the\s+model\s+id\s+and\s+the\s+withdrawal\s+URL/i,
      /`CACHE_WRITE_1H_MULTIPLIER`/],
  },
  'ak-docs-gate': {
    triggers: [/docs gate/i, /docs (alignment|check)/i],
    gates: [/never\s+move\s+an\s+ADR/i, /never\s+create\s+a\s+folder\s+under\s+`docs\/`/i, /lower.case/i,
      /node scripts\/docs-relocate\.mjs/, /--dry-run/, /node scripts\/run-tests\.mjs focus tests\/kit\/docs-layout\.test\.mjs/,
      /never\s+delete\s+a\s+doc/i, /names\s+the\s+files/i, /one\s+row\s+per\s+file/i, /docs\/archive\/README\.md/,
      /current\s+state\s+only/i, /not\s+complete\s+until/i, /ask\s+whether\s+to\s+update\s+its\s+status\s+and\s+date/i,
      /never\s+`pnpm`\s+inside\s+a\s+worktree/i, /Done,\s+pending\s+archive/],
  },
  'ak-worktree-sweep': {
    triggers: [/\bsweep\b/i, /worktree sprawl/i],
    // Each gate pins its own sentence: the test reads the whole file, frontmatter included, and the
    // description already says "clean up worktrees" and "what can I delete".
    gates: [/One\s+removal\s+per\s+call:\s+list\s+the\s+literal\s+target/,
      /no\s+loops,\s+no\s+globs,\s+no\s+`xargs`,\s+no\s+`git branch -D`\s+over\s+a\s+list/,
      /Every\s+removal\s+needs\s+its\s+own\s+yes\s+naming\s+the\s+literal\s+absolute\s+path\s+or\s+branch/,
      /`git branch -D`\s+needs\s+a\s+yes\s+naming\s+the\s+branch\s+and\s+`-D`/, /A\s+general\s+"clean\s+up"\s+is\s+not\s+a\s+yes/,
      /Remove\s+only\s+on\s+a\s+yes\s+that\s+names\s+the\s+literal\s+absolute\s+path\s+or\s+branch\s+\(a\s+general\s+"clean\s+up"\s+is\s+not\s+a\s+yes\)/,
      /never\s+`rm -Rf`s\s+anything,\s+never\s+touches\s+a\s+path\s+directly\s+under\s+`~`\s+or\s+`\/`/,
      /never\s+removes\s+a\s+folder\s+that\s+is\s+not\s+a\s+registered\s+worktree/, /The\s+skill\s+never\s+runs\s+the\s+removal/,
      /`main`\s+branch,\s+this\s+session's\s+own\s+worktree\s+and\s+any\s+checkout\s+another\s+session\s+uses\s+are\s+never\s+candidates/,
      /Never\s+touch,\s+switch\s+branches\s+in\s+or\s+write\s+to\s+the\s+checkout\s+another\s+session\s+uses;\s+every\s+`status`\s+runs\s+with\s+`--no-optional-locks`/,
      /`git worktree list`/, /`git branch -vv`/, /`ls -d <main checkout's parent>\/agentic-kit\*`/,
      /resolving\s+both\s+sides\s+with\s+`realpath`/,
      /`git\s+-C\s+<path>\s+--no-optional-locks\s+status\s+--porcelain\s+--ignored`/,
      /`git\s+-C\s+<path>\s+reflog\s+-1\s+--date=iso`/, /an\s+entry\s+within\s+the\s+last\s+3\s+days\s+in\s+either\s+reflog/,
      /Any\s+`!!`\s+entry\s+other\s+than\s+the\s+`node_modules`\s+symlink\s+\(`!! node_modules`\s+with\s+no\s+trailing\s+slash[^)]*\)\s+makes\s+a\s+row\s+that\s+is\s+not\s+live\s+"ask":\s+the\s+question\s+names\s+each\s+entry/,
      /symlinks\s+are\s+reported,\s+never\s+followed/,
      /Any\s+live\s+signal\s+wins,\s+except\s+that\s+a\s+branch\s+whose\s+tip\s+equals\s+the\s+`headRefOid`\s+of\s+a\s+PR\s+merged\s+into\s+`main`\s+is\s+"possibly\s+squash-merged,\s+ask"/,
      // The exception exists for the branch's "commits on no remote ref"; it must never lift the
      // worktree's own signals, the HEAD reflog above all (the test for another session's checkout).
      /That\s+exception\s+lifts\s+only\s+the\s+branch's\s+own\s+signals\s+\(commits\s+on\s+no\s+remote\s+ref,\s+its\s+branch\s+reflog\),\s+and\s+inconclusive\s+beats\s+it/,
      /it\s+never\s+lifts\s+a\s+worktree's\s+signals:\s+a\s+worktree\s+with\s+any\s+live\s+signal\s+of\s+its\s+own,\s+including\s+its\s+HEAD\s+reflog,\s+is\s+left,\s+and\s+its\s+branch\s+waits\s+for\s+it/,
      /checked\s+out\s+in\s+a\s+worktree\s+other\s+than\s+the\s+one\s+being\s+removed/, /Possibly\s+merged:/,
      /Possibly\s+abandoned:/, /merged\s+PR\s+with\s+`baseRefName`\s+`main`/,
      /`gh pr list --state merged --head <branch> --json number,headRefOid,baseRefName`/, /`git branch --merged main`/,
      /`git log <branch> --not --remotes --oneline`/,
      /Claim\s+"nothing\s+unpushed"\s+only\s+when\s+`git ls-remote --heads origin <branch>`\s+prints\s+the\s+SHA\s+of\s+`git rev-parse origin\/<branch>`/,
      /`git merge-base --is-ancestor <branch> origin\/main`/,
      /show\s+`git\s+fetch\s+--prune\s+--dry-run`\s+before\s+asking,\s+since\s+a\s+pruned\s+stale\s+ref\s+may\s+hold\s+the\s+last\s+copy\s+of\s+commits/,
      /`git\s+branch\s+-d\s+<branch>`\s+checks\s+the\s+upstream\s+or,\s+when\s+that\s+is\s+gone\s+or\s+unset,\s+the\s+HEAD\s+of\s+the\s+checkout\s+running\s+the\s+command\s+\(not\s+`main`\)/,
      /fails\s+only\s+when\s+the\s+upstream\s+is\s+gone\s+or\s+unset/,
      /`git branch -D <branch>`\s+skips\s+git's\s+merge\s+check:\s+use\s+it\s+only\s+for\s+a\s+"possibly\s+squash-merged"\s+branch[^.]*only\s+on\s+a\s+yes\s+that\s+names\s+both\s+the\s+branch\s+and\s+`-D`/,
      /without\s+`--force`/,
      /One\s+removal\s+per\s+call,\s+each\s+on\s+its\s+own\s+yes,\s+a\s+worktree\s+before\s+its\s+branch/,
      /re-check\s+that\s+target\s+right\s+before\s+each\s+call:\s+the\s+same\s+`--no-optional-locks\s+status\s+--porcelain\s+--ignored`\s+output\s+the\s+maintainer\s+approved/,
      /show\s+the\s+`git worktree prune --dry-run -v`\s+list,\s+then\s+hand\s+the\s+maintainer\s+`git worktree prune -v`\s+and\s+do\s+not\s+run\s+it/,
      /`git -C <folder> rev-parse --show-toplevel`\s+equals\s+`realpath <folder>`/,
      /if\s+`ls\s+-A\s+<folder>`\s+prints\s+nothing\s+it\s+is\s+empty:\s+skip\s+the\s+git\s+checks/,
      /`git\s+-C\s+<folder>\s+--no-optional-locks\s+status\s+--porcelain\s+--ignored`/,
      // HEAD too: a commit made on a detached HEAD is on no branch, so `--branches` alone misses it.
      /`git\s+-C\s+<folder>\s+log\s+--branches\s+HEAD\s+--not\s+--remotes\s+--oneline`/, /`git -C <folder> stash list`/,
      /evidence,\s+not\s+proof:\s+that\s+clone's\s+remote\s+refs\s+may\s+be\s+stale/,
      /If\s+any\s+check\s+fails,\s+only\s+list\s+the\s+folder/,
      /`rmdir`\s+for\s+an\s+empty\s+folder,\s+`rm -Rf`\s+only\s+on\s+that\s+literal\s+absolute\s+path,\s+never\s+on\s+a\s+path\s+directly\s+under\s+`~`\s+or\s+`\/`/,
      /hand\s+the\s+maintainer\s+one\s+command\s+with\s+literal\s+absolute\s+paths[^.]*and\s+do\s+not\s+run\s+it/,
      /ending\s+with\s+an\s+`ls`\s+that\s+prints\s+nothing/, /ls -d \/abs\/path\/one \/abs\/path\/two 2>\/dev\/null/,
      /Anything\s+inconclusive\s+is\s+left\s+alone\s+and\s+reported/, /Never\s+sweep\s+`\$TMPDIR`/,
      /Never\s+`pnpm`\s+inside\s+a\s+worktree/, /what\s+was\s+removed\s+and\s+what\s+was\s+left/i],
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
  assert.deepEqual(mirrorSkills({ check: true }), { changed: [], removed: [], problems: [] });
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

// The LF pin covers Markdown only: a future image or binary beside a skill must not be forced to text.
test('the LF pin covers every ak- Markdown file and forces no other file to text', () => {
  for (const host of HOSTS) {
    assert.match(git('check-attr', 'eol', '--', `${host}/ak-ship/notes/extra.md`).stdout, /: eol: lf$/m);
    assert.match(git('check-attr', 'text', '--', `${host}/ak-ship/logo.png`).stdout, /: text: unspecified$/m);
  }
});

test('the markdown lint scripts lint the ak- skills', () => {
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  for (const name of ['lint:md', 'lint:md:fix']) assert.match(scripts[name], /"\.claude\/skills\/ak-\*\/SKILL\.md"/, name);
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

// A gate regex can prove a sentence is present, not that it is the only one: the class precedence
// is stated once, and every `status` the sweep runs on another checkout skips the index refresh
// (a write) and shows ignored files, which `git worktree remove` deletes with the folder.
test('ak-worktree-sweep states its precedence once and never runs a plain status', () => {
  const text = readText(path(HOSTS[0], 'ak-worktree-sweep'));
  assert.equal(text.match(/live\s+signal\s+wins/gi)?.length, 1);
  assert.doesNotMatch(text, /(?<!--no-optional-locks\s+)status\s+--porcelain/);
  assert.doesNotMatch(text, /status\s+--porcelain(?!\s+--ignored)/);
  // A bare `git status` or `git -C <path> status` takes the same index lock.
  assert.doesNotMatch(text, /\bgit\s+(?:-C\s+\S+\s+)?status\b/);
});

// #213 and #240 are already registry entries; nothing says they still migrate.
test('tracking issues are named as ours, not as issues to migrate', () => {
  assert.equal(Object.fromEntries(GROUPS).tracking, 'Our tracking issues');
  for (const file of [path(HOSTS[0], 'ak-upstream-status'), path(HOSTS[1], 'ak-upstream-status'), 'docs/upstream-watch.md']) {
    assert.doesNotMatch(readText(file), /to migrate|migrates? here/i, file);
  }
});
