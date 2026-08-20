---
"@mcpjam/sdk": patch
---

Readiness discovery: the credential and SSRF guards move into the shared core,
so the OpenAI lanes get them too.

The shared `directory-readiness/discovery.ts` was extracted from a snapshot of
the Claude module that predated its security fixes, so the publisher-neutral
copy every lane now calls had the original behaviour: the caller's headers
merged into **every** request, the redirect walk replaying them onto each hop,
and an issuer out of the target's own metadata dialled unvalidated. Those are
the same defects, in the file that is now the only implementation — which makes
this a port rather than a new fix, and the reason it is a port is worth saying:
a shared core is only worth having if the hardening is shared with it.

What the core does now:

- **Caller headers stay on the target's origin.** `--header "Authorization: …"`
  is a credential for the SERVER UNDER TEST. PRM names an authorization server
  routinely on somebody else's domain and a redirect can point anywhere, so
  merging those headers into every request handed the bearer token to whatever
  host the target's own documents chose — an exfiltration primitive, not a leak.
  Origin, not host: a scheme or port change is a different origin, and a token
  that travels from `https://` to `http://` is a token on the wire.
- **`credentials: "none"` for a probe that must carry none.** An unauthenticated
  probe that sends a credential cannot answer the question it exists to ask, and
  the 200 it gets back was being recorded as "this target needs no
  authentication at all".
- **An issuer is checked against RFC 8414 §2 before a socket opens.** Unlike a
  `resource_metadata` pointer it legitimately names another origin, so
  same-origin is not available as a rule — an https URL with no query and no
  fragment is, and plaintext passes only when it IS the target's own origin.
  Both callers are wired: Claude's `authorization_servers[0]`, and OpenAI's
  every-advertised-issuer loop, where the refusal is recorded per issuer so one
  bad entry does not stop the others being read.
- **A cancelled run stops dialling**, rather than stopping waiting. `signal`
  composes with the per-request timeout and is removed on the way out, so a long
  run does not accumulate one listener per request.
- **A body that failed to read is still a server that answered.** Returning
  status 0 there told `reachedServer` nothing was reachable, which turned a PRM
  read failure into "never asked".
- **`reachedServer` on PRM discovery.** A 404 is the server saying "no document
  here", which is a finding; a transport failure is not, and collapsing them
  grades an unreachable host as a target that publishes no metadata.
