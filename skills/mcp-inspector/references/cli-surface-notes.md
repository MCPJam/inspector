# CLI Surface Notes

Use this file when a finding may be influenced by how `mcpjam-cli` or the SDK shapes results.

## Evidence priority

1. Raw HTTP or RPC attempts from `server probe`, `oauth debug-proxy`, or `--rpc` logs
2. JSON output from direct commands such as `server capabilities`, `tools list`, or `resources read`
3. Aggregated artifacts such as `server doctor`, `server export`, or `--debug-out`
4. Human-readable summaries

If a higher-priority surface contradicts a lower-priority summary, trust the higher-priority evidence.

## Command notes

### `server probe`

- HTTP only and stateless.
- Attempts Streamable HTTP initialize first, then an SSE probe, then OAuth protected-resource metadata and authorization-server metadata discovery.
- Good for:
  - transport selection
  - `401` discovery hints
  - whether initialize succeeds without a full client session
- Not enough by itself to prove post-auth tools, resources, prompts, or session behavior.

### `server doctor`

- Combines an HTTP probe with a connected sweep through an ephemeral manager.
- A single doctor artifact can mix:
  - unauthenticated probe evidence
  - authenticated or connected behavior
  - CLI-added summaries
- `status: oauth_required` can be decided from the probe before any connected sweep runs.
- `status: partial` usually means some sub-surfaces failed while the connection itself still succeeded.

### `--debug-out`

- Supported on `server probe`, `server validate`, `tools call`, and `oauth login`.
- Writes a redacted envelope with:
  - `command`
  - `target`
  - `outcome`
  - `snapshot`
  - `snapshotError`
  - optional `_rpcLogs`
- The `outcome` is the primary evidence for the original command.
- The `snapshot` is a best-effort `server doctor` follow-up and should be treated as supporting breadth context, not proof of the exact same failure path.
- `server doctor --out` is different: it writes the doctor JSON directly, not the command envelope shape.

### `server info`, `server capabilities`, `server validate`, `server ping`, `server export`

- These are connected checks, not raw transport probes.
- `server export` is a convenience snapshot. Treat it as summarized state, not a wire capture.

### `oauth metadata`, `oauth proxy`, `oauth debug-proxy`

- Prefer these when conformance output suggests something unusual and you need to inspect the exact metadata or response body.
- `oauth debug-proxy` is the best CLI surface for confirming whether a surprising OAuth endpoint behavior is real.

### `oauth login`, `oauth conformance`, `oauth conformance-suite`

- These are targeted flow tests, not a full security audit.
- A passing negative test only proves the specific negative case that was sent.
- A failing headless flow may reflect login UX or consent requirements, not a spec violation.

### `tools list`

- The command returns:
  - `tools`: direct server data
  - `toolsMetadata`: local cache data from `manager.getAllToolsMetadata(serverId)`
  - `tokenCount`: optional local estimate when `--model-id` is supplied
- Only `tools` should be treated as server output by default.
- `toolsMetadata: {}` means the local cache is empty. It does not mean the server violated MCP.

### `tools call`

- Good for checking argument validation, result shape, and execution failures.
- Distinguish:
  - JSON-RPC request errors such as invalid params or unknown method
  - tool execution failures returned in the tool result

### `resources list`, `resources read`, `resources templates`

- `resources list` and `read` are direct connected checks.
- In doctor output, `resources/templates` may be reported as skipped when the server does not support that method. That is not a protocol failure by itself.

### `prompts list`, `prompts get`, `prompts list-multi`

- Empty prompt arrays are easy to overread.
- In this branch, `manager.listPrompts(serverId)` returns `{ prompts: [] }` when:
  - the server does not advertise the `prompts` capability
  - the underlying call hits `prompts/list` method-unavailable handling
- `prompts list-multi` also merges connection errors into `errors` while leaving that server's prompts entry as `[]`.
- Do not claim "the server supports prompts and returns an empty list" unless you have raw evidence that `prompts/list` was actually sent and answered.

## Known local enrichments and normalizations

- `toolsMetadata` is local cache output, not an MCP field.
- `tokenCount` is a local estimate from serialized tool JSON, not server output.
- Several wrappers normalize missing arrays to `[]`.
- Aggregated commands may merge connection errors with partial successes.
- `--debug-out` artifacts redact secrets. Missing credential values in those files are often intentional masking, not proof that the server omitted them.

## Common artifact patterns

Treat these as `scanner/client artifact` unless stronger evidence exists:

- `toolsMetadata` is empty
- prompts are `[]` without raw proof that `prompts/list` ran
- a summary says a feature is "supported" when the client may have synthesized an empty default
- a doctor artifact is read as if every field came from the same phase of the interaction
- a `--debug-out` snapshot is treated as if it exactly reproduces the primary command failure path
