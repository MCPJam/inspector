---
"@mcpjam/inspector": patch
---

Guard the target URL on hosted conformance runs.

`/api/web/conformance/*` performed no validation on where it was about to
connect. Two inputs reach the dialer — the URL Convex resolved for the
authorized server row, and `oauthProfile.serverUrl`, which the OAuth suite
lets a caller supply outright and which overrides the resolved one. Since
guests can already run these suites, an anonymous caller could name
`http://169.254.169.254/` and have the hosted backend fetch cloud-metadata
credentials on their behalf. Authorizing the server row proves who is
asking, not where we are about to connect.

Both inputs now pass through one shared helper (`hosted-egress-guard`),
which blocks cloud-metadata, link-local, loopback, RFC-1918, CGNAT and IPv6
ULA targets and adds a DNS-resolution pass so a public hostname that
resolves to a private address is refused too. The whole guard is gated on
`HOSTED_MODE`: local and desktop runs keep dialing `localhost`, which is the
product. Only the target is judged — the protocol suite's deliberate
rebinding-style `Host` headers are untouched.

Closes a bypass in the host check itself along the way: `new URL()` rewrites
`[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, and only the dotted
spelling was recognized, so the hex form of any blocked address passed. The
browser harness shares this check and is fixed by the same change.

Hosted conformance runs also carry a per-IP ceiling (30 per 10 minutes)
alongside the existing 60/min per-guest limit — guest identities are free to
mint, so only the IP bounds how much outbound traffic one actor can aim at a
third party.
