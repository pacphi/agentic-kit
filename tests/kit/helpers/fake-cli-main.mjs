// tests/kit/helpers/fake-cli-main.mjs
// One stand-in for the host CLIs and npm, run as `node fake-cli-main.mjs <config.json> <name> <args...>`
// by the launchers fake-clis.mjs writes. It logs every call, answers the few questions ak asks, and
// makes `codex mcp add|remove` really edit a config.toml so a teardown can be seen undoing it.
import fs from 'node:fs';

const [configPath, name, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.appendFileSync(config.log, `${name} ${args.join(' ')}\n`);

const out = (text) => { process.stdout.write(`${text}\n`); };
const tomlString = (value) => JSON.stringify(String(value));
const tableHeader = (server) => `[mcp_servers.${server}]`;

function codexMcp([verb, server, ...rest]) {
  const file = config.codexConfig;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (verb === 'add') {
    const command = rest.slice(rest.indexOf('--') + 1);
    if (text && !text.endsWith('\n')) text += '\n';
    text += `\n${tableHeader(server)}\ncommand = ${tomlString(command[0])}\nargs = [${command.slice(1).map(tomlString).join(', ')}]\n`;
    fs.writeFileSync(file, text);
  } else if (verb === 'remove') {
    const lines = text.split('\n');
    const kept = [];
    let skipping = false;
    for (const line of lines) {
      if (line.trim() === tableHeader(server)) { skipping = true; if (kept.at(-1) === '') kept.pop(); continue; }
      if (skipping && line.startsWith('[')) skipping = false;
      if (!skipping) kept.push(line);
    }
    let result = kept.join('\n');
    if (text.endsWith('\n') && !result.endsWith('\n')) result += '\n';
    fs.writeFileSync(file, result);
  }
}

if (name === 'npm') {
  if (args[0] === 'root' && args[1] === '-g') { out(config.globalRoot); process.exit(0); }
  process.exit(1); // nothing is ever installed, uninstalled or looked up for real
}
if (args[0] === '--version' || args[0] === '-v') {
  out({ claude: '2.1.0 (Claude Code)', codex: 'codex-cli 0.159.1', ruflo: '3.28.0', opencode: '1.14.0', ollama: '0.12.0' }[name] ?? '1.0.0');
  process.exit(0);
}
if (name === 'codex' && args[0] === 'mcp') codexMcp(args.slice(1));
if (name === 'ollama' && args[0] === 'list') out('NAME ID SIZE MODIFIED');
process.exit(0);
