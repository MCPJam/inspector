---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": patch
---

The local inspector reaches OAuth servers on your own network

Testing a fully local OAuth setup failed with `OAuth proxy target resolves to
a private/reserved IP address (127.0.0.1)` whenever the authorization server
had a hostname of its own — `auth.local`, or anything else answering
loopback. The address guard could not tell a developer's laptop from our
hosted infrastructure, so it applied the policy written for the second to
both, and the official MCP Inspector, which has no guard at all, worked where
we did not.

**What changed.** The guard now distinguishes two questions instead of
answering one. "Is this private?" still governs the hosted app, which fetches
from our nodes where a private address means our own network. "Is this ever
dialable?" governs the local inspector and the CLI, and refuses only what is
never a real OAuth endpoint: link-local and every cloud metadata service,
including the two that hide inside ranges corporate networks legitimately use
(Alibaba's inside CGNAT, AWS's inside the unique-local range), plus the
unspecified address, multicast and reserved space.

So `npx @mcpjam/inspector` and `mcpjam oauth …` now reach loopback, LAN,
CGNAT and unique-local targets, and hostnames that resolve to them, with no
flag to set. The hosted app is unchanged. The CLI's three OAuth proxy
commands, which hardcoded the hosted policy and could not be talked out of
it, gain `--https-only` for reproducing what the hosted app would do.

**For SDK consumers.** `allowPrivateNetwork` (and `allowPrivateMetadataFetch`
on the state-machine surfaces) is additive and defaults to false, so existing
callers keep today's behaviour without changing a line, and `httpsOnly` still
overrides it. The one visible difference for an unchanged caller is wording:
a link-local or metadata destination now says so, instead of being reported
as "private/reserved".

**What is still refused locally.** The allowance belongs to the chain, and
the chain's character is decided by where its first hop actually landed
rather than by how the hostname looked — a name that looks public and answers
`127.0.0.1` is the case this exists to serve, so a name-based test would
refuse the thing it permits. A public server that answers `302 Location:
http://192.168.1.1/…` therefore cannot make your inspector fetch it. DNS is
still resolved once and pinned into the socket, so rebinding is closed, and
cross-origin redirects still drop credentials.
