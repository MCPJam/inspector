# WebMCP sandbox relay browser tests

This manual end-to-end suite exercises the sandbox relay with legacy App Tools,
direct WebMCP registrations and the pinned upstream v3 wrapper. It is not a
Vitest CI target. The product renderer enables the relay separately.

The suite uses the actual sandbox proxy and AppBridge across write, srcdoc and
opaque mounts. It checks native WebMCP on and off, frame isolation, cancellation,
remounts, bounded results, CSP and a pinned legacy baseline. The packaged run
fetches the proxy from the packaged app's embedded server and exercises it in
that app's browser with an isolated temporary profile.

Run from the repository root using the Node version in
`mcpjam-inspector/.nvmrc`, after `npm install --legacy-peer-deps`.
Set `MCPJAM_EXT_APPS_FIXTURE_REPO` to an ext-apps checkout containing commit
`efcc19c377770f64d4844485bb2be73a6c4b813c`. The suite extracts that commit into a
temporary directory and leaves the checkout unchanged.

```sh
MCPJAM_EXT_APPS_FIXTURE_REPO=/path/to/ext-apps MCPJAM_SPIKE_ELECTRON=1 node --import tsx mcpjam-inspector/server/routes/apps/mcp-apps/__tests__/webmcp-browser.e2e.mjs
npm run build:client -w @mcpjam/inspector
npm run electron:package -w @mcpjam/inspector
MCPJAM_EXT_APPS_FIXTURE_REPO=/path/to/ext-apps MCPJAM_SPIKE_RUNTIME=electron MCPJAM_SPIKE_PACKAGED_APP="mcpjam-inspector/out/MCPJam Inspector-darwin-arm64/MCPJam Inspector.app/Contents/MacOS/mcpjam-inspector" node --import tsx mcpjam-inspector/server/routes/apps/mcp-apps/__tests__/webmcp-browser.e2e.mjs
```

Use the corresponding executable for other platforms. Results are written to
`mcpjam-inspector/.playwright/` with the upstream and baseline commit IDs.
The baseline is the proxy at `4dbef72d18e15e24316b090e853ec1123d7be53f`, so
rerunning the suite after a commit still compares against the same original.
