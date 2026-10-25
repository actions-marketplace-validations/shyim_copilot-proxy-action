const assert = require('node:assert/strict');
(async () => {
  const base = process.env.OPENAI_BASE_URL;
  const calls = [
    ['/responses', { model: 'gpt-5.4-nano', input: 'Reply with OK.', max_output_tokens: 32 }],
    ['/chat/completions', { model: 'claude-haiku-4.5', messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: true, stream_options: { include_usage: true } }],
  ];
  for (const [endpoint, body] of calls) {
    const response = await fetch(base + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${body.model}: HTTP ${response.status}: ${text.slice(0, 1000)}`);
    console.log(`${body.model}: HTTP ${response.status}`);
  }
  const report = await (await fetch(base + '/usage')).json();
  assert.equal(report.requests.length, 2);
  assert(report.models.every(model => model.requestsWithTokens === 1), 'Both inference calls must report token counts');
  assert(report.models.every(model => model.failedRequests === 0));
  console.log(JSON.stringify(report.models, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
