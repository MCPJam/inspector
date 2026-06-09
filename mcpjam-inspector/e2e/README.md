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

## Reports & artifacts

- HTML report: `mcpjam-inspector/playwright-report/index.html`
- Traces / screenshots / videos (retained on failure): `mcpjam-inspector/test-results/`

In CI these are uploaded as the `playwright-report` artifact when a run fails.
