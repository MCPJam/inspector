---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

A backend refusal reaches the caller, and a composed stack can carry a credential

**A named refusal stopped arriving as `INTERNAL_ERROR`.** Launching an eval run
whose environment selects a materialized secret answered
`{"code":"INTERNAL_ERROR","message":"[Request ID: …] Server Error"}` in
production. The backend had refused it deliberately — a `ConvexError` carrying
`ENV_MATERIALIZED_SECRETS_UNSUPPORTED` and a sentence naming the remedy
("switch those secrets to brokered delivery") — and the v1 error boundary threw
both away, so the cause was readable only by tailing `convex logs --prod`. The
boundary now translates a structured `ConvexError` before the runtime
classifier sees it: a 400 carrying the backend's own message, with its code in
`details.code`. Codes the shared translator already knows keep their canonical
status, so a plan cap is still a 429 and a stale precondition still a 409.

The gate is `{ code, message }` both being non-empty strings on the error's
`data`, and that is the whole safety argument: a `ConvexError` is not an
accident, a `code` is a contract someone wrote down, and a `message` is prose
written for the caller. Nothing reads `error.message`, so an unstructured
throw — a `TypeError`, a dead socket, a validator rejection whose text names
our internals — keeps the opaque 500 and the on-call page it had before.

**A composed stack has a credential axis.** `secretSelection` reached the named
environment operations and stopped there: the compose schemas and resolver
carried only skills and plugin versions, and a `z.object` strips what it does
not declare, so a grant handed to `ensure_adhoc_environment` or to a run's
`compose` vanished between the caller and the wire. The REST route, the OpenAPI
schema and the backend mutation had accepted it the whole time. The cost was
not cosmetic: a harness run that needed a credential could not be composed at
all — it had to be given a named environment. Both compose surfaces now take
`secrets`, and the CLI grew `eval run --compose-secret`, `eval cases run
--compose-secret` and `environments ensure-adhoc --secret`.

**Sending a grant to a deployment too old for one now refuses cleanly.**
`PlatformEnvironmentCapabilities.secretGrants` joins `modelOverrides` and
`skillVersionPins`, and the CLI probes it before a grant-bearing write — the
same preflight `modelId` has always had, spent only by the calls that carry a
grant. Note the ordering this implies: a deployment that supports secret grants
but does not yet publish the flag reads as "unsupported", so the backend half
publishes `secretGrants` first.
