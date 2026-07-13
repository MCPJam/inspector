---
"@mcpjam/sdk": patch
---

XAA: rank authorization-server candidates by advertised ID-JAG capability during discovery. When a protected resource advertises several authorization servers, the shared engine now prefers, among issuer-matching candidates: (1) one advertising both the RFC 7523 jwt-bearer grant and the ID-JAG grant profile; then (2) one advertising jwt-bearer with the ID-JAG profile omitted (draft-04 SHOULD); otherwise (3) the first issuer-matching candidate, exactly as before. Ranking uses the two specific compatibility checks — never the vendor-influenced `overall` verdict — and is a preference heuristic, never a hard filter (a server may accept the grant without advertising it). Credential binding is preserved: an explicitly configured issuer stays a hard pin, and a confidential (client-secret) run is pinned to the first issuer-matching candidate so its secret is never redirected to a different RAS. Runtime-behavior change only; no API change.
