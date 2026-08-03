---
"@mcpjam/sdk": minor
---

OAuth client emulation: golden-trace comparator, freshness reporting, and
profile/golden binding (HP-43 step 6).

- **`normalizeOAuthTrace`** projects a run's HTTP history into comparable
  steps, neutralizing what differs on every execution — timestamps, CSRF
  state, PKCE, authorization codes, tokens, server-generated client ids, and
  the loopback callback port. Normalization replaces volatile **values** but
  never removes **keys**, so a client that stops sending a parameter is a
  visible difference rather than a silent one. Responses are excluded: a
  golden describes the client, not the server under test.
- **`compareOAuthEmulationTrace`** diffs a run against a real-client capture
  across the whole dance (discovery → registration → authorize → token →
  authenticated MCP request), reporting per-step method, URL, header, and body
  differences plus requests present on only one side.
- **Honest match claims.** The result carries `qualifiers` independent of the
  diff: `partial_coverage` (any `not_modeled` field), `stale_capture`, and
  `client_version_mismatch`. `isUnqualifiedMatch` is true only when the
  requests lined up, nothing was substituted, coverage was complete, and the
  capture is current — so a `not_modeled` field can never yield an unqualified
  `matched`.
- **Freshness.** Goldens carry a capture date and client version; older than
  90 days (`GOLDEN_STALENESS_DAYS`) is reported as stale, never as current.
  The threshold day itself is still current.
- **Binding.** A golden may only be compared against a run of the same
  profile: `compareOAuthEmulationTrace` requires the run's profile digest
  alongside the capture and returns `not_compared` /
  `golden_profile_mismatch` rather than diffing two different clients.
  `computeOAuthProfileDigest` and `computeOAuthGoldenTraceDigest` content-
  address both sides, and every preflight result now reports its `bindings`
  (profile schema version, profile digest, golden digest, catalog revision).
- `runEmulatedOAuthPreflight` gains `goldenComparison`, always emits its
  normalized `trace`, and its `comparison` field is now the full result
  object rather than a placeholder string.

Real-client captures live in the private backend, like the profiles; this
ships the engine only.
