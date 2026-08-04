---
"@mcpjam/inspector": patch
---

Move the conformance run loop into a shared `useConformanceRun` hook.

`ConformancePanel` owned all of it inline: per-suite run state, the four
route calls, the OAuth-conformance popup and its postMessage/BroadcastChannel
callback, per-suite score derivation, and the pooled headline. A second
surface (score.mcpjam.com) runs the same four suites, and a second copy would
drift on exactly the parts that must not — what "done" means per suite, which
transports can run which suite, and how the headline pools counts rather than
averaging suite scores.

Behavior-preserving for the panel, which is now the hook's first consumer;
its 27 tests pass unchanged. Rendering did not move.

One new option comes with it, inert until something sets it:
`deferOAuthAuthorization` parks a run at the OAuth authorization step
(`status: "needs-authorization"`) instead of opening the popup, leaving the
caller to decide via `authorizeOAuth()`. The panel passes false — an operator
who pressed "Run" asked for the whole run — but an unrequested popup on a
public landing page is a different thing, so the score surface will make
OAuth an explicit opt-in.
