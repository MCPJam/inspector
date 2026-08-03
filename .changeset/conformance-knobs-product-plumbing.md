---
"@mcpjam/inspector": minor
---

Carry the client-conformance knobs (`mcpProfile.paginationTraversal` /
`mcpProfile.mrtrSupport`) from the active host through every connection the
product opens — local and hosted, connect and the ephemeral managers that
chat, eval, prompt and journey runs build.

The knobs are only ever *carried*, never derived, and the failure mode of
missing one site is silent: a host configured as a degraded client would
execute as a fully conforming one on whichever flow got skipped. The four
hosted body builders now emit them through a single shared helper for that
reason, and the hosted route schema declares them (Zod strips what it does not
declare).

The host stays authoritative in BOTH directions via a new
`applyHostConformanceKnobs` overlay, the sibling of the existing mirroring
overlay: because these wire fields are suppression switches with no positive
state, a body pin must be REMOVED when the host wants the full behavior, not
merely left unmatched. Otherwise a share-link body could post
`firstPageOnly: true` / `supportsMrtr: false` and silently degrade a
conforming host — hiding tools from the model, or dropping MRTR rounds
mid-conversation.

Unlike the SEP-2243 mirroring knob beside them, both are forwarded on the
**stdio** branch too: pagination truncation is enforced on JSON-RPC frames and
the MRTR knob works through capability advertisement, so neither is a
Streamable HTTP concern.
