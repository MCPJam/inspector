---
"@mcpjam/sdk": minor
---

SDK: tighten the HostConfig v2 canonicalizer (four follow-up items deferred from #2392). All four ship together as the second-half of the Stage 1 backend consolidation — the backend imports the canonicalizer directly from `@mcpjam/sdk/host-config/internal`, so this PR is the single source of behavior change for both sides.

Behavior changes (all on `canonicalizeHostConfigV2` / `computeHostConfigHashV2`):

- **Deep-sort `clientCapabilities` and `hostContext`.** Previously a shallow `sortStringKeys` left nested key order leaking into the canonical hash, so `{ extensions: { ui: { a, b } } }` and `{ extensions: { ui: { b, a } } }` minted distinct rows for identical capability sets. Now both fields go through the same recursive sort already used for `*Override` and `mcpProfile`.
- **Collapse empty `allowFeatures` to absent.** A user `allowFeatures: {}` (or `{ camera: "*" }` whose only keys are spec-permission features that the canonicalizer drops) now omits the field entirely, matching the sibling `openaiAppsOverrides` collapse and preventing semantic dupes.
- **Drop `openaiAppsOverrides` when `compatRuntime.openaiApps === false`.** The resolver ignores per-method overrides when the shim isn't injected; letting them affect the hash minted rows that resolved to identical runtime behavior.
- **Fail-fast on missing `clientCapabilities` / `hostContext`.** The previous `?? {}` coalescing silently merged a writer-bug `undefined` into the empty-cap dedupe pool. Both fields are required on the input type; the canonicalizer now enforces it at the boundary.

Audit confirmed all four items are **hash-neutral for current production data** (15,389 prod hostConfigs rows scanned across the four predicates; 0 hits). The bundled parity fixture was regenerated; `EXPECTED_INPUT_HASH` bumped accordingly. External SDK consumers using the public `Host` builder are unaffected — the canonicalizer is internal-only.

Out of scope: the eight `@mcpjam/sdk` items still tracked elsewhere (Stage 3+ in the macro plan).
