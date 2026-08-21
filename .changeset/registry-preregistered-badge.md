---
"@mcpjam/inspector": minor
---

Badge directory rows whose OAuth probe resolved to pre-registered-only
registration — "Requires pre-registered client" on the card and the detail
dialog.

The verdict is the backend's nightly `oauthProbe` sweep asking each
connectable row's authorization server for its registration posture
(DCR / CIMD / neither). It is a probe **fact**, distinct from the upstream
listing's `authPosture` claim, and the badge renders only when the probe can
back it:

- **`resolved` verdicts only.** `no_metadata` and `unreachable` are
  indistinguishable from a server that does not do OAuth discovery at all, so
  they render nothing.
- **The verdict must be about the row's current endpoint.** The ETL never
  touches `oauthProbe`, so between an endpoint move and the next sweep a row
  can hold a verdict about its old URL; `requiresPreregisteredClient` mirrors
  the backend's `probeTargetFor` (fixed → `remoteUrl`, options → first
  published endpoint) and refuses a mismatched verdict.
