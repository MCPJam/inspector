# Improve human interaction in the Node package's browsers

Status: initial implementation complete for draft review, September 9, 2026, in `fix/node-browser-human-interaction`. Paths below are relative to `mcpjam-inspector/`. See the [validation report](./node-browser-human-experience-validation.md) for measured results and remaining release checks.

## Delivered in this change

- Baseline regression probes and a real-Chrome scroll marker benchmark, with separate input acknowledgement measurements.
- Viewport-only frame subscriptions, no redundant successful-command store updates, and newest-frame presentation once per animation frame for Node-local WebMCP.
- One active JPEG decode and one replaceable pending JPEG for the Node-local Playground pane.
- Negotiated WebMCP socket input using the existing server forwarder, shared HTTP/socket validation, gesture boundary preservation, ordered HTTP fallback, and no replay of uncertain input.
- Verification of the existing interaction boost; no pacing constants changed. Electron and hosted policies retain their defaults.

The sections below retain the broader performance goals. The physical-input, ten-minute resource, cross-platform, and full display-latency benchmarks remain release follow-ups, not completed claims. This draft packages the baseline and implementation together; it does not establish which component dominates real-world latency or claim the proposed display targets are met.

## Outcome and scope

Make scrolling, typing, clicking, and dragging in the local Node package's browser panes feel responsive and remain responsive during long sessions. Prioritize the WebMCP inspector shown in the reported issue; cover the local Playground browser next.

Electron and hosted/Railway behavior are outside the change scope. Select any new performance policy explicitly for Node-local sessions. Keep existing defaults for other callers of shared modules, and run their regression checks when shared code changes.

Keep the existing Chrome and JPEG streaming architecture for the first implementation. The repository already has the browserd H.264 encoder, video wire records, pacer, client decoder, and tier controller. Its current encode source captures an X display through FFmpeg and does not support headless Node-local Chromium on macOS/Windows. If capture/encoding remains the limiting factor, investigate a cross-platform encode source that reuses this infrastructure; do not treat it as a codec design from scratch.

## What the code establishes

| Area | Current behavior | Implication |
| --- | --- | --- |
| WebMCP workspace | The tab subscribed to the complete store, including every live frame; successful commands wrote an empty error even when it was already empty. | Fix subscription boundaries before adding protocol work. |
| WebMCP input | `webmcp-inspector-store.ts` serializes input commands and waits for each batch to finish. The provider awaits Playwright input operations. | The input path can add waiting even on localhost. |
| WebMCP frames | Binary WebSocket with SSE/poll fallbacks; JPEGs displayed through blob URLs on an image element. | Binary delivery already exists; changing transport alone will not remove capture or display costs. |
| Frame pacing | WebMCP publishes at up to 10 fps normally and roughly 30 fps during input. The local daemon viewport also has a 100 ms default floor and supports a boost. | Audit the complete pacing chain before changing a single constant. |
| Local Playground | Already supports WebSocket input, binary JPEG decoding, and latency diagnostics. Server forwarding still bounds and serializes dispatch. | Reuse the established protocol patterns; do not build a second socket input mechanism here. |
| Frame decoding | The shared binary reader starts a decode for each JPEG and rejects older completed frames by sequence. | Ordering is protected, but work can accumulate before completion under pressure. |
| Reference project | `../agent-browser` also uses CDP JPEG screencasting. Its stream defaults to uncapped delivery and dispatches input without awaiting each Chrome reply. | Useful comparison for pacing and input; not evidence that rewriting in Rust or switching codecs is necessary. |

These were findings at the implementation baseline. A regression probe subsequently confirmed 30 activity-panel renders for 30 independent frame updates, with both zero and 500 activity rows. That establishes redundant work, not its share of real-world scrolling latency. There is no evidence yet that the user's symptoms worsen over a session. Existing input-to-next-frame statistics are useful indicators but do not prove that a frame contains the result of that input.

## 1. Establish a reproducible baseline

Extend the existing frame statistics and `e2e/webmcp-frame-stream.spec.ts` fixture rather than introducing a separate diagnostics system.

- Exercise both local panes using the same viewport, Chrome build, page, and sequence of inputs. Run the built Node package as well as the Vite development setup to distinguish product costs from development overhead.
- Use a controlled page with a long document, a nested scrolling region, a draggable object, and a text field. Render a gesture marker and scroll position into the page so benchmark frames can be matched to actual input effects. Include a page with ongoing animation to catch misleading input-to-next-frame measurements.
- Measure React commit costs with empty and full activity rails. Count panel renders separately from viewport renders; selectors on a parent that still subscribes to `liveFrame` are insufficient.
- Record input receipt, queue wait, browser dispatch duration, input acknowledgement, frame capture/publication, arrival, decode, and presentation submission where available. Separate durations measured on each process's monotonic clock; do not subtract unrelated clocks. Treat image load/canvas draw as presentation proxies, not proof of physical screen scanout.
- Report p50/p95 interaction latency, displayed frame intervals, received versus displayed fps, dropped frames, queue depth, bytes per second, CPU, and memory. Record machine, OS, viewport, device scale, refresh rate, and transport/fallback used.
- Run five repeatable scroll trials, including trackpad momentum and mouse-wheel input, then a ten-minute mixed interaction session. Compare with `agent-browser` on the same machine as a reference, not as a required dependency or release gate.

Proposed acceptance targets on a documented reference machine and the controlled page: p95 input-to-visible-effect at or below 100 ms; at least 27 displayed fps during sustained scrolling in the 30 fps profile; p95 displayed-frame gap below 75 ms; no growing input or decode queues. Confirm target feasibility in this first step and document any adjustment before implementation. Do not generalize fixture performance to every website or device.

Deliverable: a baseline report identifying whether the largest cost is input waiting, capture, pacing, decoding, or React/display work.

## 2. Bound rendering work and fix measured presentation costs

- Bound the local Playground binary JPEG reader (whose current code starts one decode per incoming record): one active decode and one replaceable pending frame. Release every discarded bitmap and cancel safely on session replacement.
- Move the live-frame and screenshot subscriptions into the viewport component. Narrow workspace subscriptions, read diagnostic frame data only when requested, and avoid redundant empty-error updates. Add render-count regression tests with zero and 500 activity rows. Memoize additional panels only if they still do unnecessary work.
- Benchmark WebMCP's image presenter against a bitmap/canvas presenter. Adopt the latter only if it materially improves the measured result. Preserve letterboxing, resize behavior, Retina scaling, and pointer alignment; reuse existing geometry helpers rather than inventing new coordinate math.
- Coalesce WebMCP binary JPEGs before store publication and blob allocation, at most once per display animation frame. Draw the newest available frame and let intermediate frames be replaced. Do not move old images to simulate scrolling: the shown page must match the controlled browser.

Primary files: `client/src/lib/webmcp-inspector/frame-presenter.ts`, `client/src/components/webmcp-inspector/WebmcpInspectorTab.tsx`, `client/src/lib/browser-pane/frame-wire.ts`, and `client/src/components/browser/LocalBrowserBody.tsx`.

The server pacer observes socket write completion, not viewer presentation. Client coalescing reduces work but cannot erase bytes already queued upstream. If stale-frame age remains high, consider negotiated viewer feedback/credits. Never apply JPEG newest-wins dropping to dependent H.264 frames.

Deliverable: bounded decoding/memory and responsive inspector controls during continuous scrolling. Keep shared hosted consumers on their existing behavior unless separately authorized.

## 3. Remove avoidable input waiting in WebMCP

Add capability-negotiated input to the existing WebMCP frame socket, following the local Playground's socket-input pattern.

- Reuse `browser-pane-input-forwarder.ts` through a WebMCP-to-browser-pane vocabulary adapter. Share input validation between HTTP and WebSocket. Preserve modifier and wheel reversal boundaries without creating a third coalescer.
- Update the frame route's read-only comment, ping-only wire contract, and tests together: negotiated input makes it a write path using the same authority as the existing command route.
- Send input with sequence IDs and explicit success/refusal acknowledgements. Keep navigation, tool calls, and lifecycle operations on their existing command interfaces.
- Send each input batch over the existing socket and continue awaiting its acknowledgement. This removes HTTP overhead, not per-batch browser-dispatch waiting. Retain client ordering across HTTP fallback and socket batches; do not claim this eliminates browser dispatch time or every acknowledgement round trip. Keep bounded server dispatch and error reporting; a socket alone does not make browser dispatch faster.
- Coalesce consecutive pointer moves and compatible wheel events while busy. Preserve wheel distance, direction-sensitive behavior, modifier boundaries, and key/button press-release order. Never silently drop releases.
- Profile awaited Playwright dispatch separately. If it is a material bottleneck, prototype ordered direct CDP input for the Node-local provider, with bounded outstanding commands and handled errors. Do not copy unrestricted fire-and-forget dispatch from the reference project.
- Bind queued input to the original session/generation. Stop accepting and cancel pending input on close, reconnect, or session replacement. Preserve all existing authentication, origin, consent, and ownership checks applicable to each surface.
- Use ordered HTTP input when a server does not advertise socket input. Do not automatically replay unacknowledged input after disconnection: it may already have executed.

Input acknowledgements extend the existing WebMCP stats report with input-to-ack. Distinguish dispatch completion from the first frame actually containing the resulting scroll.

Primary files: `server/routes/web/webmcp-frames.ts`, `client/src/lib/webmcp-inspector/frame-stream-connection.ts`, `client/src/stores/webmcp-inspector-store.ts`, `client/src/lib/webmcp-inspector/input-forwarder.ts`, and `server/services/webmcp-inspector/playwright-provider.ts`.

Deliverable: lower input waiting with unchanged click, drag, modifier, and keyboard semantics. Apply additional dispatch changes to the local Playground only if its baseline shows the same bottleneck.

## 4. Tune frame delivery for active local interaction

Audit the existing Node-local interaction policy first; change it only when the remaining measurements justify it. Audit capture, publication, socket pacing, and viewer presentation together so a downstream limiter cannot silently override it.

- Retain the existing approximately 30 fps interaction ceiling for this change. Defer the 60 fps experiment. An interval setting is a ceiling, not a guarantee of delivered fps.
- Verify the existing boosts: WebMCP boosts before dispatch; browserd already boosts on human input. Every wheel extends the 1.5-second window, covering momentum that emits wheels. Keep low idle work and stop streaming when hidden, as the current lifecycle permits.
- Retain only the newest waiting frame under pressure and always deliver the final frame of a gesture. Preserve immediate CDP frame acknowledgement, duplicate suppression, byte budgets, and the sharp still after the page settles.
- Tune quality and capture size only when measurements show byte or encoding pressure. Preserve readable text and the existing device-scale and pointer-coordinate contract.
- Keep quality adaptation and frame pacing from repeatedly changing in response to their own intentional drops. Distinguish scheduled frame skipping from congestion.

Primary files: `server/services/webmcp-inspector/frame-throttle.ts`, `playwright-provider.ts`, `server/services/browserd/daemon/viewport.ts`, and the WebMCP/local-browser frame routes. Pass local policy through options rather than changing shared hosted defaults.

Investigate the first scroll after an idle pause, when a settle capture may already be in flight. Measure displayed fps only while the page is changing, since duplicate suppression intentionally lowers idle fps.

Deliverable: consistent scrolling at the selected frame rate without a stale final image or sustained idle CPU increase.

## Validation and delivery

Ship as four reviewable changes: baseline instrumentation/benchmark, client subscription/presentation fixes, WebMCP socket input, then only pacing changes justified by the remaining measurements. Rerun the same benchmark after each to attribute gains and stop pursuing an optimization that adds complexity without benefit.

Tests must cover input ordering and refusal, accumulated wheel distance, modifier changes, final-frame delivery, slow decode, disconnect during a drag, session replacement, hidden/restored panes, and compatibility with servers lacking socket input. Include coordinate checks at multiple viewport sizes and device scales, nested scrolling, typing, text selection, and zoom behavior. Run relevant existing WebMCP and local-browser suites; when shared code is touched, also run hosted and Electron regression suites. The implementation must record which of these checks ran and which still require another platform or physical input device.

Keep noisy timing benchmarks out of ordinary unit-test gates. Use deterministic tests for ordering and resource bounds, with repeatable performance runs on the reference machine. Verify the built Node package on macOS, Linux, and Windows before release, using manual trackpad checks on supported hardware.

Record before/after latency, frame gaps, CPU, memory, and bandwidth with each change. Roll back a local policy if it improves fps while worsening p95 interaction latency or causes sustained resource growth. Preserve capability fallbacks so older client/server combinations still work. Any temporary rollout override belongs in developer configuration, not a new user-facing codec/settings workflow.

Completion means the local panes meet the agreed reference targets, pass interaction and lifecycle checks, and retain stable resources through the mixed interaction run. If capture/encoding still prevents those targets, produce a separate measured proposal for a new capture/encode source or native helper feeding the existing video infrastructure, including cross-platform packaging costs. Do not expand this work into an Electron or Railway redesign.
