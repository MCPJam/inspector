---
"@mcpjam/sdk": patch
---

Collapse ~1,300 lines of duplicated sequence-diagram action builders into one era-parameterized builder.

`buildActions_2025_03_26` / `_2025_06_18` / `_2025_11_25` / `_2026_07_28` were four near-identical array literals totaling ~1,700 lines. They are pure presentation — the arrows in the debugger's sequence diagram — with zero effect on the wire, which makes them the one part of the era machines where consolidation is all upside: maximum maintenance cost, no protocol risk. (The wire step tables are the opposite trade and deliberately stay separate.)

The eras genuinely differ in five places, and each is now a field on an era spec rather than a conditional buried in a shared body: whether the ladder opens with the RFC 9728 protected-resource preamble (2025-03-26 does not), the MCP method on the unauthenticated probe, how the authorization-server metadata document is discovered, PKCE's requirement wording, and 2026-07-28's three additions (the DCR-deprecation note, the issuer the credentials are bound to, and the SEP-2350 scope union).

Verified rather than asserted: `sequence-actions-goldens.test.ts` snapshots the rendered actions for every era × every supported registration strategy × populated and empty flow state — 24 snapshots — and they are byte-identical across the change. One quirk is preserved deliberately, with a comment saying so: an operator-precedence artifact that renders `"undefined..."` for an absent code challenge. Fixing it would move the goldens, and this change's job is to not move them.
