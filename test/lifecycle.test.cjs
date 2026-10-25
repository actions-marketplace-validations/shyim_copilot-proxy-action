const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

function environment(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'action-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, INPUT_TOKEN: 'test-token', INPUT_PORT: '0', 'INPUT_LOG-MODELS': 'false', GITHUB_OUTPUT: path.join(directory, 'output'), GITHUB_STATE: path.join(directory, 'state'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary') };
  return env;
}
const entries = file => Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));

test('action starts a detached loopback proxy, exposes outputs, and stops with a summary', async t => {
  const env = environment(t);
  await run(process.execPath, ['src/start.cjs'], { cwd: root, env });
  const outputs = entries(env.GITHUB_OUTPUT);
  t.after(() => { try { process.kill(Number(outputs.pid), 'SIGKILL'); } catch {} });
  t.after(() => fs.rmSync(path.dirname(outputs['usage-file']), { recursive: true, force: true }));
  assert.match(outputs['base-url'], /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal((await fetch(outputs['base-url'].replace('/v1', '/health'))).status, 200);
  const report = await (await fetch(outputs['usage-url'])).json();
  assert.deepEqual(report.models, []);
  const state = entries(env.GITHUB_STATE);
  await run(process.execPath, ['src/stop.cjs'], { cwd: root, env: { ...env, ...Object.fromEntries(Object.entries(state).map(([key, value]) => ['STATE_' + key, value])) } });
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Copilot proxy usage/);
  await assert.rejects(fetch(outputs['usage-url']));
  // Cleanup is idempotent if a runner invokes post after a startup failure.
  await run(process.execPath, ['src/stop.cjs'], { cwd: root, env: { ...env, 'STATE_proxy-pid': outputs.pid, 'STATE_usage-file': outputs['usage-file'] } });
});

test('occupied port fails startup promptly without exposing a usable output', async t => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...environment(t), INPUT_PORT: String(server.address().port) };
  await assert.rejects(run(process.execPath, ['src/start.cjs'], { cwd: root, env, timeout: 5000 }), error => {
    assert.match(error.stderr, /Proxy exited before becoming ready/);
    return true;
  });
  assert(!fs.existsSync(env.GITHUB_OUTPUT));
});
