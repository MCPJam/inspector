# Managed browser tabs and navigation

Implementation branch: `feat/browser-navigation-tabs`, based on `d1b7c9f6be`.

## Ownership and behavior

`BrowserShell` owns the tab strip, editable address field, Back, Forward and Reload. Plain text becomes a Google search URL on the client; the daemon still accepts URLs only. The workspace flag controls placement and responsive sizing, not navigation availability. Playground navigation acquires its existing human lease. WebMCP inspection uses explicit shared authority; it does not impersonate a lease holder.

The daemon owns tabs for Node, cloud and Electron. `DriverContext.onPageCreated` adopts actual popup pages with their opener intact. Chromium popups open in the foreground. Electron honors its background-tab disposition. Both explicit tabs and popups count toward the default eight-tab cap. Excess Chromium popups close immediately; Electron refuses them before allocation. Closing the active tab selects its surviving opener, then the right neighbor, then the left; the last close leaves a blank tab. Closing an inactive tab preserves the active one.

JPEG subscriptions name the selected tab. Switching tabs closes the old connection and decoder, clears the picture and retires queued input. WebMCP input carries its target tab through HTTP and socket dispatch; late input for a background tab is dropped except for releases. Hosted H.264 and native views still use their existing presentation adapters.

Node WebMCP is a facade over the in-process daemon. Cloud WebMCP resolves tools against the daemon's active tab and retains the exclusive Playground lease behavior. Invocation bindings and before/after evidence retain the original tab when the viewer switches tabs. Tool results are unwrapped from daemon observation metadata; truncation and registration provenance are preserved.

Electron WebMCP uses a main-owned `WebContentsView`, registered under the daemon boot ID. The shared inspection surface receives native input without a shield. The existing persistent WebMCP partition is retained. Native-window/headless viewing remains non-interactive in the inspector pane.

## Delivery order and retirements

1. Shared search classification, shell authority, opener state and close policy.
2. Daemon popup adoption, loading state, tab cap and selected-tab streaming.
3. Cloud WebMCP active-tab binding.
4. Node WebMCP over the in-process daemon.
5. Electron WebMCP over `WebContentsView`.

Removed: the single-page Playwright provider and capture owner, Electron webview provider, `ElectronWebviewPane`, mount/guest-ID handshake, webview attach error routes, `webviewTag`, and `will-attach-webview` guard. Their real-browser parity suite now runs against the daemon facade. The old renderer-owned transport kind is replaced by `electron-native` with a boot ID.

The WebMCP frame envelope and blob-URL adapter remain a transport boundary. A follow-up can replace them with the daemon frame reader directly; this delivery does not introduce another capture engine or tab registry.

## Validation

Automated checks cover search/URL classification, shared versus lease authority, popup caps and opener preservation, close policy, native placement and no-shield shared mode, selected-tab transport, input lifecycle, and existing browser-pane regression suites.

Real Chromium checks exercise popup clicks, return-to-opener, navigation/history, frames, iframe tool discovery/invocation, declarative cross-document results, cancellation, output limits, screenshots and explicit DPR 2. The frame test changes the page rather than requiring duplicate paints of an identical document, since duplicate paints are intentionally suppressed.

Product defaults match the shared daemon: pane-sized DPR 1 and stable JPEG quality, with the daemon's existing oversize fallback. Explicit high-density inspection remains supported. This is a quality/performance choice, not a new measured latency claim.

Release checks still requiring an interactive environment: packaged Electron native placement/focus and OAuth popup behavior, cloud H.264/JPEG switching, and Google search from a cloud machine (including possible consent/CAPTCHA). Unit tests and local Chromium do not substitute for these checks.

### Reproducible native smoke

From the inspector package, run:

```sh
npx esbuild scripts/smoke-electron-browser-navigation.ts --bundle --platform=node --external:electron --outfile=/tmp/mcpjam-electron-navigation.cjs
../node_modules/.bin/electron /tmp/mcpjam-electron-navigation.cjs
```

Passed on Electron 43.4.0: native startup, actual popup adoption, `window.opener` identity, shared input authority and return-to-opener. This exposed and fixed renderer initialization before CDP, and adopting Electron's supplied popup `webContents` rather than allocating unrelated contents. The smoke activates a page link through CDP; it does not claim packaged-app pointer/focus or OAuth-provider coverage.

Client typecheck and import guards, production server build, daemon bundle freshness, design synchronization and design lint pass (the latter retains existing warnings).

Final combined regression run: **69 suites passed, 3 skipped; 1,548 tests passed, 7 skipped**. This includes browser shells/bodies, WebMCP UI, daemon and Electron unit suites, routes, shared contracts and real Chromium provider parity with `RUN_BROWSER_NAVIGATION_INTEGRATION=1`. The separately run daemon bundle freshness check passed all four tests.
