// Point this process's os.tmpdir() (and every child it spawns) at a private
// folder that is removed on exit. For the plain-script .cjs suites, which have
// no node:test hooks: they make many temp folders, and the statusline renders
// they run drop ruflo-daemon-count.json / ruvnet-brain-kb-size.json into
// os.tmpdir(). Call it before anything reads os.tmpdir().
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function usePrivateTmpdir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  process.env.TMPDIR = dir;
  process.env.TEMP = dir;
  process.env.TMP = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

module.exports = { usePrivateTmpdir };
