---
"@mcpjam/inspector": patch
---

The judge second pass reads the model-layer classification instead of guessing it

`stepError` is transient runner state — an input to the first derivation, never persisted — so the judge second pass re-derived from strictly less evidence than the first, and dropped `providerError` and the `setup` category the moment a verdict landed. UVH-IN2 patched that by recovering the classification from the stored chain, on the stated grounds that the chain "already says it: `providerError` is written if and only if the model layer was classified as the failure".

**That premise was false.** `categoryFor` returns `setup` for a model-call failure where *nothing* failed — "there was nothing to fail against" — and on that shape `applyProviderError` relabels no row at all. The witness was empty exactly when the fact was true, so the category vanished on the second pass with no missing row to point at.

The classification is now written beside the chain that produced it, as a single `stageStepErrorSource` key, and read back directly. The chain scan stays as a fallback for iterations finalized before the marker shipped — it was always a faithful witness where it fired, only an incomplete one. `code` and `httpStatus` are still not recovered by either route: they are diagnostics, were never part of the classification, and persisting them would invite a reader to treat them as evidence.

No contract or vocabulary change, and no backend change: iteration metadata is an open bag, and `REPORTED_STAGE_KEYS` gates only claim detection and quarantine stripping, not what may be stored.

Mutation-checked on both halves, which took two passes. Removing the read fails the test that names it immediately; removing the *write* originally failed nothing, because the read-side tests hand the reader a metadata bag directly and pass whether or not anything ever writes one. `buildStageMetadata` is now asserted at the seam as well.
