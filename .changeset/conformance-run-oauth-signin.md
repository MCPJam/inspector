---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

`conformance run --suite oauth` signs in the way `oauth conformance` does: through the browser by default (`--oauth-strategy interactive`, `headless` or `client_credentials`), with any client registration (`--registration auto`, `dcr`, `cimd` or `preregistered`). So one command runs and uploads all four suites for a server that uses a browser sign-in. `auto` picks pre-registered credentials when given, else what the server supports at the run's protocol version. The run also takes `--client-metadata-url`, `--redirect-url`, `--scopes`, `--step-timeout` and `--print-url`. In the SDK, `runConformance` accepts `registrationStrategy: "auto"` for its OAuth suite.
