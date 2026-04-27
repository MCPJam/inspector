# CLI Surface Notes

Use this file when a finding may be influenced by how `mcpjam` or the SDK shapes results.

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

### `--credentials-out` / `--credentials-file`

- `--credentials-out` is supported on `oauth login`. Writes OAuth credentials to a JSON file with `0600` permissions. Depending on the flow, the file may include access token, refresh token, client ID, and client secret. Stdout output has secret fields redacted to `[SAVED_TO_FILE]`.
- `--credentials-file` is supported on `server` commands (including `server probe`), `tools` commands, `resources` commands, `prompts` commands, `protocol conformance`, and `apps` commands. Reads credentials from a file created by `--credentials-out`.
- The CLI validates that the credential file's server URL matches the target URL, checks token expiry (with a 60-second skew buffer), and rejects conflicts with individual token flags.
- Connected commands such as `tools list`, `resources list`, `prompts list`, `server doctor`, and `apps` commands can use refresh-token credentials from the file when the saved access token is expired. `protocol conformance` and `server probe` require a non-expired access token from the file.
- Credentials files are not debug artifacts — they contain live secrets. Do not confuse with `--debug-out` artifacts that redact secrets.

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
- `oauth conformance --conformance-checks` adds targeted negative probes for:
  - DCR acceptance of non-loopback `http://` redirect URIs
  - invalid client rejection at the token endpoint
  - authorization-endpoint handling of mismatched `redirect_uri`
  - invalid bearer-token rejection by the MCP server
  - token-endpoint handling of mismatched `redirect_uri`
- A passing negative test only proves the specific negative case that was sent.
- Current auth-code negative checks include the OAuth `resource` parameter, so failures are less likely to be caused by obviously malformed token requests.
- A redirect-mismatch check marked `skipped` often means the request was rejected for some other reason before redirect validation was isolated. Do not overread that as a pass.
- A failing headless flow may reflect login UX or consent requirements, not a spec violation.

### `apps conformance`

- This is a connected, server-side MCP Apps check.
- It validates:
  - tools advertising `_meta.ui.resourceUri` or deprecated `_meta["ui/resourceUri"]`
  - tool `inputSchema` is a non-null JSON Schema object (MUST)
  - tool name length, character set, and uniqueness (SHOULD — warnings only)
  - `ui://` resource discovery and `resources/read`
  - `text/html;profile=mcp-app` payload shape
  - `_meta.ui.csp`, `permissions`, `domain`, and `prefersBorder`
- It does not currently validate:
  - `ui/initialize` and `ui/notifications/initialized`
  - `ui/notifications/tool-input` or `ui/notifications/tool-result` ordering
  - sandbox proxy behavior
  - host display modes, host context changes, or postMessage bridge behavior
- Treat a pass as evidence that the server advertises an MCP Apps surface with plausible resource wiring. Do not describe it as full SEP-1865 conformance.

### `tools list`

- The command returns:
  - `tools`: direct server data
  - `toolsMetadata`: local cache data from `manager.getAllToolsMetadata(serverId)`
  - `tokenCount`: optional local estimate when `--model-id` is supplied
- Only `tools` should be treated as server output by default.
- `toolsMetadata: {}` means the local cache is empty. It does not mean the server violated MCP.
- Tools with `_meta.ui.resourceUri`, deprecated `_meta["ui/resourceUri"]`, or `openai/outputTemplate` in `toolsMetadata` have interactive UI. Use `tools call --ui` to render those tool results in Inspector.

### `tools call`

- Good for checking argument validation, result shape, and execution failures.
- Without `--ui`, the command returns the raw tool result.
- With `--ui`, the command executes the tool once, starts or attaches to the local Inspector, connects the server, opens App Builder, injects the already-completed tool result through `renderToolResult`, and then requests a snapshot.
- `inspectorRender` is UI command-bus evidence, not a second server-side tool call. A render failure can coexist with a successful `result`.
- `success: false` with an `error` from `inspectorRender` means the Inspector render path failed. Check the individual `openAppBuilder`, `setAppContext`, `renderToolResult`, and `snapshot` responses before blaming the MCP server.
- Large tool results can appear in multiple places, such as `result`, `inspectorRender.renderToolResult.result`, and `inspectorRender.snapshot.result.toolOutput`. Summarize large duplicated payloads.
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
