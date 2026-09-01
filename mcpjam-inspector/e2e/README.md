# End-to-end tests (Playwright)

App-level Playwright smoke tests for the inspector. These are separate from the
vitest unit/integration suite (`npm test`) and from the widget browser-render
eval harness — this layer drives the real app in a browser.

## Run locally

```bash
npm run test:e2e -w @mcpjam/inspector
```

Playwright boots the inspector in production mode via its `webServer` config
(`npm run start -- --no-open` on `http://localhost:6274`), runs the specs, and
shuts the server down. The build artifacts must exist first — run
`npm run build -w @mcpjam/inspector` once if you have not built recently.

## Run against a deployed URL

Set `PLAYWRIGHT_BASE_URL` to skip the local server and drive a deployed target:

```bash
PLAYWRIGHT_BASE_URL=https://staging.mcpjam.com npm run test:e2e -w @mcpjam/inspector
```

## The WebMCP frame-stream spec

`webmcp-frame-stream.spec.ts` is the one spec here that does not drive the app
in a page. It opens a real in-app WebMCP session through the inspector's own
HTTP API, attaches to the binary frame WebSocket, and measures the live stream
— so it needs Playwright's Chromium present for the SERVER to launch (WebMCP
is a Chromium 151 feature; `npx playwright install chromium` provides it).

It is driven through the API rather than the UI because the `/webmcp` screen
sits behind a PostHog rollout flag a headless run cannot resolve. The pane's
own rendering and the client's transport ladder are covered by the store,
presenter and tab vitest suites instead.

It prints the numbers it measures, which is most of its value:

```
[frame-stream] capture→arrival over 33 frames: p50 14ms, p95 82ms
[frame-stream] resting: 24 frames, median gap 101ms
[frame-stream] driven: 53 frames, median gap 34ms
[frame-stream] settled: 19 frames, median gap 100ms
```

## Reports & artifacts

- HTML report: `mcpjam-inspector/playwright-report/index.html`
- Traces / screenshots / videos (retained on failure): `mcpjam-inspector/test-results/`

In CI these are uploaded as the `playwright-report` artifact when a run fails.
