---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Close the DNS and disclosure gaps in the probe's metadata destination guard.

The guard added alongside the 403 challenge work checked IP literals. Two holes remained.

`assertOutboundOAuthUrlAllowed` does no name resolution — by design, since it is browser-safe — so a challenge naming `https://metadata.attacker.example/prm` passed the check and the probe dialled whatever that hostname answered with, private addresses included. Resolving inside the probe is not available: `probeMcpServer` is exported from the worker entry, whose module graph has no Node builtins in it, and `node:dns` would be the first. So `runServerDoctor` now accepts a `fetchFn`, and the hosted doctor route passes `createGuardedFetch()` — the egress guard this repo already uses on the conformance routes, which resolves every hop, classifies every returned address, and forces `redirect: "manual"` underneath so a `Location` is checked before anything dials it. Outside hosted mode that guard is the identity function, so local and LAN probing is untouched. A new test bundles the worker entry and fails if any Node builtin enters its graph, which is what stops a future fix from relocating the resolver back into the probe.

The redirect check was also too late to matter. It ran on the value `performRequest` returned, but `performRequest` had already read the body and written the response into the attempt object — and that object is in `transport.attempts`, which the hosted API returns to the caller. A probe pointed at a redirect landing on `169.254.169.254` reported `discoveryError: Refusing outbound OAuth fetch to private/reserved host` while handing back the internal document in the same payload. The check now runs inside `performRequest`, between the response arriving and anything being read from it, so a refused destination records an error and no response, and its body is never read. Refusing to consume a response and refusing to disclose it are not the same thing, and only the first was implemented.
