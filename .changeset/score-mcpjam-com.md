---
"@mcpjam/inspector": minor
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
That makes the funnel free — "Debug these failures in MCPJam" hands over a
one-shot guest promotion proof, so signing in on app.mcpjam.com absorbs the
guest project and its server into the new account. (A bare link would not:
the guest cookie is host-only, so the proof has to be carried explicitly.)

Connect-OAuth (authorizing a server so the suites can run at all) reuses the
product's redirect gate under a new `"score"` surface. The surface is not
cosmetic: `"project"` would rewrite the return path to `/servers` and lose
the run, and `"chatbox"` demands a chatbox id that does not exist here. The
OAuth conformance _suite_ keeps its own popup flow and is opt-in — declining
it shows as _not scored_, never a deduction.

Results are private by link: no directory, no listing, and the read route
takes no bearer at all, so a shared result opens in an incognito window.
Submissions are per-IP rate limited. Stated plainly: a v1 report is
client-assembled and therefore forgeable, which is acceptable only because a
run makes no third-party claim — a badge would need a server-verified re-run.

Stdio and localhost servers can't be scored on the hosted runner and say so,
pointing at `npx @mcpjam/inspector`.
