# Browser viewer unification validation

This PR shares the Node inspection viewer, capture, input dispatch and gesture policies. The [plan](browser-viewer-unification-plan.md) distinguishes this implementation from the remaining stream-lifecycle, diagnostics and Electron migrations.

## Capture comparison

Apple M4 Pro, macOS, Node 26.3.0, Chromium 151.0.7922.34. Five gestures per case. Baseline was recorded in this worktree before replacing the inspection capture/input implementation. The candidate retains the baseline's explicit DPR/viewport presets to isolate the driver change; it does **not** measure the candidate UI's new pane-sized DPR 1 default.

The changing fixture encodes the gesture count into pixels. Arrival means the capture callback received a frame containing the corresponding marker. It excludes socket transport, frontend decoding, canvas drawing and physical scanout. “Historical defaults” uses WebMCP 1280×800/DPR 2 and a representative Playground pane of 600×700/DPR 1. Matched uses 1280×800/DPR 1 for both. This is a capture-level diagnostic, not the plan's full as-shipped UI benchmark.

| Case                           | Dispatch median before (ms) | Dispatch median after (ms) | Marker arrival median before (ms) | Marker arrival median after (ms) |
| ------------------------------ | --------------------------- | -------------------------- | --------------------------------- | -------------------------------- |
| webmcp historical defaults     | 18                          | 14                         | 57                                | 54                               |
| playground historical defaults | 14                          | 16                         | 51                                | 49                               |
| webmcp matched                 | 14                          | 11                         | 64                                | 61                               |
| playground matched             | 15                          | 13                         | 57                                | 52                               |

The small samples show lower inspection dispatch medians; marker arrival differences are mixed. They do not establish a visible scrolling improvement or identify a single dominant cost. [Raw samples](browser-viewer-unification-samples.json) are retained for review.

Reproduce the capture comparison with `RUN_BROWSER_PIPELINE_BENCHMARK=1 BROWSER_PIPELINE_REPORT=/tmp/browser-pipeline.json npx vitest run --project server server/services/webmcp-inspector/__tests__/browser-pipeline-benchmark.test.ts`.

## Candidate geometry follow-up (TL review)

A fresh baseline run uses the original provider at `ca99d5ed1b`. The candidate runs both the historical preset and the new default geometry, with **30 gestures per case** on the same Apple M4 Pro / Chromium 151 environment. The candidate calls the real `resizeViewport(600, 700)` path; it is not a raw viewport substitute. The harness defaults to 30 samples and now includes a named `candidate` preset. The baseline runs historical/matched presets because that provider has no pane resize API.

| WebMCP configuration                  | Dispatch median (ms) | Marker arrival median (ms) |
| ------------------------------------- | -------------------: | -------------------------: |
| Original provider, 1280×800 / DPR 2   |                   12 |                         66 |
| Shared provider, 1280×800 / DPR 2     |                   12 |                       58.5 |
| Shared provider, pane 600×700 / DPR 1 |                   12 |                         64 |

At the new defaults, arrival is **66 → 64 ms** compared with the fresh original-provider baseline. Holding the candidate driver constant, changing geometry gives **58.5 → 64 ms**, not a latency improvement. Cases were sequential, not randomized; scheduler/compositor phase can dominate differences this small. The fixture is deliberately cheap to raster. This run closes the missing candidate-preset measurement, but **does not establish a visible scrolling improvement** or quantify the savings on a complex page. Raw baseline and candidate records are in `reviewGeometryComparison` in the samples artifact.

The product decision remains pane-sized DPR 1, quality 75: fewer raster pixels and consistent behavior with Playground, with less Retina sharpness than the old DPR 2 / sharp-at-rest view. The shared capture path now retries an oversized picture once at quality 40, serialized with resize. It does not oscillate or retry indefinitely; a picture still above the cap at quality 40 remains dropped. A shared settle-still enhancement is a follow-up, not silently retained inspection-only policy.

## Checks

Initial implementation runs: **473 client tests passed**, **1,243 server/shared tests passed** (7 gated tests skipped), plus **7 built-server E2E tests passed**. Client typecheck and both import guards passed; design checks passed (zero design-lint errors).

- Shared surface/input, inspector isolation at 500 activity rows, store and both browser bodies: focused Vitest suites.
- Provider bridge, window/embedded modes, explicit screenshots, DPR 2, cross-origin frames, navigation/declarative results, hosted and Electron provider behavior: server regression suites, including real Chromium.
- Shared codec/input validation and daemon bundle freshness: focused suites.
- Production client/server builds and client typecheck/import guard.
- Built-server `e2e/webmcp-frame-stream.spec.ts`: seven passing tests, including HTTP/socket pixel markers, idle/input pacing, quiet-page behavior, DPR 2, slow-consumer recovery and socket authentication. Observed median periods on the final run: 100ms idle, 34ms during input, 100ms after settling. These tests do not exercise the actual product DOM.

The full server TypeScript check reports 296 diagnostics outside the changed files. No changed-file diagnostic remains; this is not a claim that the repository-wide server typecheck passes. Final PR check results take precedence over local runs here.

## Open release evidence

The physical trackpad/ten-minute run, actual Playground-versus-inspection UI timing, Windows/Linux Node check and packaged Electron smoke are not completed by these tests. Shared code and successful mocks are not proof that the reported visible lag is resolved. The PR is ready for review of the Node viewing/capture/input scope. The unresolved visible-lag and platform evidence remains explicit; ready-for-review does not mean those release checks have passed.

## Review fixes and regression scope

- Mouse compatibility events carry real double/triple-click counts; pointer events retain capture and focus. `e2e/browser-pane-input.spec.ts` bundles the actual shared React surface, drives Chromium clicks, and replays its output into a real page to verify `dblclick`. It also checks a modifier released before the letter.
- Held shortcuts use physical `code` identity and release the original `key`, including Option-modified letters. Blur releases every held input. Paste remains host-delivered text.
- Inspection and BrowserShell share one normalized, debounced viewport reporter using `browser-viewport.ts` bounds. Obsolete measurements and retired generations are cancelled.
- JPEG drawing/measurement happens on animation frame after decode again; retired images cannot report a paint. Decode duration excludes animation-frame wait.
- Playground now uses actual keyup timing, pointer capture past the pane edge, non-passive wheel prevention, blur release, focus on pointerdown and bounded newest-pending JPEG decoding (including hosted viewing from Electron). These are intentional shared behavior changes, not only inspection changes. Native Electron drawing remains separate.
- Focus visibility is restored, per-push coalescing only examines the queue tail, the daemon bundle warning is retained, and a patch changeset names the Retina quality trade.

Review follow-up: **340 client tests passed**, **1,131 server tests passed** (7 gated cases skipped, including daemon bundle freshness), and **8 real-browser/built-server E2E tests passed**. Client typecheck, both import guards and design checks passed. The cross-origin discovery test now waits for the subframe tool it asserts rather than only the main-frame tool count. Production client and server builds passed. Hosted and Electron-viewing-hosted manual sessions were not exercised; local component tests and Chromium input tests do not substitute for those platform checks.

## Automated review triage

All five findings were verified against the current code and fixed: viewport resize drains previously queued socket input before joining the runtime tail; pending resize work owns screencast startup even when a viewer subscribes mid-apply; resize failures during session/page teardown are no-ops while live failures remain errors; canonical input validation enforces the 4,096-character text limit; and image presentation avoids resetting unchanged canvas dimensions.

Follow-up validation: 192 server/shared tests and 49 client tests passed, including queued-input ordering, subscription during multiple resizes, disposal during apply, closed/live provider failures, route teardown behavior, text-limit boundaries and daemon bundle freshness. Client typecheck/import guards and the production server build passed.
