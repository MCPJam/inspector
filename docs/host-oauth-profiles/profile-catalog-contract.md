# OAuth client profile catalog — wire contract

The emulator (HP-43) runs an MCP server through the OAuth behavior of a
specific real client. The *behavior* is generic machinery in this repo; the
*client identities and their evidence* live only in the private backend. This
document is the contract between the two, so the backend has something
concrete to implement against.

## Why there is no bundled fallback

`host-catalog` — the closest analogue in this repo — always returns a document:
if the upstream fetch fails, it serves a stale cache, and failing that a
catalog bundled into the SDK. That is correct for host-compat, whose data is
public.

OAuth profiles cannot do this. Bundling them would place client names and
per-client findings in public source, which is the one constraint the whole
feature is organized around. So the failure mode is different, and deliberately
worse:

> A failed fetch means **"this client cannot be emulated right now."** It never
> means "use a bundled copy," and it never silently degrades into emulating
> something else.

Callers must surface `unavailable` as a real failure. An emulated run that
quietly fell back to a different profile would report a comparison and a
coverage summary for a client it never emulated.

## Endpoints

Served by the backend, proxied by the inspector at `/api/v1/oauth-profiles*`
so the OSS SDK and CLI never learn a `*.convex.site` address.

Both require authentication. The plan's invariant is "not in public source,"
not "secret at runtime" — but that concerns the *tested server* seeing a
`client_name` on the wire, which is unavoidable. It does not require the
catalog to be world-enumerable, so these routes sit behind bearer auth and are
**not** on the guest allowlist.

### `GET /oauth-profiles`

Lists what can be emulated. Metadata only — no profile bodies.

```jsonc
{
  "schemaVersion": 1,
  "catalogRevision": "2026-08-04T00:00:00Z",   // opaque; recorded in run bindings
  "entries": [
    {
      "clientId": "example-desktop",            // opaque, stable, URL-safe
      "label": "Example Desktop",               // optional, for display
      "clientVersion": "1.2.3",                 // optional; build the profile describes
      "profileDigest": "9f2b…",                 // sha256 of the canonical profile
      "capturedAt": "2026-07-30"                // optional ISO date
    }
  ]
}
```

### `GET /oauth-profiles/{clientId}`

Returns one profile, ready to compile with `deriveOAuthEmulation`.

```jsonc
{
  "schemaVersion": 1,
  "catalogRevision": "2026-08-04T00:00:00Z",
  "clientId": "example-desktop",
  "clientVersion": "1.2.3",
  "profileDigest": "9f2b…",
  "profile": {
    "profileVersion": 2,
    "authModel": {
      "status": "verified",
      "value": ["oauth2-dcr"],
      "source": "https://…",
      "capturedAt": "2026-07-30"
    }
    // … any HostConfigOAuthProfileV1 | V2
  }
}
```

`404` for an unknown `clientId`. `503` when the catalog is not seeded.

## Rules the SDK enforces on arrival

The SDK does not trust the envelope. `fetchOAuthProfile` rejects rather than
returning a profile when any of these fail:

1. **`schemaVersion` must equal the version this SDK understands.** A newer
   catalog is refused, not partially interpreted.
2. **The profile must canonicalize** through `canonicalizeOAuthProfile` — the
   same function the backend uses. A profile that would not survive
   canonicalization is a data bug, and half-enforcing it would silently
   emulate a different client.
3. **The digest must be *recomputed and match*.** The backend asserts
   `profileDigest`; the SDK computes it from the canonicalized profile and
   rejects on mismatch (`digest_mismatch`).

That third rule is not ceremony. The digest gates the golden-trace comparator's
binding check: a comparison is refused unless the golden's `profileDigest`
equals the run's. A wrong digest — from a backend bug, a cache, or a
man-in-the-middle — would let a capture of one client be diffed against a run
of another and reported as a confident match. Verifying locally means the
digest is only ever as trustworthy as the profile bytes it was computed from.

## Backend responsibilities

- Compute `profileDigest` as `sha256_hex(JSON.stringify(canonicalizeOAuthProfile(profile)))`,
  using the SDK's canonicalizer (`@mcpjam/sdk/host-config/internal`) rather
  than a hand-mirrored copy, so the digest agrees byte-for-byte.
- Keep `clientId` stable across catalog revisions; it is what a CI job pins.
- Bump `catalogRevision` on every publish. Runs record it, so a result can be
  traced back to the exact catalog that produced it.
- Store V1 rows as V1. The canonicalizer never rewrites them, and their
  digests must not change.
