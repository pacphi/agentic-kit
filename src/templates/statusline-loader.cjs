#!/usr/bin/env node
// agentic-kit statusline loader (written by `ak sync`; edits are overwritten).
//
// Ruflo 3.51+ signs .claude/helpers/statusline.cjs, and every `ruflo hooks statusline --json`
// call (the helper's own data source) restores a helper whose hash differs from the signed
// manifest. So the kit's footer and bin fix are not written into that file.
// This loader reads the helper, patches the text in memory, and runs it as the helper itself;
// statusline.cjs stays byte-identical. Any problem falls back to the stock helper.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const helper = path.join(__dirname, 'statusline.cjs');
const footerFile = path.join(__dirname, 'ak-statusline-footer.cjs');

function patch(src, footer) {
  const lines = src.split('\n');
  lines.splice(lines[0] && lines[0].startsWith('#!') ? 1 : 0, 0, footer);
  return lines.join('\n').replace(/console\.log\(generateStatusline\(\)\)/,
    'console.log(generateStatusline() + rufloActivationSegments(process.cwd()))');
}

function parses(body) {
  try {
    new vm.Script('(function(exports,require,module,__filename,__dirname){' + body + '\n})');
    return true;
  } catch { return false; }
}

function run(src) {
  const mod = new Module(helper, module);
  mod.filename = helper;
  mod.paths = Module._nodeModulePaths(__dirname);
  mod._compile(src, helper);
}

const stock = fs.readFileSync(helper, 'utf8');
let source = stock;
try {
  const patched = patch(stock, fs.readFileSync(footerFile, 'utf8'));
  if (parses(patched.replace(/^#!.*\n/, ''))) source = patched;
} catch { /* footer unreadable: render the stock helper */ }
run(source);
