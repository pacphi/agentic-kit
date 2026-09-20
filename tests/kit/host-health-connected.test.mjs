import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHostConnection } from '../../src/lib/host-health-connected.mjs';

const help = '--safe-mode --print --output-format --tools --strict-mcp-config --mcp-config --settings --no-session-persistence --disable-slash-commands --permission-mode --json --sandbox --ephemeral --disable --pure --agent --format';
const features = ['plugins', 'remote_plugin', 'hooks', 'apps', 'shell_tool', 'unified_exec', 'multi_agent', 'skill_mcp_dependency_install', 'browser_use', 'computer_use', 'code_mode', 'code_mode_host', 'image_generation', 'workspace_dependencies'].map(x => `${x} stable true`).join('\n');
function boundary(host, response, calls = []) {
  return async (command, args, opts) => {
    calls.push({ command, args, opts });
    if (args.includes('--help')) return { code: 0, stdout: help, stderr: '' };
    if (args.includes('features')) return { code: 0, stdout: args.includes('--disable') ? features.replaceAll('true', 'false') : features, stderr: '' };
    if (args.includes('mcp')) return { code: 0, stdout: JSON.stringify([{ name: 'my-server', enabled: !args.some(a => a.includes('enabled=false')) }]), stderr: '' };
    if (args.includes('debug')) return { code: 0, stdout: opts.env?.OPENCODE_CONFIG_CONTENT?.includes('ak-health-') ? opts.env.OPENCODE_CONFIG_CONTENT : JSON.stringify({ mcp: { local: { type: 'local', command: ['missing'] } } }), stderr: '' };
    const challenge = opts.input.match(/AK_HEALTH_[a-f0-9]+/)[0];
    const outputs = {
      claude: [{ type: 'result', subtype: 'success', is_error: false, result: challenge }],
      codex: [{ type: 'item.completed', item: { type: 'agent_message', text: challenge } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }],
      opencode: [{ type: 'text', part: { text: challenge } }, { type: 'step_finish', part: { reason: 'stop' } }],
    };
    return response?.(outputs[host], challenge) ?? { code: 0, stdout: outputs[host].map(x => JSON.stringify(x)).join('\n'), stderr: '' };
  };
}
const base = { cwd: process.cwd(), confirm: true };
for (const host of ['claude', 'codex', 'opencode']) {
  test(`${host} passes only on completed matching native response`, async () => {
    const result = await checkHostConnection({ ...base, host, run: boundary(host) });
    assert.equal(result.state, 'pass');
    assert.equal(result.integrations.state, 'not-checked');
  });
  test(`${host} does not treat exit zero as completion`, async () => {
    const result = await checkHostConnection({ ...base, host, run: boundary(host, () => ({ code: 0, stdout: '{}', stderr: '' })) });
    assert.equal(result.state, 'unknown');
  });
  test(`${host} suppresses native error text including secrets`, async () => {
    const result = await checkHostConnection({ ...base, host, run: boundary(host, () => ({ code: 1, stdout: 'SECRET', stderr: 'SECRET' })) });
    assert.equal(result.state, 'fail');
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  });
}
test('requires affirmative consent before any native process', async () => {
  let calls = 0;
  const result = await checkHostConnection({ ...base, confirm: false, host: 'codex', run: async () => { calls++; } });
  assert.equal(result.state, 'unknown');
  assert.equal(calls, 0);
});
test('timeout is unknown and not a broken installation', async () => {
  const result = await checkHostConnection({ ...base, host: 'claude', run: boundary('claude', () => ({ code: 1, stdout: '', stderr: 'timed out after 60000ms' })) });
  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /timed out/i);
});
test('unsupported required flags never launch inference', async () => {
  let calls = 0;
  const result = await checkHostConnection({ ...base, host: 'claude', run: async () => { calls++; return { code: 0, stdout: '--print', stderr: '' }; } });
  assert.equal(result.state, 'unknown');
  assert.equal(calls, 1);
});
test('Codex disables integrations before inference and uses read-only sandbox', async () => {
  const calls = [];
  await checkHostConnection({ ...base, host: 'codex', run: boundary('codex', undefined, calls) });
  const call = calls.at(-1);
  assert.ok(call.args.includes('mcp_servers.my-server.enabled=false'));
  assert.ok(call.args.includes('plugins'));
  assert.ok(call.args.includes('read-only'));
  assert.ok(call.args.includes('approval_policy="never"'));
  assert.ok(call.opts.timeout <= 60000);
  assert.ok(call.opts.maxBuffer <= 256 * 1024);
});
test('OpenCode uses tool-denying agent and disables discovered MCP', async () => {
  const calls = [];
  await checkHostConnection({ ...base, host: 'opencode', run: boundary('opencode', undefined, calls) });
  const call = calls.at(-1);
  const config = JSON.parse(call.opts.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.mcp.local.enabled, false);
  assert.equal(Object.values(config.agent)[0].permission, 'deny');
  assert.ok(call.args.includes('--pure'));
  assert.equal(config.share, 'disabled');
});
test('Codex tool activity cannot pass even with a matching final response', async () => {
  const result = await checkHostConnection({ ...base, host: 'codex', run: boundary('codex', events => ({ code: 0, stdout: [...events, { type: 'item.completed', item: { type: 'mcp_tool_call' } }].map(x => JSON.stringify(x)).join('\n'), stderr: '' })) });
  assert.equal(result.state, 'unknown');
});
test('malformed options never start subprocesses', async () => {
  await assert.rejects(checkHostConnection({ ...base, host: 'invalid' }), TypeError);
  await assert.rejects(checkHostConnection({ ...base, host: 'codex', model: '--bad' }), TypeError);
  await assert.rejects(checkHostConnection({ ...base, host: 'codex', cwd: 'relative' }), TypeError);
});
test('Codex refuses inference when a safety feature remains enabled', async () => {
  const run = boundary('codex');
  const result = await checkHostConnection({ ...base, host: 'codex', run: async (command, args, opts) => {
    if (args.includes('features') && args.includes('--disable')) return { code: 0, stdout: features, stderr: '' };
    return run(command, args, opts);
  } });
  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /isolation/);
});
test('Codex refuses inference when native MCP override verification fails', async () => {
  const run = boundary('codex');
  const result = await checkHostConnection({ ...base, host: 'codex', run: async (command, args, opts) => {
    if (args.some(arg => arg.includes('enabled=false'))) return { code: 0, stdout: '[{"name":"other","enabled":true}]', stderr: '' };
    return run(command, args, opts);
  } });
  assert.equal(result.state, 'unknown');
});
test('abort before check does not launch any subprocess', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await checkHostConnection({ ...base, host: 'claude', signal: controller.signal, run: async () => { calls++; } });
  assert.equal(result.state, 'unknown');
  assert.equal(calls, 0);
});
test('native calls receive cancellation signal', async () => {
  const controller = new AbortController();
  const calls = [];
  await checkHostConnection({ ...base, host: 'claude', signal: controller.signal, run: boundary('claude', undefined, calls) });
  assert.ok(calls.every(call => call.opts.signal === controller.signal));
});
test('Claude excludes startup customizations and all tools', async () => {
  const calls = [];
  await checkHostConnection({ ...base, host: 'claude', run: boundary('claude', undefined, calls) });
  const args = calls.at(-1).args;
  assert.ok(args.includes('--safe-mode'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('{"mcpServers":{}}'));
  assert.ok(args.includes('{"disableAllHooks":true}'));
});
test('a completed answer for the wrong nonce never passes', async () => {
  const result = await checkHostConnection({ ...base, host: 'claude', run: boundary('claude', () => ({ code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'AK_HEALTH_old' }), stderr: '' })) });
  assert.equal(result.state, 'unknown');
});
test('Codex missing optional feature does not prevent a supported probe', async () => {
  const run = boundary('codex');
  const result = await checkHostConnection({ ...base, host: 'codex', run: async (command, args, opts) => {
    const output = await run(command, args, opts);
    if (args.includes('features')) output.stdout = output.stdout.split('\n').filter(line => !line.startsWith('code_mode')).join('\n');
    return output;
  } });
  assert.equal(result.state, 'pass');
});
test('Codex pinned unified_exec does not defeat read-only shell policy', async () => {
  const run = boundary('codex');
  const result = await checkHostConnection({ ...base, host: 'codex', run: async (command, args, opts) => {
    const output = await run(command, args, opts);
    if (args.includes('features')) output.stdout = output.stdout.replace('unified_exec stable false', 'unified_exec stable true');
    return output;
  } });
  assert.equal(result.state, 'pass');
});
test('Codex names unsupported by its dotted override parser do not start inference', async () => {
  const run = boundary('codex');
  const result = await checkHostConnection({ ...base, host: 'codex', run: async (command, args, opts) => {
    if (args.includes('mcp')) return { code: 0, stdout: '[{"name":"has.dot","enabled":true}]', stderr: '' };
    return run(command, args, opts);
  } });
  assert.equal(result.state, 'unknown');
});
test('OpenCode accepts native help written to stderr', async () => {
  const run = boundary('opencode');
  const result = await checkHostConnection({ ...base, host: 'opencode', run: async (command, args, opts) => {
    if (args.includes('--help')) return { code: 0, stdout: '', stderr: help };
    return run(command, args, opts);
  } });
  assert.equal(result.state, 'pass');
});

test('OpenCode refuses managed overrides that weaken effective connection isolation', async () => {
  for (const weaken of [
    config => { config.mcp.injected={enabled:true}; },
    config => { config.permission={'*':'deny',edit:'allow'}; },
    config => { Object.values(config.agent)[0].permission='allow'; },
    config => { Object.values(config.agent)[0].steps=10; },
  ]) {
    let inference=0;
    const run=boundary('opencode',()=>{inference++;return {code:0,stdout:'{}',stderr:''};});
    const result=await checkHostConnection({...base,host:'opencode',run:async(command,args,opts)=>{
      const output=await run(command,args,opts);
      if(args.includes('debug')&&opts.env?.OPENCODE_CONFIG_CONTENT?.includes('ak-health-')){
        const config=JSON.parse(output.stdout);weaken(config);output.stdout=JSON.stringify(config);
      }
      return output;
    }});
    assert.equal(result.state,'unknown');assert.equal(inference,0);
  }
});

test('Claude documented extended-context model selectors retain their exact selection', async () => {
  const calls=[];
  const result=await checkHostConnection({...base,host:'claude',model:'sonnet[1m]',run:boundary('claude',undefined,calls)});
  assert.equal(result.state,'pass');
  assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('--model')+1],'sonnet[1m]');
});

test('OpenCode preserves valid inline JSONC while applying connection restrictions', async () => {
  const result=await checkHostConnection({...base,host:'opencode',env:{OPENCODE_CONFIG_CONTENT:'{ /* supported */ "model":"provider/model", }'},run:boundary('opencode')});
  assert.equal(result.state,'pass');
});

test('native runner delivers the challenge over stdin and bounds a timed-out process tree', { skip: process.platform === 'win32' }, async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-health-process-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--help')){console.log(${JSON.stringify(help)});process.exit(0);}
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 if(process.env.AK_HEALTH_TEST_HANG==='1'){
  const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.writeFileSync(process.env.AK_HEALTH_TEST_PID,String(child.pid));setInterval(()=>{},1000);return;
 }
 const result=input.match(/AK_HEALTH_[a-f0-9]+/)[0];
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result}));
});
`, { mode: 0o700 });
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH };
  const success = await checkHostConnection({ ...base, cwd: dir, host: 'claude', env });
  assert.equal(success.state, 'pass');
  const pidFile = path.join(dir, 'child.pid');
  const failed = await checkHostConnection({ ...base, cwd: dir, host: 'claude', timeoutMs: 800,
    env: { ...env, AK_HEALTH_TEST_HANG: '1', AK_HEALTH_TEST_PID: pidFile } });
  assert.equal(failed.state, 'unknown');
  assert.match(failed.reason, /timed out/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { if (alive()) process.kill(pid, 'SIGKILL'); });
  for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(), false, 'owned grandchild was reaped');
});

test('Claude JSON result accepts valid pretty-printed native output', async () => {
  const result = await checkHostConnection({ ...base, host: 'claude', run: boundary('claude', events => ({code:0,stdout:JSON.stringify(events[0],null,2),stderr:''})) });
  assert.equal(result.state, 'pass');
});
