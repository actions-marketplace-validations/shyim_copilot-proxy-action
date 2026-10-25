const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream');
const { Observation, UsageTap, UsageLedger } = require('./usage.cjs');

function createProxy(token, options = {}) {
  const ledger = new UsageLedger(options.usageFile);
  const send = options.request || https.request;
  const allowed = new Set(['/models', '/chat/completions', '/responses', '/embeddings', '/v1/messages']);
  return http.createServer((req, res) => {
    // This service is for runner processes, not browser pages. Reject browser
    // origins and rebinding hosts before accessing the workflow credential.
    const host = req.headers.host || '';
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
      res.writeHead(403).end('Loopback clients only');
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400).end('Invalid URL'); return; }
    if (url.pathname === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method === 'GET' && ['/usage', '/v1/usage'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ledger.persist()));
      return;
    }
    let path = url.pathname;
    if (path.startsWith('/v1/') && path !== '/v1/messages') path = path.slice(3);
    if (!allowed.has(path) || req.method !== (path === '/models' ? 'GET' : 'POST')) {
      res.writeHead(404).end('Unsupported endpoint');
      return;
    }
    if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      res.writeHead(415).end('Content-Type must be application/json');
      return;
    }
    // Never forward client credentials, routing headers, or integration identity.
    const headers = {
      authorization: `Bearer ${token}`,
      'copilot-integration-id': 'copilot-developer-cli',
      'user-agent': `copilot-proxy-action/${require('../package.json').version}`,
      accept: req.headers.accept || 'application/json',
    };
    for (const name of ['content-type', 'anthropic-version', 'anthropic-beta']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const record = req.method === 'POST' && path !== '/models' ? ledger.begin(path) : null;
    const observation = new Observation();
    let requestedModel = null;
    const requestTap = new UsageTap({ observe: value => {
      if (typeof value?.model === 'string') requestedModel = value.model;
    } });
    let finished = false;
    const finish = failed => {
      if (finished || !record) return;
      finished = true;
      Object.assign(record, observation.result(path));
      record.model ||= requestedModel;
      record.state = failed || observation.failed ? 'failed' : 'completed';
      record.finishedAt = new Date().toISOString();
      ledger.persist();
    };
    const upstream = send({
      hostname: 'api.githubcopilot.com', path: path + url.search,
      method: req.method, headers,
    }, response => {
      if (record) { record.status = response.statusCode; record.model = requestedModel; ledger.persist(); }
      const forwarded = { ...response.headers };
      for (const name of String(response.headers.connection || '').split(',')) delete forwarded[name.trim().toLowerCase()];
      for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'trailer']) delete forwarded[name];
      res.writeHead(response.statusCode, forwarded);
      const tap = new UsageTap(observation, String(response.headers['content-type']).includes('text/event-stream'));
      pipeline(response, tap, res, error => finish(Boolean(error) || response.statusCode >= 400));
    });
    upstream.setTimeout(180000, () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', () => {
      finish(true);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Copilot upstream request failed' } }));
      else res.destroy();
    });
    res.on('close', () => { if (!res.writableFinished) { finish(true); upstream.destroy(); } });
    pipeline(req, requestTap, upstream, error => { if (error) { finish(true); upstream.destroy(); } });
  });
}
module.exports = { createProxy };

if (require.main === module) {
  const token = process.env.COPILOT_PROXY_TOKEN;
  delete process.env.COPILOT_PROXY_TOKEN;
  if (!token) process.exit(1);
  const server = createProxy(token, { usageFile: process.env.COPILOT_PROXY_USAGE });
  server.on('error', () => process.exit(1));
  server.listen(Number(process.env.COPILOT_PROXY_PORT), '127.0.0.1', () => {
    require('node:fs').writeFileSync(process.env.COPILOT_PROXY_READY, JSON.stringify({ port: server.address().port }), { mode: 0o600 });
  });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 3000).unref(); });
}
