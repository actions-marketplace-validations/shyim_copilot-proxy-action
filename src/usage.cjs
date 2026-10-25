const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { Transform } = require('node:stream');
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

class Observation {
  constructor() { this.model = null; this.tokens = {}; this.nano = null; this.limited = false; this.failed = false; }
  observe(value) {
    if (!value || typeof value !== 'object') return;
    if (['error', 'response.failed', 'response.cancelled', 'response.canceled'].includes(value.type)) this.failed = true;
    for (const item of [value, value.response, value.message]) {
      if (!item || typeof item !== 'object') continue;
      if (item.error || ['failed', 'cancelled', 'canceled'].includes(item.status)) this.failed = true;
      if (typeof item.model === 'string') this.model = item.model;
      const u = item.usage;
      if (u && typeof u === 'object') {
        const set = (key, number) => { if (valid(number)) this.tokens[key] = number; };
        set('input', u.prompt_tokens ?? u.input_tokens);
        set('output', u.completion_tokens ?? u.output_tokens);
        set('cached', u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens);
        set('cacheWrite', u.cache_creation_input_tokens);
        set('reasoning', u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens);
      }
      const billing = item.copilot_usage ?? u?.copilot_usage;
      if (valid(billing?.total_nano_aiu)) this.nano = billing.total_nano_aiu;
    }
  }
  result(endpoint) {
    const t = this.tokens;
    // Anthropic reports uncached input separately; OpenAI includes cached input.
    const input = t.input === undefined ? null : t.input + (endpoint === '/v1/messages' ? (t.cached ?? 0) + (t.cacheWrite ?? 0) : 0);
    return {
      model: this.model, inputTokens: input, outputTokens: t.output ?? null,
      cachedInputTokens: t.cached ?? null, cacheWriteInputTokens: t.cacheWrite ?? null,
      reasoningTokens: t.reasoning ?? null, totalNanoAiu: this.nano,
      observationLimited: this.limited,
    };
  }
}

// Observe without rewriting or buffering the forwarded stream. Memory is bounded
// per JSON document/SSE event; oversized documents are forwarded but unaccounted.
class UsageTap extends Transform {
  constructor(observation, sse = false, limit = 32 * 1024 * 1024) {
    super(); this.observation = observation; this.sse = sse;
    this.limit = limit; this.decoder = new StringDecoder('utf8');
    this.buffer = ''; this.dropping = false; this.data = []; this.eventSize = 0;
  }
  parse(text) { try { this.observation.observe(JSON.parse(text)); } catch {} }
  line(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      if (!this.dropping && this.data.length) this.parse(this.data.join('\n'));
      this.data = []; this.eventSize = 0; this.dropping = false;
    } else if (line.startsWith('data:') && !this.dropping) {
      const data = line.slice(5).replace(/^ /, '');
      this.eventSize += data.length;
      if (this.eventSize > this.limit) { this.observation.limited = true; this.dropping = true; this.data = []; }
      else this.data.push(data);
    }
  }
  consume(text) {
    if (!this.sse) {
      if (!this.dropping) {
        if (this.buffer.length + text.length > this.limit) { this.observation.limited = true; this.dropping = true; this.buffer = ''; }
        else this.buffer += text;
      }
      return;
    }
    // Split before appending, so even a huge upstream chunk stays bounded.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (this.buffer.length + lines[i].length > this.limit) {
        this.observation.limited = true; this.dropping = true; this.buffer = '';
      } else this.buffer += lines[i];
      if (i < lines.length - 1) { this.line(this.buffer); this.buffer = ''; }
    }
  }
  _transform(chunk, encoding, callback) {
    this.consume(this.decoder.write(chunk));
    callback(null, chunk);
  }
  _flush(callback) {
    this.consume(this.decoder.end());
    if (this.sse) { if (this.buffer) this.line(this.buffer); this.line(''); }
    else if (!this.dropping) this.parse(this.buffer);
    callback();
  }
}

function aggregate(records) {
  const groups = new Map();
  const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens', 'totalNanoAiu'];
  for (const record of records) {
    const model = record.model || '(unknown)';
    if (!groups.has(model)) groups.set(model, { model, requests: 0, failedRequests: 0, inFlightRequests: 0, requestsWithTokens: 0, requestsWithCost: 0, ...Object.fromEntries(fields.map(f => [f, null])) });
    const row = groups.get(model);
    row.requests++;
    if (record.state === 'in_flight') row.inFlightRequests++;
    if (record.state === 'failed') row.failedRequests++;
    if (record.inputTokens != null && record.outputTokens != null) row.requestsWithTokens++;
    if (record.totalNanoAiu != null) row.requestsWithCost++;
    for (const field of fields) if (record[field] != null) row[field] = (row[field] ?? 0) + record[field];
  }
  const models = [...groups.values()].sort((a, b) => a.model.localeCompare(b.model));
  for (const row of models) {
    row.aiCredits = row.totalNanoAiu === null ? null : row.totalNanoAiu / 1e9;
    row.usdEquivalent = row.aiCredits === null ? null : row.aiCredits * 0.01;
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), costBasis: 'Server-reported nano-AIU; 1e9 nano-AIU = 1 AI credit; USD equivalent at $0.01 per credit. Not an invoice. Missing usage is unknown; totals include only reported values.', models, requests: records };
}
function markdown(report) {
  const cell = value => String(value).replace(/[|`<>\r\n]/g, '_');
  const number = value => value === null ? 'unknown' : value.toLocaleString('en-US', { maximumFractionDigits: 8 });
  let text = '## Copilot proxy usage\n\n| Model | Requests | Failed / in flight | Input tokens | Output tokens | Cached input | Cache write | AI credits | USD equivalent | Token / cost coverage |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n';
  for (const row of report.models) text += `| ${cell(row.model)} | ${row.requests} | ${row.failedRequests} / ${row.inFlightRequests} | ${number(row.inputTokens)} | ${number(row.outputTokens)} | ${number(row.cachedInputTokens)} | ${number(row.cacheWriteInputTokens)} | ${number(row.aiCredits)} | ${number(row.usdEquivalent)} | ${row.requestsWithTokens} / ${row.requestsWithCost} of ${row.requests} |\n`;
  if (!report.models.length) text += '\nNo inference requests observed. Catalog requests are excluded.\n';
  return text + '\nTotals include only reported values; coverage shows requests with both input/output tokens and requests with cost. Cached input is included in input totals; reasoning is included in output totals. Missing values are unknown. USD equivalent is usage value, not an invoice or additional amount due. No prompts, completions, or credentials are saved.\n';
}
class UsageLedger {
  constructor(file) { this.file = file; this.records = []; this.persist(); }
  begin(endpoint) {
    const record = { model: null, endpoint, startedAt: new Date().toISOString(), state: 'in_flight', status: null };
    this.records.push(record); this.persist();
    return record;
  }
  persist() {
    const report = aggregate(this.records);
    if (this.file) {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    }
    return report;
  }
}
module.exports = { Observation, UsageTap, UsageLedger, aggregate, markdown };
