# Security policy

Security fixes target the latest release and the `main` branch. Older versions
may not receive backports.

Report vulnerabilities privately through the repository's **Security → Report a
vulnerability** feature. If private reporting is unavailable, contact the
maintainer through the contact details on https://github.com/shyim. Do not put
credentials, prompts, or exploitable details in a public issue.

## Trust boundary

This action runs a proxy bound to `127.0.0.1` and authenticates outgoing requests
using a workflow token. It uses a fixed HTTPS upstream (`api.githubcopilot.com`),
replaces incoming authentication and integration headers, rejects browser
Origin headers and non-loopback Host values, and accepts inference only as JSON.
It does not provide per-process authentication: any process in the same runner
network namespace can use the credential through the local proxy.

Use trusted jobs on isolated runners. Do not run untrusted pull-request code
with a Copilot-enabled token or use `pull_request_target` to check out and run
fork code. Prefer ephemeral self-hosted runners; do not share their network
namespace with untrusted workloads. Cleanup normally stops the process, but a
hard runner crash can prevent post steps; the process is also registered with
the runner's orphan-process tracking when that facility is available.

The report persists only model IDs, endpoints, timing, status, and numeric usage.
Request/response content is observed in memory to read model and usage fields;
it is not logged or written to the usage report. Upstream error responses are
returned to the caller unchanged. The proxy is not a redaction layer for other
workflow steps or tools that choose to log content.
