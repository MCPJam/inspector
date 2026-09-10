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

## Checks

Final focused runs: **473 client tests passed**, **1,243 server/shared tests passed** (7 gated tests skipped), plus **7 built-server E2E tests passed**. Client typecheck and both import guards passed; design checks passed (zero design-lint errors).

- Shared surface/input, inspector isolation at 500 activity rows, store and both browser bodies: focused Vitest suites.
- Provider bridge, window/embedded modes, explicit screenshots, DPR 2, cross-origin frames, navigation/declarative results, hosted and Electron provider behavior: server regression suites, including real Chromium.
- Shared codec/input validation and daemon bundle freshness: focused suites.
- Production client/server builds and client typecheck/import guard.
- Built-server `e2e/webmcp-frame-stream.spec.ts`: seven passing tests, including HTTP/socket pixel markers, idle/input pacing, quiet-page behavior, DPR 2, slow-consumer recovery and socket authentication. Observed median periods on the final run: 100ms idle, 34ms during input, 100ms after settling. These tests do not exercise the actual product DOM.

The full server TypeScript check reports 296 diagnostics outside the changed files. No changed-file diagnostic remains; this is not a claim that the repository-wide server typecheck passes. Final PR check results take precedence over local runs here.

## Open release evidence

The physical trackpad/ten-minute run, actual Playground-versus-inspection UI timing, Windows/Linux Node check and packaged Electron smoke are not completed by these tests. Shared code and successful mocks are not proof that the reported visible lag is resolved. The PR should remain a draft until its intended release scope and these outstanding checks are reviewed.
