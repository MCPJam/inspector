---
"@mcpjam/inspector": patch
---

Evaluate (New) chain reads carry the user's bearer, so they stop 401ing as "could not be loaded"

The decision summary and the stage-analytics funnel both rendered a service error on every run — "Couldn't load the decision summary", "Stage analytics could not be loaded … Bearer token required" — while the API answered those exact routes correctly to any client that sent a token.

`authFetch` is the single owner of the `Authorization` header, and it attaches one only to paths named in `HOSTED_AUTH_PATH_PREFIXES` / `HOSTED_AUTH_PATH_PATTERNS`. That list grants `/api/v1/` **path by path on purpose**: the prefix that would cover these, `/api/v1/projects/`, would hand the user's bearer to every project-scoped public-API route that ever ships. Three eval-chain routes were never added to it, so their requests went out with no `Authorization` at all and the API returned its ordinary `401 Bearer token required` — which the clients map to `requestFailed`, whose copy reads as a backend outage rather than a missing header.

Adds two anchored patterns covering `eval-runs/{id}/decision-summary`, `eval-runs/{id}/stage-analytics`, and `eval-suites/{id}/stage-analytics`.

This is the third time this exact bug has shipped, and the second half of the fix is the tests. `/web/registry/*` shipped with no entry and every call went out unauthenticated; readiness needed a pattern because its scope sits mid-path; G4b's run-disclosure remembered, D9 and D5c did not. Nothing fails until runtime — no build error, no type error, no test — because the allowlist is a hand-maintained list that a new consumer has to remember to join.

So the new suite spends 10 of its 14 cases proving the grant stayed narrow: sibling routes under the same project (`eval-runs/{id}`, `eval-runs/{id}/iterations`, `eval-suites/{id}`, `eval-suites/{id}/runs`, `eval-runs/{id}/insights`), paths that merely start the same way, one path segment too many, and a foreign origin on a chain path all still receive nothing. Verified load-bearing: reverting the patterns fails exactly the four positive cases and leaves the ten narrowness ones green.

Not local-dev-specific — `shouldAttachHostedAuthorization` never branches on hosted mode and same-origin passes its origin check in production too, so both panels were broken wherever `evaluate-enabled` was on.
