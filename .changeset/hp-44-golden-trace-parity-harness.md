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
  but never as passes, and never as emulator bugs. The tri-state reaches the derived
  ROLLUPS too: `wiresDisagree`, `headerDisagreesWithInitializeBody` and
  `userAgent.consistent` are `Observation<boolean>`, not `boolean`, so a partial
  capture cannot be read as "these agree" — a boolean `false` there was the one place
  the schema still collapsed "no disagreement" into "could not tell".
- **`protocolVersionPinning` is recorded as separate fields.** The `initialize` body
  version and the `MCP-Protocol-Version` header are tracked apart, per leg, with
  `wiresDisagree` as a first-class observation — these genuinely disagree in the
  wild, and one field would average away the most interesting findings.
- **Traces stamp the resolved OAuth dependency**, not just the host version, because
  most source-verified clients inherit OAuth from `rmcp` or the upstream TS SDK and
  a host-version-only stamp goes stale silently on a dependency bump.

Secrets are redacted at capture time via the existing `redactSensitiveValue`, then
re-checked by `assertTraceIsRedacted` — a capture that still contains a
secret-shaped value throws instead of being written. The redaction policy is applied
by CANONICALIZED key, so `accessToken` and `mcp_refresh_token` are caught alongside
`access_token`; and a `RedactionViolation` reports `matchLength` plus a truncated
SHA-256 `fingerprint` rather than an excerpt, because a violation travels through
assertion messages and CI logs that are less protected than the artifact it just
refused to write.

`traceToOAuthProfile` returns a projection; `mergeTraceOAuthProfile` layers it over
an existing profile without letting an `unverifiable` field from this trace displace
evidence another capture already settled.

New CLI: `mcpjam oauth trace capture | ingest-har | diff | to-profile`. `diff` exits
non-zero on any difference, so it works as a CI gate. Subcommands given `--out` write
the artifact and emit only a `{ traceId, path }` reference, so stdout stays pipeable.

Ships a committed golden trace of `mcpjam` against itself plus 125 golden-trace tests
and 16 CLI tests, including negative tests that prove the oracle is not vacuous (a
differ hardcoded to return parity would pass the positive tests alone).

The pin-vs-negotiate projection now verifies its own premise. That claim needs one
client against TWO servers advertising DIFFERENT protocol versions, so a scenario
records `serverProtocolVersion` and `traceToOAuthProfile` checks it: a contrast trace
whose server advertised the SAME version — or whose advertised version is unrecorded —
is refused with a named blocker instead of yielding a `verified` pin. Previously only
the client identity and the scenario id were checked, and neither can tell those two
servers apart, so the strongest claim in the module rested on a caller promise.

The cross-vantage test pins the EXACT set of paths on which a client-side and a
server-side capture of one handshake disagree, so a new disagreement fails the build
instead of scrolling past in a log. Twenty-two are stack defaults the client never set
(`user-agent`, `accept-language`, and `accept` on the three legs where the client sets
none — the legs where it does set `Accept` agree, which is what shows these are
defaults rather than lost headers). Two are a recorded-vs-sent bug in the OAuth state
machines, pinned separately as a defect record rather than blessed.

Also ships a real HTTP MCP server + authorization server that records its own
traffic as a HAR (`tests/support/oauth-capture-server.ts`), the first golden trace
of a real third-party host (`claude-code` 2.1.220 — which settled two cells prior
desk research could not and corrected two it had read from a published CIMD
document), and the emulator-vs-real-host diff that turns those into a concrete work
list. Running against real HTTP found four bugs an in-memory fixture could not,
including one that would have written a live authorization code into a committed
artifact via a `302 Location` header.
