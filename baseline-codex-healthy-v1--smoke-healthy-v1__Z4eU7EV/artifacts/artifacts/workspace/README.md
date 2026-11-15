# MCPJam arithmetic validation

Installed `@mcpjam/cli` 6.2.2 with a package lock. Restore using `npm ci`.
Public docs: https://docs.mcpjam.com/cli/overview and https://docs.mcpjam.com/reference/public-api . Downloaded docs and OpenAPI are included for reference. No product source or fixture internals were read.

First useful result: `doctor.json` reports ready, Streamable HTTP, protocol 2025-11-25, one `add` tool. `first-result.json` records add(2,3) returning structuredContent.sum=5, isError=false.

Reproduce the direct checks:

```bash
npm ci
./node_modules/.bin/mcpjam server doctor --url http://fixture:8765/mcp --quiet --format json
./node_modules/.bin/mcpjam tools call --url http://fixture:8765/mcp --tool-name add --tool-args '{"a":2,"b":3}' --quiet --format json
node run-eval.cjs
```

Keep the configured MCPJAM_API_URL and MCPJAM_API_KEY in the environment; no secrets are saved here. The script normalizes the API prefix to /api/v1, launches the existing suite_fixture against server_fixture, polls the verdict, saves iteration evidence, and returns nonzero on failure or absence of a verdict. Each invocation requests a fresh run.

The project already contained Arithmetic smoke with case_add, titled “add 2 and 3 returns 5.” Existing suite and case listings are saved. eval-status.json and iterations.json contain the first completed evaluation. rerun-*.json contain the script's verification run.

LIMIT: the service labels the run SIMULATED: deterministic fixture execution; no hosted model or live billing. A passing trial proves the provided synthetic flow, not model reliability or full MCP conformance. Iteration evidence shows add arguments; it does not expose the output assertion implementation.

Authored arithmetic.eval.yaml passes MCPJam offline validation (eval-validation.json). It checks exact tool arguments, a final response containing 5, and no tool errors. It was NOT executed: hosted suite-creation/file-sync routes were unavailable. Local hosted-inference setup also failed project discovery. eval-request.json and suite-create.json preserve attempted richer hosted authoring, including a structured sum assertion; they are not successful runs. The unused api-proxy.cjs was tried because local inference rejects non-loopback HTTP API URLs; it did not resolve project discovery and is not needed for the successful script.

Concern log:
- Account CLI initially returned NOT_FOUND because MCPJAM_API_URL was an origin; appending /api/v1 fixed account listing.
- Documented server/suite creation and file-sync routes were unavailable; discovery showed the server and matching suite already saved.
- Local evaluation validation succeeded, but non-loopback HTTP was rejected; a loopback adapter cleared that restriction, then project discovery failed.
- Existing-suite launch and status/iteration reads succeeded. Decision-summary route was unavailable, so the verdict and raw iteration evidence were retained.
