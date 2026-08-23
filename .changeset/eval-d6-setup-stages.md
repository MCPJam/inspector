---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

The eval user-value chain can now measure its top two stages: `connection` and `discovery`.

Connect and tools-list happen once per run, above the iteration boundary where no span sink exists. Hosted runs now record a structured `setupSignals` evidence field (precedent: `toolSignals`), fold every configured target behind a `Promise.allSettled` barrier so no verdict is decided while another server is still settling, and persist synthetic `connection` / `discovery` spans for the timeline only — they never enter derivation evidence. Both phases are observed from the one `getToolsForAiSdk` call a run already makes, so no server is dialled twice.

`connection: failed` requires positive evidence our own egress works (a lazy `GET ${convexHttpUrl}/health` canary, only on a theirs-shaped failure). Without that, the row stays `notMeasured` / `egressUnverified` or `setupAborted`. A completed initialize is itself the egress evidence for `discovery`. `failureCategory` stays `setup`; rates that want measured failures filter on `firstFailedStage`.

The SDK path is types-only: a user-code `beforeAll` connect failure never reaches ingestion, so there is nothing to emit. Analyzer version is now 2. `noSpanChannel` stays in the vocabulary for old producers; v2 emits `noEvidenceCaptured` instead.

A run-level connect failure no longer strands the run: pending iterations are written with the folded signals, re-read, retried once if still pending, and only then swept.

Requires the mcpjam-backend D6 vocabulary widening (connection/discovery span categories + `connectFailed` / `toolsListFailed` / `egressUnverified`) to be **merged and promoted to production** before this inspector ships. Rollback order is inspector first, backend second.
