---
"@mcpjam/cli": minor
"@mcpjam/sdk": minor
---

OAuth client emulation: flag-gated CLI rollout (HP-43 step 7).

`mcpjam oauth emulate` runs an emulated client's OAuth ladder against an MCP
server, headless and CI-ready, on the existing `oauth` command group — no new
surface.

- **Feature-flagged.** `MCPJAM_OAUTH_EMULATION=1` is required; without it the
  command refuses with a message naming what it would do. An emulated run
  registers a client and may obtain a token on the target server, so it is
  opted into deliberately.
- **Profiles are data, never names.** `--profile <path>` takes a JSON profile
  the private backend produces, canonicalized on load through the same SDK
  canonicalizer the backend uses. The CLI ships no client catalog.
- **Comparison and capture.** `--golden <path>` compares the run against a
  real-client capture (refused unless its `profileDigest` matches the run's);
  `--trace-out <path>` writes this run's normalized trace already bound to its
  profile, ready to become a golden.
- **Exit codes** join the shared conformance vocabulary: `0` pass, `1` failed
  (including a mismatched comparison — the finding the emulator exists to
  produce), `2` usage, `3` incomplete. Stopping at the consent leg is
  incomplete, not a pass: nothing was established.
- `--auth-mode headless` crosses the consent leg against an auto-consenting
  authorization server; the default stops and reports the URL.

SDK: `completeHeadlessAuthorization` is now exported, and
`runEmulatedOAuthPreflight`'s `completeAuthorization` callback receives the
run's own executor so a headless completer uses the same hardened transport
(SSRF guard, timeouts) as the flow rather than building its own.
