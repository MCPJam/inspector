---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Skills over MCP: re-sync the host to the current SEP-2640 draft

Our SEP-2640 implementation was pinned to `modelcontextprotocol/docs @ d7490ec`. The draft has moved since, and three of its changes made our host wrong rather than merely out of date. Re-pinned to `modelcontextprotocol/modelcontextprotocol @ a3e147ca27` (`sep/skills-extension`).

**`"resources": "dynamic"` crashed the parser.** The draft makes `resources` required and gives it two forms: an enumerated manifest, or the bare string `"dynamic"` for a skill generated per request. `skillEntrySchema` accepted only the array, so a conforming server answering `"dynamic"` produced an `InvalidSkillsPayloadError` — a wire error, for a form the spec defines, with no way for the user to tell a server bug from ours. It now parses, and MCPJam refuses to *load* it as a stated policy (`dynamic_resources`), kept distinct from a server that omitted `resources` entirely (`no_resources`). Those are different server behaviours and collapsing them tells a conforming author their skill is malformed.

**`size` was never checked.** Each manifest entry now carries the file's byte length, and the draft makes a length mismatch "a verification failure equivalent to a digest mismatch, whether or not the host goes on to compute the digest". `verifySize` runs *before* hashing — which is the point of the field: it catches a truncated or padded read without paying for a digest, and it lets a host budget a skill from the entry alone. It gets its own `size_mismatch` kind, because "this file was cut short" and "this file was tampered with" are different diagnoses. A server that omits `size` is tolerated, not refused: the SEP is unratified and every implementation that exists today predates the field, so refusing would buy conformance with an unpublished rule at the cost of working with real servers.

**Our own caps refused conforming skills.** The draft sets per-skill limits of 512 entries and 16 MiB total, and says hosts MUST support up to them. Our caps — 128 KiB for a SKILL.md, 2 MiB for a supporting file — were invented before the draft had any, and both sat *below* that floor, so a conforming 3 MiB SKILL.md was refused as `too_large`. That was our bug, not the server's. The limits are now the draft's, enforced from the manifest before the first byte is fetched, with `too_many_resources` and `too_large` naming which one was breached.

Also fixes an error-reporting regression the union would have introduced: a `z.union` reports `resources: Invalid input` and buries the real per-field diagnosis in nested alternatives, which defeats the reason these guards exist. `issuesOf` now descends into union alternatives and rebuilds the full path, so a missing digest still reads as `resources.0: digest: …`.

Test coverage: `size`, the limits, and dynamic manifests get unit, fixture, and over-the-wire cases, including that a dynamic manifest authorizes *no* reads rather than all of them. The fixture gains `sizeMismatch`, `dynamicResources`, and `omitSizes` modes. `server-skills.ts` gets its first direct test — it was previously covered only through the chat wrapper.
