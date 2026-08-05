---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

score.mcpjam.com — paste an MCP server URL, get a conformance score.

A public, sign-in-free surface: paste a URL, we run all four conformance
suites against it and return one 0–100 number with a private shareable
`/results/<token>` link. The scoring engine is the one already in the
product, so the number means exactly what it means inside MCPJam.

It rides the existing Railway service as a vanity domain (the caniuse.dev
pattern): `SCORE_LANDING_HOSTS` sends `score.mcpjam.com/` to the chrome-less
`/embed/score` route, and `/results/<token>` deep links pass through
untouched. No new deploy.

The runner is a guest-backed product surface rather than a raw-URL API: a
visitor mints a guest session, the pasted server becomes a real row in that
guest's project, and the existing hosted conformance routes run unchanged.
"Debug these failures in MCPJam" is a plain link for now — carrying the
scanned server into a new account needs a one-shot exchange endpoint, because
the guest cookie is host-only and the promotion proof is a credential that
does not belong in a URL.

Connect-OAuth (authorizing a server so the suites can run at all) reuses the
product's redirect gate under a new `"score"` surface. The surface is not
cosmetic: `"project"` would rewrite the return path to `/servers` and lose
the run, and `"chatbox"` demands a chatbox id that does not exist here. The
surface owns its own pending sentinel and its own OAuth callback origin —
both are per-origin state, so a callback that lands on the app cannot see
them. Adding `score.mcpjam.com` to the redirect allowlist mints a new
`redirect_uri`: dynamic registration carries it per flow, but Client ID
Metadata Document flows only accept URIs listed in the document, so the host
must be added there before CIMD servers will authorize. The OAuth conformance
_suite_ keeps its own popup flow and is opt-in — declining it shows as _not
scored_, never a deduction.

Results are private by link: no directory, no listing, and the read route
takes no bearer at all, so a shared result opens in an incognito window.
Anything stored is redacted first (`redactConformanceReportForSharing`, new
in the SDK and browser-safe): a completed OAuth run holds a live access
token, a refresh token and the client secret, and a link that exists to be
forwarded must not carry them. Raw HTTP evidence is dropped rather than
scrubbed, and every field a result page renders survives. Submissions are
per-IP rate limited, per replica. Stated plainly: a v1 report is
client-assembled and therefore forgeable, which is acceptable only because a
run makes no third-party claim — a badge would need a server-verified re-run.

Stdio and localhost servers can't be scored on the hosted runner and say so,
pointing at `npx @mcpjam/inspector`.
