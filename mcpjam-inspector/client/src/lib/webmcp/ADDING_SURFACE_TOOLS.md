# Adding agent tools for a surface

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
   group under the wrong surface on /ci-evals. The coverage test enforces a
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
this). Destructive = deletes something, spends money/quota, or is otherwise
irreversible → `destructiveHint: true`, which shows the confirmation pill
even in the default approval mode (`ui_remove_server`, `ui_execute_tool`
precedents). Read-only tools never gate — so they must genuinely be
side-effect-free (`ui_snapshot_app` errors rather than auto-opening a
surface).

### Billing gates

Handlers must call the SAME gated callbacks the buttons use — eval quota,
swarm 402 handling, the computer daily cap, the `assertMayCreateServer`
precedent on the Connect screen. An agent tool that bypasses a billing gate
is a billing bug, not a convenience.

### Transcript safety

Tool inputs, tool outputs, and snapshots all land in the chat transcript
(and cross to the server). No secrets or credentials in input schemas — the
server-draft tools take no env/headers for exactly this reason (the
no-env/no-headers precedent). Snapshot providers report STATE, not payloads,
and redact tokens, keys, and PII.

### Prefill over commit

For high-entropy input (long configs, credentials-adjacent forms), prefer a
tool that PREFILLS a form for the user to review and submit —
`ui_open_server_form` precedent. Direct commit is for low-entropy actions
whose full input the model can plausibly get right and the user can see
happen.

### Names

`UI_TOOL_NAME_REGEX`: `ui_[a-z0-9][a-z0-9_]*`, max 64 chars. Distinguish
execution from initiation with the verb (Chrome WebMCP guidance):
`ui_execute_tool` really runs; `ui_select_tool` prefills. A name that reads
like it acts must act; a name that reads like it prepares must only prepare.

### Budget

Global catalog + your group must stay ≤ 56 tools (8 headroom under the
server's 64-entry snapshot cap, single-surface-mount assumption). The
coverage test enforces it — trim tools rather than raising the number.
