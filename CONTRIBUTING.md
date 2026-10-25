# Contributing

Bug reports and focused pull requests are welcome. For security vulnerabilities,
follow [SECURITY.md](SECURITY.md).

## Development

Use Node.js 24 or later. The action has no runtime or development dependencies
and no bundle/build step; the committed CommonJS files run directly in Actions.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

CI runs these checks and an action lifecycle smoke test on Linux, macOS, and
Windows. Tests use a local mock upstream and do not need GitHub credentials.
Install [jactionlint](https://github.com/jdx/jactionlint) and run
`jactionlint --strict-exit` to validate workflows, actions, and Dependabot
configuration. CI uses the default profile and fails on warnings as well as
errors. No permission-rule exceptions are needed.

For changes to forwarding, streaming, billing, or process lifecycle, include a
regression test. Keep response bytes intact, bound observation memory, and do
not persist prompts, completions, headers, or tokens. Missing usage must remain
unknown rather than becoming a zero cost.

The **Live Copilot integration** workflow is manual. It uses
`copilot-requests: write` and makes two small paid inference requests. Only run
it on trusted code with an eligible account. It must never run automatically
for pull requests from forks.

## Project layout

- `action.yml`: public action inputs, outputs, and lifecycle entry points.
- `src/start.cjs` / `src/stop.cjs`: start/stop the background service and summarize usage.
- `src/proxy.cjs`: loopback HTTP routes and fixed Copilot upstream.
- `src/usage.cjs`: transparent JSON/SSE observation and accounting.
- `test/`: credential-free integration and accounting tests.

By contributing, you agree that your contribution is distributed under the
project's MIT license.

## Releasing

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` together.
   The release draft uses `CHANGELOG.md` for its notes. There is no generated bundle.
2. Merge changes to `main` and wait for CI on all three operating systems.
3. Run **Live Copilot integration** manually on trusted `main`; review model
   discovery, JSON and streaming inference, usage artifact, and cleanup summary.
4. From the reviewed commit, create a draft with the GitHub CLI:

   ```sh
   version="$(node -p 'require("./package.json").version')"
   gh release create "v${version}" --draft --target "$(git rev-parse HEAD)" \
     --title "v${version}" --notes-file CHANGELOG.md
   ```

   If a draft already exists, edit it instead of creating another one.
5. Review the draft and exact target commit. Before the first public release,
   make the repository public, enable private vulnerability reporting, and
   verify the README installation path. Publishing the draft creates its
   version tag. Optionally select the GitHub Marketplace publishing option.
6. Publishing triggers the **Release** workflow. It uses
   `actions/publish-action` to point the major tag (for example `v0`) at the
   released version. You can also dispatch it manually with `TAG_NAME` to
   select an existing release tag. Configure required reviewers on the
   `Release` environment if tag updates should require approval. Never move
   immutable version tags such as `v0.1.0`. Recommend commit SHA pins for
   consumers requiring immutable references.

The README examples use `@v1`; publish a `v1.x.x` release to establish that major
tag before announcing the action.

Protect `main` with pull-request review and required CI checks when repository
settings support it. Maintainers should use least-privilege workflow tokens and
avoid granting Copilot access to contribution CI.
