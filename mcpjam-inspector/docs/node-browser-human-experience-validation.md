# Node-local browser interaction validation

September 9, 2026. Implementation baseline: `48c28d1782`. Worktree branch: `fix/node-browser-human-interaction`.

## Deterministic before/after evidence

The viewport regression probe produced 30 additional activity-panel renders for 30 independent frame updates before the subscription change, both with zero and 500 activity rows. After the change, both the activity panel and tool sidebar render zero additional times while the viewport receives the final image. This establishes removed work; jsdom timings do not establish its share of physical scrolling latency.

A burst of 30 WebMCP JPEGs now publishes only the newest picture on the next animation frame. Stopping live view clears a queued picture. The local Playground decoder test delivers 100 JPEGs while decoding is blocked and starts only two decodes: the active first frame and the newest pending frame. Close and decode-failure tests verify cleanup and final-frame delivery. Hosted/Electron defaults and dependent H.264 decoding remain unchanged.

## Real Chrome, built Node package

Reference machine: Apple M4 Pro, arm64, macOS 15.6.1, Node 26.3.0. Production package served on localhost:6386; interaction fixture viewport 1280 × 800. The benchmark alternates five HTTP and five socket scrolls in the same browser session. A pixel marker changes on the resulting scroll event, while unrelated page animation continues.

| Measurement (milliseconds) | HTTP samples | Socket samples |
| --- | --- | --- |
| Input to dispatch response/ack | 21, 19, 18, 12, 20 | 16, 10, 9, 11, 16 |
| Input to marker-bearing JPEG arrival | 68, 49, 62, 56, 58 | 56, 60, 53, 57, 48 |

Median dispatch response/ack was 19 ms over HTTP and 11 ms over socket. Median marker-bearing frame arrival was 58 ms and 56 ms respectively. Five samples per path are too few for a useful tail-latency claim. This compares transports after the implementation, not total before/after application performance. Viewer decoding, React presentation, display refresh, and physical screen latency are excluded.

The frame-stream test measured capture-to-arrival p50 8 ms and p95 15 ms across 34 frames, with a 100 ms median idle frame interval. The existing interaction-rate test verifies the idle/active/settled boost without changing its constants. The benchmark JSON is saved as a Playwright test attachment on each run.

## Checks run

- Client regression suites: 365 tests passed across 20 files, including local, hosted, and Electron panes. A subsequent lifecycle test was added; the affected store/connection/stats suites passed all 103 tests, bringing unique client coverage in these runs to 366 tests.
- Server regression suites: 234 unique tests passed across six files. The initial broader run exposed a socket-close dispatch race; after adding a ready-state guard, all 37 WebMCP socket tests passed on rerun. The other 197 tests had passed in the broader run.
- Shared input validation/coalescing suites: 21 tests passed.
- Real-Chrome frame-stream E2E: seven tests, including pixel-matched input, frame pacing, sharp stills, device scale, slow consumers, and token refusal.
- Client typecheck, full package build, final client rebuild, design drift check, and design lint passed. Design lint reports existing warnings.
- The optional server-wide TypeScript check reports errors in unrelated files; none of its diagnostics reference files changed here. A clean baseline comparison of that check was not run. The package server build passed.

## Remaining release validation

Run physical trackpad momentum, nested scrolling, dragging, typing, text selection, and zoom checks in the full UI on supported hardware. Record display submission/visible-effect latency, React commit duration, CPU, memory, bandwidth, and queue depth through a ten-minute mixed session. Compare production and development builds, and repeat on Linux and Windows. The proposed 100 ms p95 visible-effect and 27 displayed-fps targets remain unverified.

No evidence from this run justifies a 60 fps profile, changing the existing boost window, or introducing a native encoding helper. If full-UI measurements still identify capture/encoding as the limit, investigate a cross-platform source feeding the existing video wire and decoder.

## TL review follow-up

The follow-up preserves binary frames after an input-ack timeout, restores the store-entry timestamp for the queue-inclusive `inputToPaint` headline, and adds `dispatchToPaint` for the post-queue proxy. Socket acknowledgements still measure post-queue dispatch completion. Input buffered before reaching the store is outside these diagnostics, and a next frame is still not proof of an input effect.

All transport/viewer input now shares the runtime's serial queue, with failure recovery and cancellation/session checks before dispatch. Dominant-axis wheel coalescing tolerates minor-axis jitter and preserves total distance. Missing registry sessions produce the intended refusal, socket dispatch refreshes activity, and modifier-free events retain their shape through the adapter.

Regenerated the daemon bundle and verified all four freshness checks; the executable `.mjs` bytes were unchanged, so only generated hash metadata changed. Follow-up regression runs passed 143 unique client tests, 107 unique server tests (including runtime ordering, socket lifecycle, relay forwarding, and freshness), and 22 shared tests. Client typechecking and the server build passed. The seven real-Chrome E2Es were rerun against the updated server. Original benchmark samples above remain historical measurements, not new performance claims.

Per-batch waiting is deliberately retained. The socket removes HTTP overhead; it does not remove dispatch completion waits or promise a larger in-flight window. Physical trackpad and long-session release checks remain outstanding.
