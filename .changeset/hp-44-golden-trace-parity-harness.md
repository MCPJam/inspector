---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

feat(oauth): golden-trace parity harness — capture host OAuth handshakes and diff emulator dances against them (HP-44)

Adds `sdk/src/oauth-golden-trace/`: a trace schema, normalizer, and field-by-field
differ that make "the emulator behaves exactly like the real host" mechanically
checkable. This is the acceptance oracle for HP-43 emulator enforcement, and the
evidence source for HP-9 (capability audit) and HP-38 (drift detection).

**Capture** from an in-process emulator run (`captureEmulatorTrace`, reusing the
existing `OAuthConformanceTest` wire records) or from a proxy HAR of a real host
(`captureHarTrace`). **Diff** with `diffGoldenTraces` across request ordering,
endpoints hit, params present/absent, headers, and the DCR body. **Project** onto
`HostConfigOAuthProfileV1` with `traceToOAuthProfile`.

Three design points that are load-bearing rather than stylistic:

- **Observations are a tri-state.** `absent` ("captured the leg, field wasn't
  there" — a citable finding) is distinct from `not-observed` ("never captured that
  leg" — a gap carrying no value). The differ reports gaps as loudly as differences
  but never as passes, and never as emulator bugs.
- **`protocolVersionPinning` is recorded as separate fields.** The `initialize` body
  version and the `MCP-Protocol-Version` header are tracked apart, per leg, with
  `wiresDisagree` as a first-class flag — these genuinely disagree in the wild, and
  one field would average away the most interesting findings.
- **Traces stamp the resolved OAuth dependency**, not just the host version, because
  most source-verified clients inherit OAuth from `rmcp` or the upstream TS SDK and
  a host-version-only stamp goes stale silently on a dependency bump.

Secrets are redacted at capture time via the existing `redactSensitiveValue`, then
re-checked by `assertTraceIsRedacted` — a capture that still contains a
secret-shaped value throws instead of being written.

New CLI: `mcpjam oauth trace capture | ingest-har | diff | to-profile`. `diff` exits
non-zero on any difference, so it works as a CI gate.

Ships a committed golden trace of `mcpjam` against itself plus 57 tests, including
nine negative tests that prove the oracle is not vacuous (a differ hardcoded to
return parity would pass the positive tests alone).

Also ships a real HTTP MCP server + authorization server that records its own
traffic as a HAR (`tests/support/oauth-capture-server.ts`), the first golden trace
of a real third-party host (`claude-code` 2.1.220 — which settled two cells prior
desk research could not and corrected two it had read from a published CIMD
document), and the emulator-vs-real-host diff that turns those into a concrete work
list. Running against real HTTP found four bugs an in-memory fixture could not,
including one that would have written a live authorization code into a committed
artifact via a `302 Location` header.
