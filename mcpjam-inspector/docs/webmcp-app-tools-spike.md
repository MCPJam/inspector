# WebMCP app-view S0 evidence

**Decision: proceed with the planned host integration.** The relay-level S0 matrix passed. The production Chat/Playground integration and per-client settings are subsequent phases; their QA remains Not run.

Task: [KES-709](https://app.kestral.ai/workspace/yhNILB2/task/1SmJFYy7). [Agreed plan and QA matrix](./webmcp-app-tools-plan.md). [Per-case machine-readable evidence](./qa/webmcp-app-tools-s0-results.json).

## Scope and results

The harness uses the actual sandbox proxy, the current AppBridge and shared request helpers. The packaged run fetches its proxy HTML from the embedded server of the built application, then exercises that HTML in the packaged Electron browser. It uses an isolated temporary profile and the browser debugging interface because the release disables Node inspection.

| Runtime | Passed | Failed |
|---|---:|---:|
| chromium-153.0.8010.12-native-false | 40 | 0 |
| chromium-153.0.8010.12-native-true | 40 | 0 |
| electron-native-true | 40 | 0 |
| packaged-electron-chromium-150.0.7871.250 | 40 | 0 |

Total: **160 browser scenarios passed**. Node 24.22.1; Electron 43.6.0. Baseline commit: `4dbef72d18e15e24316b090e853ec1123d7be53f`. Upstream fixture pin: `efcc19c377770f64d4844485bb2be73a6c4b813c`. Packaged `app.asar` SHA-256: `cc0e325f4d6de563b4ebe1d9fed2dddc8c8ffac11d13595e643f42057cebf891`.

Each runtime covers all three mount modes, legacy tools, direct WebMCP, the actual upstream v3 wrapper with and without a leftover tools capability, disabled and absent opt-in, permissive/restrictive CSP and remounts. Additional cases prove two-app out-of-order routing, independent cleanup, cancellation observed by the view, oversized/cyclic results, empty-registry recovery, rejected sibling replies, opaque self-navigation and a real ten-second listing timeout.

The negative listing case deliberately alters builtins inside the untrusted view to produce a malformed or uncloneable reply. The proxy validates independently and the caller settles. The CSP case confirms an undeclared network request remains blocked. The legacy case compares tool output and reserved-message traffic against the baseline proxy.

## Automated checks

- 302 inspector tests passed, including existing app registry, renderer, routing, proxy mount and serving tests.
- 10 focused SDK discovery/call tests passed.
- Preparation/script tests: 71 passed, one existing Windows-only skip.
- SDK and inspector client typechecks passed.
- Server typecheck ratchet passed: 107 existing errors versus baseline 109; no new server-source errors.
- Client production build and Electron package succeeded.
- Slop ratchet and whitespace checks passed; source-size check is recorded on the PR.

## Reproduce

Run from the repository root with Node from `mcpjam-inspector/.nvmrc` and dependencies installed with `npm install --legacy-peer-deps`. Set `MCPJAM_EXT_APPS_FIXTURE_REPO` to an ext-apps checkout containing the pinned commit. The runner extracts that exact commit to a temporary fixture directory; production dependencies are unchanged.

```sh
MCPJAM_EXT_APPS_FIXTURE_REPO=/path/to/ext-apps MCPJAM_SPIKE_ELECTRON=1 node --import tsx mcpjam-inspector/server/routes/apps/mcp-apps/__tests__/webmcp-browser.spike.mjs
npm run build:client -w @mcpjam/inspector
npm run electron:package -w @mcpjam/inspector
MCPJAM_EXT_APPS_FIXTURE_REPO=/path/to/ext-apps MCPJAM_SPIKE_RUNTIME=electron MCPJAM_SPIKE_PACKAGED_APP="mcpjam-inspector/out/MCPJam Inspector-darwin-arm64/MCPJam Inspector.app/Contents/MacOS/mcpjam-inspector" node --import tsx mcpjam-inspector/server/routes/apps/mcp-apps/__tests__/webmcp-browser.spike.mjs
npm run test -w @mcpjam/inspector -- server/routes/apps/mcp-apps/__tests__ server/__tests__/sandbox-proxy-mount.test.ts server/routes/apps/__tests__/sandbox-proxy-routes.test.ts client/src/components/chat-v2/thread/mcp-apps/__tests__/app-tools-registry.test.ts client/src/components/chat-v2/thread/mcp-apps/__tests__/mcp-apps-renderer.test.tsx client/src/components/ui-playground/hooks/__tests__/useToolExecution.app-routing.test.ts
npm run test -w @mcpjam/sdk -- src/widget-runtime/__tests__/webmcp-tools.test.ts
```

The package path above is macOS arm64. Use the corresponding built executable on other platforms. The runner writes local results under `mcpjam-inspector/.playwright/`.

## Gate boundaries

S0 proves the isolated view/relay contract. The existing registry and renderer tests protect their legacy behavior, but the new relay is not yet connected to production Chat, Playground or the settings UI. The inline/modal and cross-chat WebMCP integration portions of QA-07 through QA-12, production-host dispatch in QA-19 and settings QA-21 remain Not run until their implementation phases. No ChatGPT app-view default is inferred from these MCPJam tests.

An early disabled-mode fixture failed to complete initialization when native registration was rejected; it now records the rejection and still connects. Initial packaged harness attempts also exposed unsupported Node inspection and target creation in release Electron; the final runner uses the browser interface and an embedded test frame without changing release security settings. Only the final passing runs are included above.
