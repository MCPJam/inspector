# WS0 preflight results — codex app-server

**Rig:** the pinned `@openai/codex@0.149.1` linux-x64 binary plus the scripted
fake Responses API in `probe/`. No E2B, no model spend, no network egress.
**Run:** `node probe/run-gates.mjs --codex <path-to-codex>` (Linux, 2026-09-01).
Raw frames for every claim below are in `artifacts/<gate>.ndjson` (app-server
JSON-RPC) and `artifacts/<gate>.http.ndjson` (what codex sent the model).

Platform note: approval semantics depend on the sandbox implementation
(bubblewrap on Linux, seatbelt on macOS). These gates ran on Linux, which is
what E2B runs. Do not certify Strict-mode semantics from a macOS run.

## Summary

| Gate | Question | Result |
| --- | --- | --- |
| P1 | Are `mcp_servers` tools model-callable? | **Partial** — declared to the model, call form not reproducible locally |
| P2 | Does `untrusted` + `user` raise real approvals? | **Pass** |
| P2b | Does a denial actually prevent execution? | **Pass** |
| P3 | Does `turn/interrupt` end a running turn? | **Pass** |
| P4 | Does `thread/start.config` take nested tables? Endpoint inventory? | **Pass** |
| P4b | Does a non-git cwd work? | **Pass** |

## The tool surface is `exec_command`, not `shell`

The single most load-bearing finding, and the reason this rig exists. Codex
0.149.1 declares these tools to the model (captured from the wire, gpt-5-nano):

```
exec_command (function)   write_stdin (function)     update_plan (function)
request_user_input        view_image                 web_search (type: web_search)
multi_agent_v1 (namespace)  get_goal / create_goal / update_goal
```

`exec_command` takes `{cmd: string, justification?, login?, max_output_tokens?,
prefix_rule?}` — a shell string, not `shell` with an argv array. There is **no
`apply_patch` function tool**; file mutation runs through `exec_command`, and the
protocol reports it as a `fileChange` item. Any builtin catalog written from the
`codex exec` transport's names would be wrong.

With an MCP server configured, three more appear (`list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`) plus one namespace tool per
server.

## P2 — approvals are real, and they arrive BEFORE the item

Thread started with `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`,
`sandbox: "workspace-write"`. Observed order:

```
request: item/commandExecution/requestApproval   <-- first
started:  userMessage
completed: userMessage
started:  commandExecution                        <-- only after the decision
completed: commandExecution   (status: completed, exitCode 0)
started/completed: agentMessage
```

**This settles the top-ranked risk in the plan.** The approval request precedes
`item/started`, so the bridge cannot wait for the item to synthesize the
`tool-call` that a `tool-approval-request` must follow. It has to seed the call
from the approval params, which carry everything needed:

```json
{
  "threadId": "...", "turnId": "...", "itemId": "call_fake_1_0",
  "startedAtMs": 1788291954985, "environmentId": "local",
  "command": "/bin/bash -lc 'echo hi > probe.txt'",
  "cwd": "/tmp/codex-cwd-yTiWuj",
  "commandActions": [{ "type": "unknown", "command": "echo hi > probe.txt" }],
  "proposedExecpolicyAmendment": ["/bin/bash", "-lc", "echo hi > probe.txt"],
  "availableDecisions": ["accept", { "acceptWithExecpolicyAmendment": {...} }, "cancel"]
}
```

Three things the generated schema does not tell you:

- **`itemId` is the model's `call_id`.** The approval, the `item/started` and the
  `item/completed` all carry it, so `toolCallId = itemId` is stable across the
  pause and idempotent de-duplication works on it.
- **`availableDecisions` is present on the wire** even though it is absent from
  the 0.149.1 and 0.152.0 JSON schemas. Treat it as advisory, not as a contract.
- **`decline` works even when `availableDecisions` omits it** (P2b). The offered
  list here was accept / amendment / cancel, and `{"decision":"decline"}` was
  still honoured, producing `status: "declined"`.

`thread/status/changed` reported `active(waitingOnApproval)` for the pause, so
the flag is usable as a liveness signal.

## P2b — the single-authority invariant holds

Same setup, answering `{"decision":"decline"}`: `commandExecution` ends
`declined`, and the file the command would have written **does not exist**. Deny
means zero execution, not a warning.

## P3 — interrupt works

`turn/interrupt` during a running `exec_command` ends the turn with
`status: "interrupted"`; the command item is left `inProgress`. A bridge must
therefore close out open tool calls itself on interrupt rather than expecting a
terminal item.

## P4 — config passthrough, endpoints, sandbox

- **`thread/start.config` accepts nested tables.** An `mcp_servers.viaconfig`
  entry passed through `config` started and reached `ready`. Per-thread config is
  a real channel, not just a scalar override.
- **Endpoint inventory: only `POST /v1/responses`.** No `/v1/models` call at
  startup or during a turn, so the backend proxy's existing OpenAI allowlist
  (`POST /v1/responses`, `GET /v1/models`) is sufficient with room to spare.
- **A custom `model_providers` entry works end to end**: `base_url` + `env_key` +
  `wire_api = "responses"` routed the whole turn to the fake server, and
  `thread/start` echoed `modelProvider: "probe"`. This is the broker path
  validated at protocol level.
- **The bundled bubblewrap is used** when none is on PATH, reported as a
  `configWarning` rather than a failure: *"Codex will use the bundled bubblewrap
  in the meantime."* Sandboxed execution worked in this container.
- **Token usage** arrives as `thread/tokenUsage/updated` with `last` and `total`,
  each carrying `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`,
  `outputTokens`, `reasoningOutputTokens`, `totalTokens`, plus
  `modelContextWindow`. Every field the harness usage shape needs is present.

## P4b — non-git cwd, and a loud unknown-model warning

`thread/start` on a plain temp directory works; the `--skip-git-repo-check` dance
`codex exec` needs has no app-server equivalent. An unrecognised model produces a
`warning` notification — *"Model metadata for `gpt-5-nano` not found. Defaulting
to fallback metadata; this can degrade performance and cause issues."* — which is
the loud failure the exec transport lacks, and a good reason to forward
`warning` notifications into the stream.

## P1 — partial, and honestly so

With `[mcp_servers.probe]` configured, the server reaches `ready` and its tools
are **fully declared to the model**, as one `namespace`-typed tool per server
carrying each tool's real input schema:

```json
{ "type": "namespace", "name": "mcp__probe", "description": "Tools in the mcp__probe namespace.",
  "tools": [{ "type": "function", "name": "probe_echo", "parameters": { ... } }] }
```

So this is *not* the failure openai/codex#19425 describes — the tools are on the
wire, with schemas, not merely handshaken.

What could not be established locally is the **call form**. Every candidate the
fake provider emitted came back as `unsupported call: <name>`:
`mcp__probe.probe_echo`, `mcp__probe__probe_echo`, `probe_echo`, `mcp__probe`,
`probe.probe_echo`, `probe__probe_echo`, `mcp__probe_probe_echo`,
`probe-probe_echo`, and `custom_tool_call` items (silently dropped). The
`non_prefixed_mcp_tool_names` feature flag renames the namespace (`mcp__probe` →
`probe`) but keeps it namespace-typed.

The conclusion is about the rig, not about codex: **namespace tools are flattened
and dispatched by the OpenAI Responses API server-side**, so a fake provider
cannot mint a call that codex's tool registry resolves (the rejection comes from
`core/src/tools/registry.rs`). Confirming model-callability needs a real model.

**Consequences, already reflected in the plan:**

1. The host-tool relay ships as an MCP server in `mcp_servers` (decision D1). Its
   model-callability rests on the same mechanism every Codex MCP user relies on
   in production, but it is **not** end-to-end testable through a fake provider.
   The relay is therefore tested at the bridge↔relay↔MCP-server boundary, which
   is deterministic, and model-callability is a live gate with a real model.
2. Native MCP delivery is not blocked by callability. Its blocker is approvals:
   no server request exists for an MCP `tools/call`, and none fired during this
   gate. That is why Strict-mode hosts keep host-executed delivery.

## Open for the credentialed E2B pass

- Model-callability of a namespaced MCP tool with a real model (P1's remainder).
- `workspace-write` behaviour on the E2B kernel (Landlock/seccomp availability);
  this container fell back to bundled bubblewrap and worked.
- Fresh-bootstrap memory headroom on a 2 GB box (the codex binary unpacks to
  ~323 MB).
- `sandboxSession.getPortEndpoint` plumbing for the bridge socket.
