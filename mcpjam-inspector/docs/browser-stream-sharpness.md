# Browser stream sharpness

Interactive JPEG streams start at quality 85. New viewers request `sharp=1`; a hosted relay forwards it only when browserd advertises `sharp-stream-v1`. The negotiated JPEG ceiling is 2 MiB. Unnegotiated connections keep the 256 KiB ceiling, including JSON fallback. The binary header and browser tool APIs are unchanged.

A tab has one capture stream. Its effective size ceiling is the smallest limit requested by its current subscribers. Frames queued before a legacy subscriber arrives are also checked at delivery. Oversized frames lower quality through 85, 75, 65, 55, and 40. A fitting frame starts a timed upward probe after 10 seconds, including on static pages. Failed probes back off to 20, 40, then 60 seconds; successful probes reset the delay. Main-frame navigation and viewport changes reset quality. An image that still cannot fit at quality 40 reports `jpeg_frame_limit` in stream diagnostics instead of restarting forever.

JPEG congestion is handled separately for each viewer. Three bad one-second samples reduce delivery frequency; five healthy samples restore it. Quiet pages do not count as congestion. The relay retains only the newest pending JPEG and flushes it after the socket drains, even if no further page paint occurs. Closing the connection clears its pending frame and timer. Image quality is never reduced because a particular viewer has a slow connection.

Negotiated H.264 uses full capture resolution in Auto (20 FPS, CRF 20), Sharp (30 FPS, CRF 18), and Saver (10 FPS, CRF 23). Keyframe spacing remains approximately four seconds. An unnegotiated video subscriber retains the legacy encoder presets while present. JPEG viewers do not send automatic video-quality adjustments. Existing explicit video preferences and video-to-JPEG fallback remain available.

The shared pane centers frames, scales them down to fit, and never enlarges smaller captures. The stats overlay shows encoded and displayed dimensions, effective/requested JPEG quality, delivery rate, and adjustment reason. Native Electron rendering, VNC, tool screenshots, and native Retina capture are unchanged.

## Validation

A local Chromium comparison against base commit `019ea35bd3` used deterministic text, high-entropy grayscale images, and a changing marker at 620 × 1160, 1280 × 800, and 2560 × 1600. The benchmark stores JPEGs, reference PNGs, and JSON measurements outside the repository.

| Scenario | Base | New stream |
| --- | --- | --- |
| Text, 620 × 1160 | 241,491-byte JPEG; PSNR 32.66 dB | 290,331 bytes; PSNR 36.89 dB |
| Text, 1280 × 800 | 196,272 bytes; PSNR 35.21 dB | 235,798 bytes; PSNR 39.44 dB |
| Text, 2560 × 1600 | Both initial capture and quality-40 retry dropped; no frame within 8 seconds | Full-size quality-85 frame, 495,070 bytes |
| High-entropy image, 2560 × 1600 | No frame within 8 seconds | Full-size quality-65 frame, 1,968,017 bytes |
| CDP input → JPEG decode/draw, 620 × 1160, p95 | 37.91 ms | 37.11 ms |
| CDP input → JPEG decode/draw, 1280 × 800, p95 | 34.66 ms | 38.05 ms |

Higher PSNR means less distortion relative to the matching PNG. Motion samples are excluded from PSNR because their pixels intentionally change. Each latency result has 20 samples on the same local machine; it covers Chromium input, capture, and rendering in a separate viewer context. It does not measure hosted network latency or the application's authorization/input relay.

Real-browser tests also cover the actual pane component's no-enlargement behavior, downscaling, and pointer mapping at display DPR 1 and 2. Unit/integration tests cover recovery, size negotiation, legacy compatibility, final-frame retention, subscriber changes, and video presets. Live hosted H.264 and native Electron were not exercised on this machine; hosted encoder argument and lifecycle tests run with a fake ffmpeg process.

The client type check passes. The repository-wide server type check has existing failures; its normalized diagnostics match an untouched checkout of the base commit. Design synchronization, design lint (existing warnings only), and the browser-viewer dependency check pass.

## Reproducing the comparison

From the inspector package, using the installed workspace tools:

```sh
../node_modules/.bin/tsx --tsconfig server/tsconfig.json scripts/benchmark-browser-sharpness.ts /path/to/base-checkout /tmp/browser-sharpness-results
PLAYWRIGHT_BASE_URL=http://pane.test node node_modules/@playwright/test/cli.js test e2e/browser-pane-input.spec.ts --workers=1
```

The second command intercepts its fixture URL locally and does not require a running application server. Regenerate the checked-in daemon with `npm run bundle:browserd` after editing capture or encoder code. Deployment follows the existing bundle-hash replacement mechanism; mixed-version peers retain their negotiated legacy limits and presets.
