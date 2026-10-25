const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProxy } = require('../src/proxy.cjs');
const { Observation, UsageTap, aggregate } = require('../src/usage.cjs');

async function parse(chunks, sse = false, limit) {
  const observation = new Observation();
  const tap = new UsageTap(observation, sse, limit);
  const output = [];
  tap.on('data', chunk => output.push(chunk));
  const done = new Promise((resolve, reject) => { tap.on('end', resolve); tap.on('error', reject); });
  for (const chunk of chunks) tap.write(Buffer.from(chunk));
  tap.end(); await done;
  assert.equal(Buffer.concat(output).toString(), chunks.join(''));
  return observation;
}

test('fragmented JSON preserves zero cost and cache/reasoning details', async () => {
  const json = JSON.stringify({ model: 'actual', usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 20 } }, copilot_usage: { total_nano_aiu: 0 } });
  const o = await parse([json.slice(0, 17), json.slice(17)]);
  assert.deepEqual(o.result('/chat/completions'), { model: 'actual', inputTokens: 100, outputTokens: 30, cachedInputTokens: 40, cacheWriteInputTokens: null, reasoningTokens: 20, totalNanoAiu: 0, observationLimited: false });
});

test('Responses SSE repeated cumulative totals count once; handles CRLF and chunk boundaries', async () => {
  const event = { type: 'response.completed', response: { model: 'test', usage: { input_tokens: 12, output_tokens: 7 }, copilot_usage: { total_nano_aiu: 500000000 } } };
  const data = `data: ${JSON.stringify(event)}\r\n\r\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
  const o = await parse([...data], true);
  const report = aggregate([{ ...o.result('/responses'), state: 'completed' }]);
  assert.equal(report.models[0].inputTokens, 12);
  assert.equal(report.models[0].aiCredits, 0.5);
  assert.equal(report.models[0].usdEquivalent, 0.005);
});

test('Anthropic streaming merges start and delta usage without losing input or double-counting output', async () => {
  const events = [
    { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } },
    { type: 'message_delta', usage: { output_tokens: 5 }, copilot_usage: { total_nano_aiu: 1000 } },
  ];
  const o = await parse(events.map(e => `data: ${JSON.stringify(e)}\n\n`), true);
  assert.equal(o.result('/v1/messages').inputTokens, 60);
  assert.equal(o.result('/v1/messages').outputTokens, 5);
});

test('missing billing remains unknown and coverage exposes partial totals', () => {
  const report = aggregate([
    { model: 'test', state: 'completed', inputTokens: 1, outputTokens: 2, totalNanoAiu: 0 },
    { model: 'test', state: 'failed' },
  ]);
  assert.equal(report.models[0].requests, 2);
  assert.equal(report.models[0].failedRequests, 1);
  assert.equal(report.models[0].requestsWithCost, 1);
  assert.equal(report.models[0].requestsWithTokens, 1);
  assert.equal(aggregate([{ model: 'test' }]).models[0].aiCredits, null);
});

test('oversized observations remain transparent and mark accounting as limited', async () => {
  const o = await parse(['{"huge":"', 'x'.repeat(100), '"}'], false, 16);
  assert.equal(o.limited, true);
  assert.equal(o.result('/responses').inputTokens, null);
  const sse = await parse(['data: ' + 'x'.repeat(100) + '\n\n', 'data: {"usage":{"output_tokens":2}}\n\n'], true, 64);
  assert.equal(sse.limited, true);
  assert.equal(sse.result('/responses').outputTokens, 2);
});

test('proxy forwards responses, overrides client credentials, persists usage, and excludes catalog requests', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer server-secret');
    assert.equal(req.headers['copilot-integration-id'], 'copilot-developer-cli');
    if (req.url === '/models') return res.end('{"data":[]}');
    assert.equal(req.url, '/chat/completions');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).model, 'requested');
    res.setHeader('content-type', 'text/event-stream');
    res.end('data: {"model":"resolved","usage":{"prompt_tokens":4,"completion_tokens":2},"copilot_usage":{"total_nano_aiu":12345}}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const file = path.join(directory, 'usage.json');
  const proxy = createProxy('server-secret', { usageFile: file, request: (options, cb) => http.request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }, cb) });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  await (await fetch(base + '/v1/models')).text();
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer client-secret', 'copilot-integration-id': 'wrong', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'requested', stream: true, messages: [] }) });
  assert.match(await response.text(), /\[DONE\]/);
  const report = await (await fetch(base + '/usage')).json();
  assert.equal(report.requests.length, 1);
  assert.equal(report.models[0].model, 'resolved');
  assert.equal(report.models[0].inputTokens, 4);
  assert.equal(report.models[0].totalNanoAiu, 12345);
  assert.equal(report.requests[0].state, 'completed');
  const saved = fs.readFileSync(file, 'utf8');
  assert(!saved.includes('server-secret'));
  assert(!saved.includes('client-secret'));
  assert(!saved.includes('messages'));
});
