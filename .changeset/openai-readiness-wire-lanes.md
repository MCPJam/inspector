---
"@mcpjam/sdk": minor
---

Wire the OpenAI endpoint, authorization, annotation and domain-verification
lanes, and extract the publisher-neutral discovery core.

`sdk/src/directory-readiness/discovery.ts` now holds everything about getting
evidence off the wire that does not depend on whose directory is being graded:
the bounded body read, the SSE-aware JSON fetch, the hop-by-hop redirect trace,
and Protected Resource Metadata discovery with its same-origin refusal of an
attacker-controlled `resource_metadata` pointer. Each of those has a failure mode
that is invisible until it bites, and each was found once already — a second copy
would eventually get one of them wrong in a way that looked fine.
`claude-readiness/discovery.ts` keeps every exported name and delegates.

The OpenAI checks are the ones OpenAI's own docs make different:

- **Every advertised authorization server is fetched**, not just the first.
  Anthropic's client uses `authorization_servers[0]` and Claude's runner stops
  there deliberately; ChatGPT documents multiple issuers, so a runner that looked
  at one would report a multi-issuer server as healthy on the strength of an
  entry the host may never pick.
- **RFC 9207 `iss`** is `required` once there is more than one issuer and merely
  informational with one — with a single issuer it is not load-bearing, and
  failing on it would be inventing a requirement.
- `_meta["mcp/www_authenticate"]`, Client ID Metadata Documents as an
  alternative to dynamic registration, and issuers offering no
  authorization-code grant at all.
- Annotation hints are graded on PRESENCE. A missing hint is not "assumed safe",
  it is unreviewable. Whether a declaration is HONEST is a heuristic in
  experience-insights, where it can never fail a lane — a tool name is not a
  specification.
- Domain verification checks that the well-known path responds and that the body
  matches the declared token, with `declared` provenance and no token value
  recorded in the finding. With no declared token it is `not-evaluated`, never a
  pass on the strength of "something answered".
