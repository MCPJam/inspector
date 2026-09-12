# Adding agent tools for a surface

Three things share the word "WebMCP" in this repo; the tools you are about to
add are the first:

1. **MCPJam's own `ui_*` tools** — this document. Actions that drive the
   inspector, resolved in the page. Two agents reach them: Ask MCPJam over
   MCPJam's transport, and a browser-native agent over `document.modelContext`
   (see [`docs/webmcp-native-tools.md`](../../../../docs/webmcp-native-tools.md)).
2. **Native publishing** — the mirror of (1) onto the browser's WebMCP API.
   You decide per tool whether yours is published; see "Native publication"
   below. It is a field on the definition, not a separate registration.
3. **The WebMCP Inspector** — the opposite direction entirely: a managed
   browser pointed at somebody else's page, listing the `page_*` tools THAT
   page registers. Nothing you add here goes near it.

Every screen manifest in `shared/app-surfaces.ts` carries a REQUIRED
`agentTools` decision, so a new surface cannot ship without one — the client
typecheck fails on a missing field, and `agent-tool-coverage.test.ts` fails
on a half-wired one. The always-on catalog (`ui-tools-catalog.ts`) is frozen
to the servers + playground tools; every new surface gets a **mount-scoped
tool group** instead: one module in `groups/`, one `useSurfaceAgentBridge`
call in the surface component.

## The recipe

1. **Commands.** If your tools need new inspector commands, extend the
   command union in `shared/inspector-command.ts` (type, payload, and the
   `KNOWN_INSPECTOR_COMMAND_TYPES` list).
2. **Group module.** Add `groups/<surface>.ts` exporting
   `build<Surface>UiTools(): UiToolDefinition[]`, and register it in
   `SURFACE_TOOL_GROUPS` in `groups/index.ts`. Shared helpers (`errorResult`,
   `fromActionResult`, `asOptionalString`, …) live in `groups/shared.ts`.
3. **Bridge call.** In the SURFACE COMPONENT — never a shared hook — call:

   ```ts
   useSurfaceAgentBridge({
     surfaceId: "<literal id>",
     handlers: { myCommand: handleMyCommand },
     snapshot: () => ({ /* redacted view of this screen's state */ }),
   });
   ```

   The shared-hook hazard is real: EvalsTab and CiEvalsTab share their state
   hooks, so a bridge call inside one of those would register the evals
   group under the wrong surface on Runs mode. The coverage test enforces a
   literal `surfaceId: "<id>"` in the module you list.
4. **Manifest.** Flip the surface's `agentTools` from `{ kind: "none", … }`
   to `{ kind: "group" }` and set `hasSnapshotProvider: true` (a group ships
   with observability; the coverage test requires it).
5. **Coverage row.** Add the component's repo-relative path to
   `BRIDGE_MODULES` in `client/src/lib/__tests__/agent-bridge-modules.ts`.
6. **Tests.** Unit-test the group like `ui-tools-catalog.test.ts` does
   (mock the command bus, assert dispatch shapes), then run
   `npx vitest run client/src/lib/webmcp client/src/lib/__tests__`.

The App `navigate` handler waits up to 1.5 s for a just-mounted group's
tools (`waitForUiToolNames`), so the same turn that navigated to your screen
can already advertise them.

## Rules (enforced by tests where possible, by review otherwise)

### Annotations

Every tool carries a COMPLETE `annotations` object —
`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`, all
booleans, with `readOnlyHint === readOnly` (the coverage test checks all of
this). Destructive = deletes something, **spends money/quota, or consumes
billed/capped infrastructure**, or is otherwise irreversible →
`destructiveHint: true`, which shows the confirmation pill even in the default
approval mode. This includes actions that *create* but still spend: e.g.
`ui_run_eval_suite` (eval quota), `ui_start_computer` (billed, daily-capped),
`ui_launch_swarm_run` (swarm quota), `ui_generate_*` — all `destructiveHint:
true`, NOT merely `openWorldHint`. A server-side gate (quota/cap) does not
replace the pill; both apply. Read-only tools never gate — so they must
genuinely be side-effect-free (`ui_snapshot_app` errors rather than
auto-opening a surface).

### Native publication

Every definition states whether a browser-native WebMCP agent gets it, using
the helpers in `groups/shared.ts`:

```ts
nativePublication: PUBLISH_NATIVE,            // an ordinary inspector action
nativePublication: PUBLISH_NATIVE_UNTRUSTED,  // …whose RESULT quotes a third party
nativePublication: nativeInternal("why not"), // Ask MCPJam only
```

Default is internal, so a tool that says nothing is simply invisible to
external agents — which is why the coverage test insists you say. Publish
unless the tool cannot mean anything without an MCPJam conversation: the two
exceptions today are `ui_ask_user` (paints a card into a transcript and parks
that turn) and the eval-authoring group (reads a scope pinned to one
conversation). "It is destructive" is NOT a reason to withhold a tool — the
hints below are how that gets handled.

Pick `PUBLISH_NATIVE_UNTRUSTED` when the result can carry bytes MCPJam did not
author: an MCP server's tool output, a registry listing, an OAuth server's
metadata, a snapshot of a screen showing any of those. It becomes WebMCP's
`untrustedContentHint`, telling the agent to treat the payload as data rather
than instructions. Over-claiming costs nothing; under-claiming is the mistake
that matters.

`consequentialHint` is normally derived from the annotations above
(destructive, or mutating-and-open-world), so the two cannot drift: get the
annotations right and the native hint follows. The exception is real, though,
because the two hints ask different questions — MCP's `destructiveHint` is
about irreversibility, Chrome's `consequentialHint` is about whether a browser
agent should confirm first. A tool that only CREATES can still commit the
organization to something. Say so outright there, with the reason at the call
site:

```ts
// `access: "link_guests"` opens this to signed-out visitors, funded by the org.
nativePublication: publishNativeConsequential({ untrustedContent: false }),
```

That widens only what the browser is told; the MCP annotations and Ask
MCPJam's approval behaviour stay as they are. It is not a way around getting
`destructiveHint` right — if an action really is irreversible, annotate it
destructive.

### Billing gates

Handlers must call the SAME gated callbacks the buttons use — eval quota,
swarm 402 handling, the computer daily cap, the `assertMayCreateServer`
precedent on the Connect screen. An agent tool that bypasses a billing gate
is a billing bug, not a convenience. This is load bearing for published tools:
an external agent's approval flow belongs to its browser, so the handler's own
gates and confirmations are the only ones MCPJam still controls.

### Transcript safety

Tool inputs, tool outputs, and snapshots all land in the chat transcript (and
cross to the server) — and, for a published tool, cross to an agent MCPJam
does not control. No secrets or credentials in input schemas — the
server-draft tools take no env/headers for exactly this reason (the
no-env/no-headers precedent). Snapshot providers report STATE, not payloads,
and redact tokens, keys, and PII.

### Prefill over commit

For high-entropy input (long configs, credentials-adjacent forms), prefer a
tool that PREFILLS a form for the user to review and submit —
`ui_open_server_form` precedent. Direct commit is for low-entropy actions
whose full input the model can plausibly get right and the user can see
happen.

### Ask instead of guessing (but rarely)

`ui_ask_user` (core group) parks the turn on an inline multiple-choice card
and resumes it with the user's answer. A tool handler that discovers
ambiguity should NOT call it — return an error naming what is missing and let
the model decide whether asking is worth an interruption.

Two rules keep it from becoming noise. It is READ-ONLY, so it never gates —
do not "improve" it with an approval pill. And it is never a substitute for
one: asking "shall I delete this?" on a question card is not an approval,
because the destructive tool that follows is a separate call carrying its own
annotations.

The free-text escape hatch is supplied by the renderer and is not optional. A
prompt or tool that has the model author its own "Other" option is a bug.

### Names

`UI_TOOL_NAME_REGEX`: `ui_[a-z0-9][a-z0-9_]*`, max 64 chars. Distinguish
execution from initiation with the verb (Chrome WebMCP guidance):
`ui_execute_tool` really runs; `ui_select_tool` prefills. A name that reads
like it acts must act; a name that reads like it prepares must only prepare.

### Budget

Global catalog + your group must stay ≤ 56 tools (8 headroom under the
server's 64-entry snapshot cap, single-surface-mount assumption). The
coverage test enforces it — trim tools rather than raising the number.
