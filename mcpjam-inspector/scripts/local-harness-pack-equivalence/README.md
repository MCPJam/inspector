# Pack equivalence records

One immutable JSON file per (harness, inputs fingerprint), written ONLY by
`.github/workflows/local-harness-pack-pipeline.yml` and attested there
(`actions/attest-build-provenance`) before its PR is opened. Do not edit or
hand-write one: the release gate runs `gh attestation verify` on the file as
committed, so any byte changed makes it worthless.

A record says: a clean rebuild of `<harness>`'s pack from inputs
`fingerprint` reproduced the pinned `packVersion` tree digest on every target.
That happens when a pack input changes without changing any pack byte — a
workflow edit, a script refactor. Publishing would make every user download an
identical tree under a new version, so the pipeline records this instead, and
`check-local-harness-release.mjs` accepts the pinned pack for the new
fingerprint on the strength of it.

This directory is not a pack input: recording an equivalence never moves the
fingerprint it records.
