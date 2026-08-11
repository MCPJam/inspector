---
"@mcpjam/inspector": patch
---

Stop the OAuth debugger from rendering an accepted 403 challenge as a failure.

The flow now continues past a 403 that carries a `WWW-Authenticate: Bearer` challenge, but the log surfaces still decided "was this exchange expected?" by re-testing `status === 401` on the probe step. A run that succeeded therefore drew a red step card, counted an error, and hoisted `403 Forbidden` into the step header — contradicting the warning sitting inside the same card that explains why the flow went on.

All four sites now call `isUnauthenticatedProbeChallenge`, which the SDK exports over the same classification the probe step gates on. The predicate takes the step, status, and `WWW-Authenticate` header, so the UI cannot admit a 403 the flow rejected, or reject one it accepted. A bare 403, a 403 offering only a scheme OAuth cannot use, and a challenge on any other step all still read as errors.
