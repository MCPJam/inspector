# Cloud harnesses: QA matrix

Internal checklist for rolling out "cloud harnesses everywhere". Every cell is
one real turn with an MCP tool call, run against a deployment whose computer
template is current (`inspector-bake-ref` points at the deployed commit).

## What every cell must show

1. **Baked boot.** The `[harness][timing]` line carries `bootstrap=baked`
   (not `installed`, not `none`).
2. **One usage record.** Exactly one `llmUsageRecord` for the turn, with
   `metadata.route = '/web/harness/model-proxy'`. Cursor takes no model lease,
   so it records none: its cell expects **zero** records and no lease row.
3. **Longer than the idle TTL.** One turn that runs past the surface's idle TTL
   (eval 30m, journey 60m, scenario 20m, Playground terminal 30m) still
   completes: the heartbeat keeps the box alive and the reaper leaves it alone.
4. **No persistent machine.** No turn lands on a persistent computer, except
   the single-column Playground, which uses the personal computer.
5. **Secrets.** A project secret reaches the box only through the run's
   environment (brokered, never in the box's env bag); a personal secret never
   reaches a participant's box.

## Matrix

| Surface | Claude Code | Codex | Cursor |
|---|---|---|---|
| Playground, one column | personal computer | personal computer | disposable box; needs an environment granting `CURSOR_API_KEY` |
| Playground, compare (2+ columns) | disposable box per column | same | same |
| Eval suite run | disposable box | same | same |
| Single-case run | disposable box | same | same |
| Swarm | disposable box per target | same | same |
| User Testing, member, link | scenario box | same | same |
| User Testing, member, invite | scenario box | same | same |
| User Testing, participant, link | scenario box | same | project-shared key required |
| User Testing, participant, invite | scenario box | same | project-shared key required |
| v1 chat API | disposable box | same | same |

## Negative cases

- Cursor, no key: pre-flight error naming `CURSOR_API_KEY`.
- Cursor, personal key, User Testing participant: pre-flight error asking an
  admin to share it; no box is booked.
- Cursor, key bound to the wrong host/header: pre-flight error describing the
  binding.
- Harness unavailable for the model: `422 FEATURE_NOT_SUPPORTED` from the chat
  routes.
- Box cap reached: `503` with the capacity message; the turn spends nothing.
- Playground second turn on the same conversation reuses the box
  (`resumed=true`); closing the tab releases the heartbeat and the box reaps at
  its TTL.

## Where to look

- Logs (Axiom `inspector-logs`): `[harness][timing]`, `[harness] turn failed`,
  `[harness][bootstrap]`; monitors `harness-bake-miss-rate` and
  `harness-turn-failure-rate`.
- Convex: `evalSandboxes` rows by `(scopeKind, scopeKey)`; `llmUsageRecord` by
  `metadata.route`.
- Ops runbook: `templates/computer/OPS.md` in mcpjam-backend.
