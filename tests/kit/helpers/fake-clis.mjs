// tests/kit/helpers/fake-clis.mjs
// A folder of fake `npm`, `claude`, `codex`, `opencode`, `ruflo` and `ollama` launchers, so a real `ak`
// child process can run setup and uninstall with no network and no real installs. Every launcher runs
// fake-cli-main.mjs with this node, so the same fakes work on POSIX (`sh`) and Windows (`.cmd` + `.ps1`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli-main.mjs');
export const FAKE_CLI_NAMES = ['npm', 'claude', 'codex', 'opencode', 'ruflo', 'ollama'];

/**
 * @param {string} dir where to create the `bin` folder (outside the sandboxed HOME)
 * @param {{ globalRoot: string, codexConfig: string }} opts `npm root -g` answer and the file `codex mcp` edits
 * @returns {{ bin: string, log: string, calls: () => string[] }}
 */
export function installFakeClis(dir, { globalRoot, codexConfig }) {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'fake-cli.log');
  const configPath = path.join(dir, 'fake-cli.config.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(log, '');
  fs.writeFileSync(configPath, JSON.stringify({ log, globalRoot, codexConfig }));
  for (const name of FAKE_CLI_NAMES) {
    fs.writeFileSync(path.join(bin, name),
      `#!/bin/sh\nexec "${process.execPath}" "${MAIN}" "${configPath}" ${name} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${MAIN}" "${configPath}" ${name} %*\r\n`);
    // exec.mjs runs a Windows `.cmd` only when it is a recognised npm shim or has a sibling `.ps1`.
    fs.writeFileSync(path.join(bin, `${name}.ps1`),
      `& "${process.execPath}" "${MAIN}" "${configPath}" ${name} @args\r\nexit $LASTEXITCODE\r\n`);
  }
  return { bin, log, calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

/** A fake npm global root holding the packages `ak` looks for. */
export function fakeNpmRoot(dir, packages = { ruflo: '3.28.0', '@anthropic-ai/claude-code': '2.1.0' }) {
  const root = path.join(dir, 'npm-prefix', 'lib', 'node_modules');
  for (const [name, version] of Object.entries(packages)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, version }));
  }
  return root;
}
