---
"@mcpjam/sdk": minor
---

Record who has to act on an error, not just what went wrong.

Every catalog entry now carries an `origin`: `user_server`, `user_config`, `mcpjam`, or `ambiguous`. MCPJam is a debugger, so pointing it at a broken server is the product working rather than an incident — this is the field that lets a failure be shown plainly to the user without alerting the MCPJam team, and lets the failures that *are* ours stop hiding inside that noise.

- `origin` is optional on the published `ErrorCatalogEntry` type so external callers can still construct one, and required in practice: a test asserts every catalog slug declares it. Read it through the new `originOf()`, which defaults a missing value to `ambiguous` — payloads cross versions, and an older normalized error has no origin at all. `isNormalizedError` deliberately does not require the field, so those payloads still pass the wire guard.
- `describeError(error, context)` and `describeAsSlug(slug, error, context)` accept an optional `credentialOwner`. Auth and provider failures default to `user_config` because the credential is normally the user's; hosted paths that refresh their own tokens or bill a managed provider key pass `credentialOwner: "mcpjam"` so the same failure is correctly recorded as MCPJam's. Nothing else is reassigned — a managed-credential caller hitting a refused port still gets `user_config`.

Two classifications are worth calling out because the obvious reading is wrong. `jsonrpc/invalid_request` and `jsonrpc/header_mismatch` are `ambiguous`, not `user_server`: MCPJam builds that envelope, so a serialization bug of ours lands there, and filing it under the user would make the one class of bug that affects every user the class we never see. `internal/unknown` is `ambiguous` rather than `mcpjam` for the mirror-image reason — every unrecognized failure from an arbitrary server lands there, and treating it as ours would rebuild the noise problem.

Origin is a routing signal, not display copy. User-facing text should keep coming from each entry's `oneLine` / `likelyCauses` / `nextSteps`, which already describe cases the wire cannot disambiguate — a refused port is "nothing is running there" or "the port is wrong", and no origin value can tell you which.
