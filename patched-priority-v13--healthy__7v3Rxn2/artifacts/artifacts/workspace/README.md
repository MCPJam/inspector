# MCPJam arithmetic validation

Installed `@mcpjam/cli` 6.2.2 locally with an exact dependency and package lock.
Only public documentation, CLI help, and normal product endpoints were used.

## Reproduce

From `/workspace`, with the trial account's `MCPJAM_API_URL` and `MCPJAM_API_KEY` in the environment:

```bash
npm ci
./run-eval.sh
```

The script validates `arithmetic.eval.json`, syncs the file-owned suite in
`project_fixture`, runs it to completion, and saves `reports/eval.json` and
`reports/launch.json`. Exit 0 means passed; exit 1 means a completed failed
verdict. Other nonzero codes indicate setup/auth/usage/incomplete execution.
Each invocation starts a new evaluation; a lost launch response can be retried
using the printed idempotency key with the CLI's `--idempotency-key` flag.
No credentials are saved in these files.

## Results

- `doctor.json`: ready; Streamable HTTP; MCP 2025-11-25; no OAuth required.
- `tools.json`: one tool, `add`, with numeric `a` and `b` inputs.
- `first-result.json`: direct call with 17 and 25 returned structured sum 42.
- `arithmetic.eval.json`: deterministic toolCall followed by a required
  `toolResultContains` assertion for `42`. The server is the saved project
  server `Arithmetic` (`server_fixture`).
- `reports/iterations.json`: first passing evaluation's actual arguments and
  tool result (`structuredContent.sum = 42`).
- `reports/eval.json`: latest passing run, `run_fixture_3`, one passed trial.
- `reports/negative-control.json`: separate suite expecting `43`,
  `run_fixture_2`, one failed trial; CLI exited 1 as expected.
- `reports/validation.json`: final suite passes file and live reference validation.

The positive suite was run successfully twice (`run_fixture_1` and
`run_fixture_3`). The run receipts explicitly describe execution as SIMULATED:
deterministic trial execution, no hosted model or live billing. This validates
the arithmetic tool and the supported evaluation path; it does not measure
model tool selection or full MCP protocol conformance. The substring assertion
checks for `42`, not exact JSON equality.

## Trial limitations encountered

1. `toolCalledWith.args` requires the documented nested `{ "args": {...} }`
   matcher. The validator initially reported only `Invalid input`.
2. The account refused hosted prompt/model execution without a charge.
3. A direct-call suite with the richer assertion set was also refused with a
   generic supported-subset error. Reducing to `toolResultContains` succeeded.
4. The documented per-iteration steps endpoint returned NOT_FOUND (route not
   implemented). The iteration listing supplied the actual call/output evidence.

No billing purchases or contact with production billing were made.

## Public documentation used

- https://docs.mcpjam.com
- https://docs.mcpjam.com/llms.txt
- https://docs.mcpjam.com/cli/overview
- https://docs.mcpjam.com/cli/reference
- https://docs.mcpjam.com/cli/local-evals
- https://docs.mcpjam.com/inspector/evals
- https://docs.mcpjam.com/reference/public-api
- https://docs.mcpjam.com/reference/openapi.json

The OpenAPI schema documents deterministic `toolCall` steps. The local-evals
page says local runs refuse direct toolCall and gating tool-result assertions;
these require the hosted evaluation route used here.
