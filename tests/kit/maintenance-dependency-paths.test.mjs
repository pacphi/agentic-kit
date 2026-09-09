import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMcpRegistrationFacts, probeDependencies } from '../../src/lib/maintenance/management/dependency-probes.mjs';

const READERS = {
  claude: (command) => ({ paths: { claudeJson: '/config/claude.json' }, text: JSON.stringify({ mcpServers: { demo: { command } } }) }),
  codex: (command) => ({ paths: { codexConfigToml: '/config/codex.toml' }, text: '[mcp_servers.demo]\ncommand = ' + JSON.stringify(command) + '\n' }),
  opencode: (command) => ({ paths: { opencodeConfig: '/config/opencode.json' }, text: JSON.stringify({ mcp: { demo: { type: 'local', command: [command, '--private-argument'] } } }) }),
};

function fixture(host, command, { files = [], dirs = [] } = {}) {
  const config = READERS[host](command);
  const configPath = Object.values(config.paths)[0];
  const checked = [];
  const fsImpl = {
    lstatSync(target) {
      checked.push(target);
      if (target === configPath || files.includes(target)) return { isFile: () => true, size: config.text.length };
      if (dirs.includes(target)) return { isDirectory: () => true };
      throw new Error('ENOENT');
    },
    readFileSync(target) {
      assert.equal(target, configPath, 'only configuration is read; executable contents are never opened');
      return config.text;
    },
  };
  const facts = collectMcpRegistrationFacts({ fsImpl, paths: config.paths, hosts: [host] });
  checked.length = 0;
  return { facts, fsImpl, checked };
}

for (const host of Object.keys(READERS)) {
  for (const platform of ['darwin', 'win32']) {
    const windows = platform === 'win32';
    const absent = windows ? 'C:\\missing\\node.EXE' : '/missing/node';
    const present = windows ? 'C:\\private-tools\\node.EXE' : '/private-tools/node';
    const pathDir = windows ? 'C:\\bin' : '/usr/bin';
    const pathFile = windows ? 'C:\\bin\\node.EXE' : '/usr/bin/node';

    test(`${host}/${platform}: missing configured absolute command cannot borrow a matching PATH executable`, () => {
      const f = fixture(host, absent, { files: [pathFile], dirs: [pathDir] });
      const [result] = probeDependencies({ ...f, pathEntries: [pathDir], platform });
      assert.equal(result.satisfied, false);
      assert.deepEqual(f.checked, [absent]);
    });

    test(`${host}/${platform}: present configured absolute command succeeds independently of PATH`, () => {
      const f = fixture(host, present, { files: [present] });
      const [result] = probeDependencies({ ...f, pathEntries: [], platform });
      assert.equal(result.satisfied, true);
      assert.deepEqual(f.checked, [present]);
      assert.equal(result.requirement, windows ? 'node.EXE' : 'node');
      assert.equal(JSON.stringify({ facts: f.facts, result }).includes('private-tools'), false);
      assert.equal(JSON.stringify(f.facts).includes('private-argument'), false);
    });
  }
}
