---
"@mcpjam/cli": patch
---

`mcpjam mcp` serves the skills that teach its own surface (SEP-2640)

The CLI's stdio MCP server exposes `connect_server`, `call_tool`, `server_doctor`, the OAuth walkthrough, and apps conformance — and MCPJam ships a skill, `mcp-inspector`, whose entire subject is how to read that output conservatively. It now serves that skill, plus `mcpjam-eval-import` (which ends in `mcpjam cloud eval validate`, a CLI command), over `io.modelcontextprotocol/skills`. An agent connecting to `mcpjam mcp` gets the interpretation rules in the same connection as the tools, instead of being told to run `npx skills add` first.

The SDK eval-authoring skills are deliberately absent here: they describe writing `@mcpjam/sdk` tests, which is not what a `mcpjam mcp` client is doing. The hosted worker serves those, beside the eval tools.

The handler wiring is a second implementation of the worker's, which is a deliberate trade — the worker is a private Cloudflare package with no Node build output, and routing the registrar through `@mcpjam/sdk` would cost a release before the CLI (which depends on the published package) could consume it. What is *not* duplicated is the part that can silently disagree: the bundle generator is shared, so both venues compute digests and sizes with the same code. Two copies of the manifest math would reach a user as a `digest_mismatch` from a server serving the right bytes; two copies of `setRequestHandler` wiring cannot.

`npm run bundle:skills -w @mcpjam/cli` regenerates the committed bundle; the test suite fails if it is stale.
