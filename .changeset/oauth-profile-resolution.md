---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

OAuth client emulation: profile catalog resolution (HP-43 step 3, completing
the piece that was specified but not built).

The emulator could compile a profile it was handed, but nothing could turn
"emulate client X" into that profile. This adds the resolution path:

- **`fetchOAuthProfile` / `fetchOAuthProfileCatalog`** resolve a client id into
  an evidence-backed profile, ready for `deriveOAuthEmulation`.
- **`GET /api/v1/oauth-profiles[/:clientId]`** proxies the backend catalog, so
  the OSS SDK and CLI never learn a `*.convex.site` address.
- **`docs/host-oauth-profiles/profile-catalog-contract.md`** specifies the wire
  contract the private backend implements against.

Two deliberate departures from the `/v1/host-catalog` proxy this mirrors:

- **No bundled fallback, ever.** Bundling profiles would put client names in
  public source. A failed fetch therefore means "this client cannot be
  emulated right now" — never "something else was used instead", which would
  silently invalidate the coverage and comparison claims of the run that
  followed.
- **Authenticated.** Host-compat data is public metadata; a per-client OAuth
  evidence catalog is not, so the route sits behind bearer auth and is absent
  from the guest allowlist.

The SDK verifies rather than trusts what the catalog returns: the envelope
schema version must match exactly, the profile must survive the same
canonicalizer the backend uses, and `profileDigest` is **recomputed locally**
and rejected on mismatch. That last check matters because the digest gates the
golden-trace comparator's binding check — an asserted-but-wrong digest would
let a capture of one client be diffed against a run of another and reported as
a confident match.
