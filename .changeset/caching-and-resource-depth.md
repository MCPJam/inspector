---
"@mcpjam/sdk": minor
---

Grade the caching utility as shipped, not as SEP-2549 first proposed it.

`modern-cacheable-result-hints` encoded an early reading: presence of `ttlMs`
and `cacheScope` on `server/discover` plus whichever list methods the server
advertised. The 2026-07-28 caching utility is deeper in three ways it did not
cover.

- **Six operations, not four.** The shipped list adds `resources/templates/list`
  and `resources/read`, neither of which was ever probed — so a server could
  omit hints on every resource read and still pass.
- **The hint VALUES have a contract.** `ttlMs` is "an integer value in
  milliseconds" and servers "MUST provide a `ttlMs` value that is `>= 0`";
  `cacheScope` is exactly `"public"` or `"private"`. A fractional or negative
  TTL passed unnoticed, and clients are told to ignore a negative one — so a
  server sending it has silently published a different policy than it thinks.
- **Pagination has a stability rule.** "Servers MUST apply the same
  `cacheScope` to all response pages for a given list request." A list that
  flips from `private` to `public` mid-walk has a client caching later pages
  under sharing rules the server did not intend.

These land as three new checks (`modern-cache-hint-coverage`,
`modern-cache-hint-values-valid`, `modern-cache-scope-stable-across-pages`)
rather than as a widened existing one. Widening a scored check would silently
re-grade every server that was green under the narrower reading — exactly what
the conformance profile exists to prevent.

`ttlMs: 0` stays legal and stays an advisory (`readiness-cache-ttl-useful`);
the schema allows it via `minimum: 0`, so a check must not fail it.

SEP-2164 gains its second half. `modern-resource-read-no-empty-contents`
asserts the separate MUST that a read of a non-existent resource never answers
`{ contents: [] }` — ambiguous between "exists and is empty" and "does not
exist" — which a server can violate while still returning the right `-32602` on
another path. The spec's example also echoes the uri in `error.data`, but never
states it as a requirement, so that is `readiness-resource-error-echoes-uri` at
MAY strength.

All four checks land in the `pending` bucket and move no score.
