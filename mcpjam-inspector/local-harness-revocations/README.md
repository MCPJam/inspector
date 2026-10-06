# Revoked local-harness runtime packs

`revocations.json` names pack tree digests no Inspector may select again — not
as its desired pack, and not as a fallback (invariant 4 in
`server/utils/harness/local/README.md`). `revocations.json.sig` is its Ed25519
signature by the pack signing key, produced ONLY by
`.github/workflows/local-harness-revocations.yml` in the protected
`local-harness-pack-release` environment.

Inspectors fetch both from `main` (raw.githubusercontent.com, or
`MCPJAM_LOCAL_HARNESS_REVOCATIONS_URL`), accept a list only if the signature
verifies and its `sequence` is not lower than the one they cached, and cache
it for offline use (`runtime-revocation.ts`).

To revoke a pack, dispatch the workflow:

    gh workflow run local-harness-revocations.yml --ref main \
      -f harness=codex -f tree_digest=sha256:… -f reason="crashes on start"

It appends the entry, bumps `sequence`, signs, attests, and opens the
`bot/local-harness-pack-revocations` PR. Merging that PR is what revokes it.
Never hand-edit the signature; an edit to the list on `main` is re-signed by
the same workflow.
