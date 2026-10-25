const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

(async () => {
  const token = process.env.INPUT_TOKEN;
  if (!token) throw new Error('token input is required');
  console.log(`::add-mask::${token.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  const portInput = process.env.INPUT_PORT || '0';
  const port = /^\d+$/.test(portInput) ? Number(portInput) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-'));
  const ready = path.join(directory, 'ready.json');
  const usageFile = path.join(directory, 'usage.json');
  const child = spawn(process.execPath, [path.join(__dirname, 'proxy.cjs')], {
    detached: true, stdio: 'ignore',
    env: { PATH: process.env.PATH, RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, COPILOT_PROXY_TOKEN: token, COPILOT_PROXY_PORT: String(port), COPILOT_PROXY_READY: ready, COPILOT_PROXY_USAGE: usageFile },
  });
  let childError;
  let exited = false;
  child.on('error', error => { childError = error; });
  child.on('exit', () => { exited = true; });
  child.unref();
  let started = false;
  try {
    if (child.pid) fs.appendFileSync(process.env.GITHUB_STATE, `proxy-pid=${child.pid}\nusage-file=${usageFile}\n`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (childError) throw new Error(`Could not spawn proxy: ${childError.message}`);
      if (exited) throw new Error('Proxy exited before becoming ready; check that the requested port is available');
      if (fs.existsSync(ready)) {
        const { port: actualPort } = JSON.parse(fs.readFileSync(ready, 'utf8'));
        const base = `http://127.0.0.1:${actualPort}/v1`;
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `base-url=${base}\npid=${child.pid}\nusage-file=${usageFile}\nusage-url=${base}/usage\n`);
        console.log(`Copilot proxy listening at ${base}`);
        started = true;
        if (process.env['INPUT_LOG-MODELS'] !== 'false') {
          console.log('::group::Copilot model catalog');
          try {
            const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const catalog = await response.json();
            if (!Array.isArray(catalog.data)) throw new Error('Unexpected model catalog format');
            const models = catalog.data.filter(model => typeof model?.id === 'string')
              .sort((a, b) => a.id.localeCompare(b.id));
            const clean = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ');
            console.log(`${models.length} models returned (catalog entries may be disabled by policy):`);
            console.log(`  ${'Model'.padEnd(44)} ${'Policy'.padEnd(12)} Endpoints`);
            for (const model of models) {
              const endpoints = Array.isArray(model.supported_endpoints) ? model.supported_endpoints.join(', ') : 'not specified';
              console.log(`  ${clean(model.id).padEnd(44)} ${clean(model.policy?.state ?? 'unspecified').padEnd(12)} ${clean(endpoints)}`);
            }
          } catch (error) {
            console.log(`::warning::Could not list Copilot models at startup: ${error.message.replace(/[\r\n]/g, ' ')}`);
          } finally {
            console.log('::endgroup::');
          }
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!started) throw new Error('Proxy did not become ready');
  } finally {
    if (started) fs.rmSync(ready, { force: true });
    else fs.rmSync(directory, { recursive: true, force: true });
    if (!started && child.pid && !exited) {
      try { process.kill(child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
