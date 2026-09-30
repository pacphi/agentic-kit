import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function childEnv(root, project) {
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(home); fs.mkdirSync(tmp);
  return {
    PATH: process.env.PATH ?? '',
    ...(process.platform === 'win32' ? {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    } : {}),
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    LANG: 'en_US.UTF-8', CI: '1', NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    HERMES_HOME: path.join(home, 'hermes'), npm_config_prefix: path.join(home, 'npm-prefix'),
    npm_config_cache: path.join(home, 'npm-cache'),
    MISE_DATA_DIR: path.join(home, 'mise-data'), MISE_CONFIG_DIR: path.join(home, 'mise-config'),
    MISE_CACHE_DIR: path.join(home, 'mise-cache'), AQE_PROJECT_ROOT: project,
    AQE_MEMORY_PATH: path.join(project, '.agentic-qe', 'memory.db'),
    AQE_STORAGE_PATH: path.join(project, '.agentic-qe'),
    CLAUDE_FLOW_MEMORY_PATH: path.join(project, '.swarm'),
    CLAUDE_FLOW_DB_PATH: path.join(project, '.swarm', 'memory.db'),
    RUFLO_DAEMON_AUTOSTART: '0',
  };
}


export function snapshot(store) {
  return Object.fromEntries(fs.readdirSync(store).filter((n) => n.startsWith('patterns.rvf'))
    .sort().map((name) => {
      const file = path.join(store, name);
      return [name, { sha256: digest(file), bytes: fs.statSync(file).size }];
    }));
}

