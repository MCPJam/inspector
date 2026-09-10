# Local Browser / WebMCP security remediation

Scope: local Node and Electron runtimes. Implementation branch: `fix/local-browser-ga-security`, based on `019ea35bd3`. The hosted runtime retains its policy and rollout. Shared driver source changes require regenerating the browserd bundle; local enforcement is opt-in at the local factories.

This is implementation and test evidence, not authorization to enable GA. The design plan lives in `mcpjam-docs/local-browser-ga-security-plan.md`.

## Findings and changes

| Finding | Enforcement | Regression evidence |
| --- | --- | --- |
| F1: agent-supplied file/script navigation | Driver boundary accepts HTTP(S); Electron guards page navigation, redirects and popups; local request policy refuses file/internal protocols. | Destination-policy tests and both real-engine smoke runs reject synthetic file, JavaScript and data URLs. |
| F2: established viewers survive consent revoke/rotation | Contexts, queued input, returned CDP handles, frame/event streams and downloads share a revocable lifetime; immediate in-process teardown, directory watcher and one-second polling fallback; cross-process mutation lock. | Lifetime tests, established silent-viewer revocation tests and real-engine retained-CDP denial. |
| F3: inspected pages reach MCPJam's controller | Register actual controller listeners/frontend origins; normalize loopback/interface addresses; use a private authenticated forwarding proxy that connects to the checked DNS address. Electron also has a centrally owned partition request hook. No TLS interception. Offline caches/workers are cleared before profile reuse. | Synthetic controller gets zero navigation, HTTP, WebSocket, worker, service-worker, frame, popup or redirect requests. Other localhost HTTP/WebSocket and ordinary HTTPS work. |
| F4: misleading unconditional approval promises | Preserve existing settings/defaults; display the active chat's setting; explain shared control, signed-in/local-network access and model-provider data. | Existing browser approval/handoff tests and updated client tests. |
| F5: WebMCP lacks Browser consent and owner/profile isolation | Verify actor/local rollout and Browser grant, bind sessions to owner/project/lifetime, issue single-use session-bound stream nonces, use authenticated fetch streaming. Versioned Electron partitions replace the shared jar. Profile resets serialize with starts; account/project changes close inspection. | Authorization/profile-key tests, route tests, stream replay/scope denial and native IPC sender-frame tests. |
| F6: Electron downloads have no explicit policy | Pause original download; require native save choice; stage privately; enforce 1 GiB, one active download per partition and one pending dialog application-wide; revoke/close cancels; atomically publish; never open files. Node still refuses downloads. | Native-dialog fixture tests cover original authenticated/POST and blob downloads, revocation, concurrent prompts and unknown-length oversize responses. |
| F7: runtime and hostile-page hardening | Electron 43.6.0, Playwright 1.62.1; sandbox/root checks; shared per-context discovery budgets, document invalidation and actionable notice; patched reachable dependency advisories. | Real-engine checks, discovery limits across tabs, native IPC tests and dependency review below. |

## Product behavior

- Localhost/LAN developers, website JavaScript, page resources, OAuth popups, manual invocation and Browser handoff remain supported. Shell permission remains separate.
- Electron WebMCP sign-ins persist per verified actor/project (standalone is a separate namespace). Node inspection remains ephemeral. The legacy `persist:webmcp-inspector` jar is never imported; the browser menu offers explicit deletion. Website sign-in is required once after upgrading.
- Clearing inspection data closes affected sessions and removes website storage/cache. It does not erase saved transcripts, screenshots, exports or cloud profile copies.
- Download staging is private temporary storage. Files are published only after native approval and successful completion. A process-owned staging directory is removed on cancellation/completion; abandoned directories from dead processes are cleaned at the next local Electron launch.
- Tool Approval off still permits autonomous website actions. Page tool descriptions/results remain untrusted and may mislead a model. Revocation/cancellation does not undo effects already completed on a website.
- Local profiles are OS-account-protected files, not a blanket encryption guarantee. Standard Chromium automation settings remain; this is not consumer-browser security parity.
- The private proxy does not inherit arbitrary enterprise PAC/upstream-proxy configurations. Validate those environments before claiming support. Rollout admission is fail-closed and rechecked on a bounded cache; loss of rollout-service availability can close a session.

Discovery limits: 1,024 registrations and 8 MiB metadata per context across tabs; 64 KiB per tool metadata/schema, depth 32; 1,024 changes/second with 2,048 burst; 64 frame targets. A violating document loses its tools and pending calls are cancelled best-effort; normal browsing continues. These checks bound retention and traversal after CDP decoding; they cannot prevent Chromium from allocating the original protocol event.

## Engine and network evidence

Run `node mcpjam-inspector/scripts/run-local-browser-security-smoke.mjs` from the repository root. It uses synthetic local fixtures and `https://example.com`, creates temporary profiles, runs the shipping browser factories, and exits nonzero on failure. It does not silently skip an unavailable engine. The only bundled-module replacement is telemetry logging, preventing fixture activity from being exported.

Verified locally on macOS:

- Node / Playwright 1.62.1 / Chromium 151: HTTP(S), localhost WebSocket, WebMCP support, zero synthetic controller hits, navigation refusal and lifetime revocation.
- Electron 43.6.0 / Chromium 150.0.7871.250: the same checks. This engine requires the explicit `enable-blink-features=WebMCP` override in addition to `enable-features=WebMCP`; the real-engine test caught that difference.

The proxy is necessary: the planning probe showed that `Network.setBlockedURLs` alone did not reliably cover page WebSockets and worker HTTP/WebSockets. A DNS check in Electron's request hook alone also would not pin Chromium's subsequent resolution. Both local engines therefore use the checked-address proxy; Electron's request hook is additional enforcement. [Electron request-hook semantics](https://www.electronjs.org/docs/latest/api/web-request), [proxy authentication events](https://www.electronjs.org/docs/latest/api/app#event-login), [download save-path semantics](https://www.electronjs.org/docs/latest/api/download-item).

## Dependency review

Pinned Electron's patched 43.6.0 release and retained Playwright 1.62.1. Updated compatible Hono, React Router, xmldom, URI/parser and Vite dependency resolutions. Root overrides prevent older transitive `ws` and `ip-address` copies from remaining in the shipping graph. The root npm audit also includes other monorepo products: Next.js, AuthKit Next.js, and Next's nested PostCSS/sharp findings are not dependencies of the Inspector, SDK, chat UI or design-system runtime manifests. They remain a separate webapp remediation task, not a clean monorepo audit claim.

## Final local validation

- Targeted security regression run: 203 passed, 6 optional integration tests skipped.
- WebMCP provider/registry/runtime, CDP contract, discovery and bundle freshness run: 313 passed, 2 optional tests skipped. Real-provider integration and the pinned Chromium contract passed.
- Real Node and Electron security smoke: both passed, zero synthetic controller hits; localhost compatibility, WebMCP discovery and revocation passed.
- Client type check and its renderer/browser-viewer guards passed. Server type checking remains non-green (294 diagnostics); the only diagnostics in changed tracked files are existing unused `logBox` and `afterEach` declarations. The new input-refusal mismatch was fixed.
- `git diff --check` passed.
- Desktop packaging remains **blocked**: on this macOS arm64 machine, Forge exits 0 after “Finalizing package” without creating `out/` or an app bundle, under both Node 26 and Node 24. Available disk space is now sufficient, so low disk space alone does not explain it. Do not count the successful exit as packaging evidence. Existing Desktop Package Smoke CI explicitly checks for this failure mode.

## GA release gate

Do not enable local GA solely because this PR exists or unit tests pass.

- [ ] Final review of local policy, proxy, identity/lifetime and download paths.
- [ ] `Local Browser Security` passes on macOS, Windows and Linux; require those checks in branch protection.
- [ ] Desktop packaging CI passes; test the signed/installable release artifacts and published Node package on supported platforms. The engine smoke runner tests the actual engine/factory, not the installed application's complete boot/update flow.
- [ ] Exercise real OAuth, retained account/project sign-ins, clear-site-data/legacy deletion, native save/cancel and approval-on/off workflows in the packaged app.
- [ ] Validate a member and two guests with hosted rollout off; compare account/project isolation and live revocation.
- [ ] Configure local rollout to require request property `local_browser_security_version = "1"`. Both server and local frontend send this property; do not persist it as a person profile attribute or older clients could inherit eligibility.
- [ ] Record final build/version/check results against the release commit, then enable only the local flag.

Rollback disables local admission and expires existing lifetimes on the rollout cache/poll interval (up to about 11 seconds after the flag result changes); it never disables enforcement. No rollout flags were changed by this implementation.
