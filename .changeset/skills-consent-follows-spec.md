---
"@mcpjam/inspector": patch
---

A server-origin skill load follows the host's approval policy, as SEP-2640 asks

Loading a skill served over MCP forced its own approval prompt regardless of the host's policy. That was MCPJam policy, not conformance — and it made the feature unusable on every surface that is not one long-lived process.

**Why it was broken.** The gate recorded the approved digest set in a `Map` inside the closure `withServerSkills` creates. `prepareChatV2` — and therefore that closure — is rebuilt per request. So the gate wrote its binding into one request's Map and `execute`, running after the approval round trip in the *next* request, looked in an empty one and refused with `manifest_unbound`. Local mode kept a single closure alive across the round trip and never saw it. In the hosted Playground the user was never even prompted, so the gate failed in both directions at once: it did not ask, and it did not load.

**Why deferring is correct.** SEP-2640 does not require approval to read a skill's text. Its consent obligations are narrower: host-side code execution (#2), `allowed-tools` (#5 — ignored outright here), activating a nested skill (#6 — never done here), and cross-origin reads (#3 — impossible, since the manifest is an allowlist confined to the skill's own directory). What the spec asks for a plain load is **origin tagging** — mark the content as untrusted third-party input — which is the banner, and it stays unconditional.

So the load now follows the host's policy like any other tool on the turn. Where a prompt does fire and the closure survives (local mode), the digest-set binding is still recorded and still compared, so the content-binding rule (#7) holds for the persistent-approval case it actually governs. `UNRESOLVED` — the gate ran and no manifest stood behind the prompt — still fails closed.

Unchanged on every surface: size and digest verification, frontmatter drift, URI/name identity, the manifest as a read allowlist, and the origin banner.

Verified against live staging with no approval flow at all: the skill loads, the banner is present, an unlisted file is refused, and a file belonging to a *different* skill on the same server is refused.
