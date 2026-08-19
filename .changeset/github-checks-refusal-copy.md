---
"@mcpjam/inspector": patch
---

Show the GitHub Checks settings refusal the backend actually wrote, instead of
`Server Error`.

Convex masks a plain thrown error as `Server Error` plus a request id before it
reaches a browser; only a `ConvexError` arrives intact, carrying its message as
a payload on `data`. Both connect surfaces read `error.message`, so every
carefully-worded refusal on this page — the repository is not reachable by the
App, GitHub is down right now, that repository is already connected, this
organization is at its limit — reached administrators as `Server Error`.

Less visibly, the availability branch matched on the message text, so with a
masked message it never fired and the page could not substitute its own copy.

Both surfaces now shape write errors through one helper that reads `data` first
and falls back to a de-prefixed `message`, which keeps plain throws from a dev
deployment readable. Requires the backend change that throws these refusals as
`ConvexError`s (mcpjam-backend #1028).
