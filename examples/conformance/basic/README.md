# Basic Conformance Example

This example shows the CI-friendly conformance workflow directly in `@mcpjam/sdk`:

- run protocol conformance from Vitest with `MCPConformanceSuite`
- run MCP Apps conformance from Vitest with `MCPAppsConformanceSuite`
- emit shared JSON and JUnit XML reporters with `toConformanceReport(...)`

## What this example includes

- `mock-http-server.mjs` — a small local MCP HTTP server with tools, prompts, resources, and one `ui://` dashboard
- `basic-conformance.test.ts` — starts the server, runs protocol and apps suites, and writes reports under `reports/`
- `protocol-suite.json` / `apps-suite.json` — matching CLI suite configs for manual shell runs

OAuth is intentionally not included here because it requires a real authorization server. The SDK and CLI surface are the same pattern once you have an OAuth-capable target.

## Install

```bash
cd examples/conformance/basic
npm install
```

## Run the SDK example

```bash
npm test
```

This writes:

- `reports/protocol-conformance.junit.xml`
- `reports/protocol-conformance.report.json`
- `reports/apps-conformance.junit.xml`
- `reports/apps-conformance.report.json`

## Run the matching CLI suites

In one terminal, start the example server on the port used by the config files:

```bash
PORT=3101 npm run start:server
```

In another terminal:

```bash
npx -y @mcpjam/cli@latest protocol conformance-suite \
  --config ./protocol-suite.json \
  --format junit-xml > protocol-report.xml

npx -y @mcpjam/cli@latest apps conformance-suite \
  --config ./apps-suite.json \
  --format junit-xml > apps-report.xml
```

The XML emitted by the CLI comes from the same shared report helpers the SDK uses.
