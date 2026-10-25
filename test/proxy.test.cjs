const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createProxy } = require('../src/proxy.cjs');

async function fixture(t) {
  let requests = 0;
  const upstream = http.createServer(async (req, res) => {
    requests++;
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (input.model === 'failure') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3', connection: 'x-private-hop', 'x-private-hop': 'remove-me' });
      return res.end('{"error":{"message":"rate limited"}}');
    }
    if (input.model === 'stream-error') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"type":"error","error":{"message":"stream failed"}}\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"usage":{"input_tokens":3,"output_tokens":1}}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const proxy = createProxy('secret', { request: (options, cb) => http.request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }, cb) });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  return { base: `http://127.0.0.1:${proxy.address().port}`, requests: () => requests };
}
const post = (base, model) => fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });

test('rejects browser origins, rebinding hosts, invalid methods, and form content types before forwarding', async t => {
  const { base, requests } = await fixture(t);
  assert.equal((await fetch(base + '/models', { headers: { origin: 'https://attacker.example' } })).status, 403);
  const status = await new Promise(resolve => {
    http.get(base + '/models', { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
  assert.equal((await fetch(base + '/responses')).status, 404);
  assert.equal((await fetch(base + '/models', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/responses', { method: 'POST', body: 'model=test' })).status, 415);
  assert.equal(requests(), 0);
});

test('preserves HTTP errors and retry headers, removes hop-by-hop headers, and attributes failures', async t => {
  const { base } = await fixture(t);
  const response = await post(base, 'failure');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(response.headers.get('x-private-hop'), null);
  assert.match(await response.text(), /rate limited/);
  const report = await (await fetch(base + '/usage')).json();
  assert.equal(report.models[0].model, 'failure');
  assert.equal(report.models[0].failedRequests, 1);
  assert.equal(report.models[0].aiCredits, null);
  assert.equal(report.requests[0].status, 429);
});

test('an HTTP 200 SSE error is counted as failed without changing the client stream', async t => {
  const { base } = await fixture(t);
  const response = await post(base, 'stream-error');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /stream failed/);
  const report = await (await fetch(base + '/usage')).json();
  assert.equal(report.models[0].failedRequests, 1);
});

test('concurrent requests retain separate usage and requested-model fallback', async t => {
  const { base } = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, async () => (await post(base, 'shared')).text()));
  const report = await (await fetch(base + '/usage')).json();
  assert.equal(report.models[0].requests, 8);
  assert.equal(report.models[0].inputTokens, 24);
  assert.equal(report.models[0].outputTokens, 8);
  assert.equal(report.models[0].inFlightRequests, 0);
});
