# Copilot Proxy Action

[![CI](https://github.com/shyim/copilot-proxy-action/actions/workflows/ci.yml/badge.svg)](https://github.com/shyim/copilot-proxy-action/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-purple)](LICENSE)

Use Copilot models from API clients in a GitHub Actions job. This action starts
a local proxy, supplies the workflow credential and Copilot integration header,
and writes a table of models, tokens, and cost to the job summary.

- OpenAI-compatible Chat Completions and Responses, plus native Anthropic Messages.
- Streaming passthrough; no request/response format translation or agent tool execution.
- Model catalog logged at startup with policy status and supported endpoints.
- Per-model usage from server-reported values, available as JSON and a summary table.
- Node.js 24 action with no package dependencies or build step; automatic job cleanup.

This is an independent project, not an official GitHub action. Copilot's direct
upstream endpoints are implementation APIs and may change.

## Quick start

Requires an account and repository eligible to use the Actions token for Copilot,
and a workflow granting `copilot-requests: write`. The proxy does not change
eligibility, organization policy, model access, or Copilot billing.

```yaml
name: Copilot example
on: workflow_dispatch

permissions:
  copilot-requests: write

jobs:
  example:
    runs-on: ubuntu-latest
    steps:
      - name: Start Copilot proxy
        id: copilot
        uses: shyim/copilot-proxy-action@v1

      - name: List models
        env:
          OPENAI_BASE_URL: ${{ steps.copilot.outputs.base-url }}
        run: curl --fail-with-body "$OPENAI_BASE_URL/models"

      - name: Ask a model
        env:
          OPENAI_BASE_URL: ${{ steps.copilot.outputs.base-url }}
        run: |
          curl --fail-with-body "$OPENAI_BASE_URL/chat/completions" \
            -H 'Content-Type: application/json' \
            --data '{"model":"claude-haiku-4.5","messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":16}'

      - name: Save usage report
        if: always() && steps.copilot.outputs.usage-file != ''
        uses: actions/upload-artifact@v7
        with:
          name: copilot-usage
          path: ${{ steps.copilot.outputs.usage-file }}
```

The example tracks the `v1` major release tag. Pin a reviewed commit SHA for an
immutable reference. Consumers do not need to check out this action's source.
Add `contents: read` and a checkout step only if your own job needs repository
files.

Inference consumes Copilot usage. Choose a model enabled by your policies and
use an endpoint listed in its catalog entry. Being present in `/models` does
not guarantee that a model is enabled.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | `${{ github.token }}` | Token used for upstream Copilot requests. |
| `port` | `0` | Bind to an automatically selected available port; set a number to choose a fixed port. |
| `log-models` | `true` | Print a collapsible catalog table during startup. Set to `false` to skip discovery. |

Catalog discovery failures produce a warning and leave the proxy running.
The supplied token is masked in Actions logs. No Copilot-specific headers or
real API key are required from the local client; clients that require an API
key can use `unused`.

## Outputs

| Output | Description |
| --- | --- |
| `base-url` | OpenAI-compatible URL, such as `http://127.0.0.1:12345/v1`. |
| `usage-url` | GET this local URL for the current JSON usage report. |
| `usage-file` | Absolute JSON report path, updated after each request. Upload it before job cleanup. |
| `pid` | Background proxy PID, for diagnostics. The action stops it automatically. |

The post step appends the summary automatically. Artifact steps run before post
steps, so an uploaded report includes only requests observed by upload time.
Wait for clients to finish before uploading.

## API routes

| Client route | Upstream route | Purpose |
| --- | --- | --- |
| `GET /v1/models` | `GET /models` | Model catalog. |
| `POST /v1/chat/completions` | `POST /chat/completions` | Chat Completions. |
| `POST /v1/responses` | `POST /responses` | Responses. |
| `POST /v1/embeddings` | `POST /embeddings` | Embeddings, if supported by the selected model/token. |
| `POST /v1/messages` | `POST /v1/messages` | Native Anthropic Messages. |
| `GET /v1/usage` or `/usage` | Local only | Usage report. |
| `GET /health` | Local only | Process health, without an upstream request. |

OpenAI routes also accept their unprefixed forms. For Anthropic-compatible
clients, use the origin without `/v1` as their base URL, because those clients
normally append `/v1/messages` themselves. HTTP methods and upstream error
status/body are preserved. WebSocket Responses, token-count endpoints, and
arbitrary upstream URLs are not supported.

For streaming Chat Completions, request usage explicitly:

```json
{
  "model": "claude-haiku-4.5",
  "messages": [{ "role": "user", "content": "Reply with OK." }],
  "max_tokens": 16,
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

The proxy forwards request and response bytes without adding stream options.
It injects `Authorization` and `Copilot-Integration-Id: copilot-developer-cli`
on the fixed upstream connection to `https://api.githubcopilot.com`. Incoming
credentials and integration IDs are replaced. It forwards `Content-Type`,
`Accept`, `Anthropic-Version`, and `Anthropic-Beta`; other client headers are
not forwarded. Model-specific feature support still applies.

## Usage and costs

The summary contains one row per resolved model, falling back to the requested
model when no resolved ID is returned.

| Model | Requests | Input tokens | Output tokens | AI credits | USD equivalent |
| --- | ---: | ---: | ---: | ---: | ---: |
| claude-haiku-4.5 | 1 | 11 | 5 | 0.0036 | 0.000036 |

The example above comes from a test run; it is not a price quote. The complete
summary and JSON report also include failures, in-flight requests, cache usage,
and token/cost coverage. JSON includes reasoning tokens and per-request status,
endpoint, and timestamps. Catalog and health requests are excluded.

Cost is read from `copilot_usage.total_nano_aiu`, including streaming events.
Repeated cumulative values are counted once per request. Divide nano-AIU by
1e9 for AI credits; the USD equivalent uses $0.01 per credit. No model pricing
table is hard-coded. [GitHub's billing reference](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
explains credit value and plan allowances.

Missing token/cost values remain `null` in JSON and **unknown** in the summary.
Coverage counts expose partial totals; interrupted calls may lack final usage.
The USD equivalent is usage value, not an invoice or additional amount due.
Cached input is included in input totals; reasoning tokens are included in
output totals. Anthropic's separately reported cache input is normalized into
the input total. Numeric counts use JavaScript numbers.

Request and response content is observed only in memory. The report does not
save prompts, completions, headers, or credentials. Observations are bounded at
32 MiB of decoded text per JSON document/SSE event; larger payloads continue to
stream but their observation is flagged as limited. Requests still running
when cleanup ends may remain marked in flight. Reports grow with the number
of inference requests in the job.

## Runner support and trust

CI tests Linux, macOS, and Windows. Self-hosted runners must support the Node.js
24 action runtime. Host processes in the same job can use the proxy; Docker
container steps and container jobs have different networking, so their own
localhost does not reach this host-bound service. Use a host-based job.

The local endpoint has no per-client authentication. Every process in the
runner's network namespace can use it. Use isolated runners and trusted jobs;
see [the security policy](SECURITY.md) for the full trust boundary. Browser
Origin headers, non-loopback Host values, and non-JSON inference requests are
rejected. This does not grant third-party GitHub App tokens Copilot access.

The action honors `NODE_EXTRA_CA_CERTS` for upstream TLS certificates. It does
not implement `HTTP_PROXY` / `HTTPS_PROXY` forwarding.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Copilot returns 401 or 403 | Workflow permission, account eligibility, token type, and organization policy. |
| Integration header mismatch | Use the workflow token input; arbitrary GitHub App tokens may not match this integration. |
| Model is listed but inference fails | Its policy state and supported endpoints; the catalog includes disabled entries. |
| Token/cost columns show unknown | The upstream must supply usage; enable `stream_options.include_usage` for chat streams. |
| Client cannot connect | Use the `base-url` output in a subsequent host step, before job cleanup. |
| Fixed port is unavailable | Omit `port` to let the OS choose an available one. |

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

CI uses local mocks and needs no Copilot credentials. The manual **Live Copilot
integration** workflow tests catalog discovery and two small inference calls.
See [CONTRIBUTING.md](CONTRIBUTING.md), including the [release instructions](CONTRIBUTING.md#releasing).

Licensed under [MIT](LICENSE).
