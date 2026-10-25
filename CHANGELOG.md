# Changelog

## 0.1.0 — Unreleased

- Start a local, dependency-free Copilot proxy from a Node.js GitHub Action.
- Forward Chat Completions, Responses, embeddings, and Anthropic Messages.
- Inject the workflow token and required Copilot integration header upstream.
- Log the model catalog at startup, with policy status and supported endpoints.
- Track per-model requests, tokens, failures, and server-reported AI credit usage.
- Export a live JSON report and an automatic GitHub Actions summary table.
- Shut down during action cleanup; test lifecycle and forwarding on three OSes.
