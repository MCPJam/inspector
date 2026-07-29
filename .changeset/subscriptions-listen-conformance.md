---
"@mcpjam/sdk": minor
---

Wire the three `subscriptions/listen` conformance checks for real.

`modern-subscription-ack-precedes-notifications`, `modern-subscription-filter-and-tagging` and `modern-subscription-graceful-close` were authored as explicit skips pending the subscription surface. They now observe one live listen stream per run and judge it:

- New `observeListenStream` primitive (`sdk/src/mcp-conformance/raw-listen.ts`): reads an SSE listen body INCREMENTALLY, frame by frame, and stops on the first of completion result / stream end / idle window / deadline. The existing raw capture buffers a whole response and so cannot hold a subscription open. The three facts under test — frame ORDER, the `_meta` subscription-id tag, and the completion result — are all normalized away before app code sees them, so only the wire can prove them.
- The probe requests exactly what the server advertises (`tools`/`prompts`/`resources` `listChanged`, `resources.subscribe`), then asserts: the acknowledgement precedes every notification; every message carries the subscription id and no notification falls outside the requested filter; a stream that ends does so with the `subscriptions/listen` completion result.
- Safety is asymmetric by design: nothing subscribable advertised, a refused stream, an unreadable body, or a subscription still open at the end of the observation window are SKIPS with a reason, never failures. A graceful close is server-initiated and cannot be induced by a client-side probe.

The three checks stay modern-only in `CHECK_ERAS`; legacy runs (absent pin and a 2025-era pin) keep their existing statuses.
