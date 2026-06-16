---
"@mcpjam/inspector": minor
"@mcpjam/cli": minor
---

New `mcpjam apps render` headlessly renders an MCP App tool result and returns a screenshot + render verdict, so agents and CI can see what a widget actually paints — not just its React state. It calls the tool, mounts the widget's UI resource in the eval browser harness (real headless Chromium running the production host bridge), and emits `{ status, observation, screenshotPath?, screenshotBase64? }`. The screenshot goes to a file by default (`--screenshot-out`); inline base64 is opt-in (`--screenshot-base64`) so stdout stays clean. Flags map to the harness: `--viewport <WxH>` and `--protocol <mcp-apps|openai-sdk>` (the OpenAI Apps SDK shim); `--require-render` makes a non-`rendered` verdict exit non-zero.

This is a local-Inspector capability (local dev + CI): the render path is served by a new `POST /api/mcp/widget-render` route under `/api/mcp/*`, which is disabled in hosted mode, so Chromium always comes from the local Inspector's Playwright install. When Chromium is missing the render reports `browser_unavailable` with an install hint rather than failing hard. The CLI stays thin — no Playwright dependency — because the harness runs server-side where local Chromium lives.
