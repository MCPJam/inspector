---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

An environment's secret grant is reachable from the SDK, CLI and MCP again

`secretSelection` is how a project secret is granted to the runs an environment launches. The API takes it on create and on update, the `/api/v1` route takes it on both, and `PlatformEnvironmentCreateBody` / `PlatformEnvironmentUpdateBody` have always declared it — but the two operation schemas in `platform/operations.ts` never did, so the only surfaces an agent or a script can use dropped it on the floor.

Both halves were silent in the way that costs the most time:

- **Create** parses through a `z.object`, which STRIPS what it does not declare. A create carrying a grant returned 201 with `secretSelection: null` and no error anywhere — the environment simply had no credentials, and the failure surfaced much later as a run refusing to start for want of a secret that had apparently been attached.
- **Update** validated fine, but the at-least-one-field `.refine` did not list the field, so a PATCH changing ONLY the grant was rejected client-side with a message that enumerated eight other fields and not the one the caller had passed.

Together those meant a secret could be attached by neither path: not on create, and not afterwards. The route's own comment says as much about what unclearable would cost — "an environment's credential grant can only ever grow, and revoking it would require deleting the environment" — and that was the state the SDK was in.

The field now rides a single shared `secretSelectionInput` used by both operations, matching how `skillSelection` and `pluginVersionIds` are already shared, with the same tri-state on update: omit to leave unchanged, `null` to REVOKE, a value to replace. `secretIds: []` is rejected rather than read as "remove every credential" — that is what `null` is for.

The CLI's `--file`/`--json` help on `environments create` and `environments update` listed every other body field but this one; it lists it now.

Not changed: `ensure_adhoc_environment` and the run operations' `compose` still have no secrets axis, though the route accepts one. A composed stack cannot carry a grant, so a run that needs a credential still needs a named environment.
