# WebMCP tools for MCP App views (host side, dual path)

Execution tracking: [KES-709](https://app.kestral.ai/workspace/yhNILB2/task/1SmJFYy7).
S0 evidence: [WebMCP app-view spike](./webmcp-app-tools-spike.md).
The S0 relay proof is complete; the later integration and settings QA gates
remain outstanding.

## Context

ChatGPT Desktop supports WebMCP site tools in its built-in browser. The cited
documentation, https://learn.chatgpt.com/docs/webmcp, does not establish that
MCP App iframes expose tools through the same path. Treat that separately as
an unverified host capability. ext-apps issue
https://github.com/modelcontextprotocol/ext-apps/issues/797 discusses
replacing App Tools (`app.registerTool`, view-handled `tools/list`) with WebMCP;
this is a proposed direction, not a finalized migration contract.
Draft PR https://github.com/modelcontextprotocol/ext-apps/pull/798 prototypes
it: the host injects a `document.modelContext` polyfill into the view, the
sandbox proxy relays the view's tools as reserved messages, and the host lists
and calls them.

MCPJam already ships SEP-1865 App Tools end to end (`app_<8hex>` aliases,
client-fulfilled), and separately consumes page WebMCP tools through CDP.
This work connects WebMCP registrations inside MCP App views to the existing
App Tools pipeline. The intended public API is the W3C Community Group's draft
`document.modelContext` API inside the view, with the supported subset documented.
The proxy↔host messages are private, because we own both ends. We reuse #798's
host↔proxy method names so
we can adopt its relay if it merges.

**Outcome:** a view that registers tools with `document.modelContext` shows up
as `app_<8hex>` tools in Chat and the Playground, exactly like an App Tools
view. This holds in web, in desktop and in every mount mode, for clients whose
hostConfig enables it (MCPJam by default; other clients by explicit override).
Enable ChatGPT by default only after app-view-specific evidence is recorded.
Working legacy `tools/list` / `tools/call` views keep today's path, byte for byte.

Anchors: inspector `origin/main` @ `7c5bbde26e`; backend `origin/main` @
`1004271da`. A reviewer agent checked this plan adversarially against the code,
and its blockers are folded in.

## Design decisions

1. **One active source per view, selected by discovery.**
   `appToolSourceFor(bridge.getAppCapabilities(), mcpAppsCapabilitiesRef.current)`
   chooses the initial candidate:
   - `"mcp-apps"` if the view declared `tools`
   - otherwise `"webmcp"` if the client's `webmcpTools === true`
   - otherwise `null`

   In the current #798 prototype, deprecated `app.registerTool()` is a WebMCP
   wrapper: it no longer serves those tools over `tools/list` / `tools/call`
   or automatically declares `tools`. It does not expose both protocols.
   An app can nevertheless retain an explicit `tools` capability in its
   constructor. If the **initial** legacy list returns JSON-RPC -32601
   (method not found), and WebMCP is enabled, try WebMCP and retain that source
   for the current bridge/mount. Do not fall back on an empty successful list,
   a timeout, malformed data, another error, or a failed tool invocation.
   Once selected, do not switch sources mid-mount; reset discovery on remount.

   Share this decision and its per-mount state across inline and modal refresh
   logic. Store the selected source on the registered instance for dispatch;
   retain discovery state even when its empty list holds no registry slot.
   Never merge both lists. Each refresh event acts only on the selected source:
   `notifications/tools/list_changed` → `mcp-apps`, and
   `ui/notifications/sandbox-tools-changed` → `webmcp`. While discovery is in
   flight, coalesce events into a pending refresh and apply the source filter
   after selection. A proxy remount must not clear a working legacy tool set.
2. **We always inject our own polyfill, and it shadows native WebMCP.**
   - Desktop turns native WebMCP on for every renderer
     (`mcpjam-inspector/src/main.ts:143-146`).
   - The `tools` permissions policy defaults to `'self'`, the proxy is
     cross-origin to the app, and we never delegate `allow="tools"`. So native
     `registerTool` inside a view rejects (`NotAllowedError`), in desktop and in
     Chrome with the flag on.
   - #798's "native always wins" would therefore give **zero tools** there.
   - Our polyfill defines `document.modelContext` as a configurable own
     property, intended to shadow the `[SameObject]` prototype getter. Prove
     installation in the real-browser spike; report an installation failure
     rather than asserting that property definition can never throw.
     This also isolates the app-view path from per-version quirks: the Chromium
     150 vs 153 `signal` difference, string schemas, generic `UnknownError`, and
     unregistering during a call.
3. **The polyfill and proxy talk over a private postMessage `type`, not JSON-RPC.**
   The view's ext-apps `App` answers unknown JSON-RPC requests with -32601, and
   it ignores non-JSON-RPC messages. Private `type` messages work the same in
   write, srcdoc and **opaque** mounts. In opaque mode the proxy can't read
   `inner.contentDocument`, which is #798's blind spot. The proxy translates
   between JSON-RPC (toward the host) and the private channel (toward the view).
4. **Results reach the model as text.** `scrubAppToolResultForModel`
   (`client/src/components/chat-v2/thread/mcp-apps/app-tools-sanitizer.ts:20-27`)
   passes only `content`, so #798's `{content: []}` would show the model nothing.
   The relay returns `{content:[{type:"text", text}], structuredContent}`.
   The **entire serialized result**, including both copies and JSON escaping,
   is limited to 256 KiB of UTF-8, as specified below.
5. **Gate on a new client capability, `McpAppsCapabilities.webmcpTools`.**
   **Absent means off.**
   - Set it on a new `MCP_APPS_MCPJAM`. Leave it absent on `MCP_APPS_CHATGPT`
     until an app-view capture or explicit vendor documentation establishes
     support for that preset's actual surface. Browser site-tool support alone
     is insufficient. Record host version, surface, fixture and evidence link
     before changing the ChatGPT default in a follow-up.
   - **Do not put it in `MCP_APPS_FULL`.** `MCP_APPS_CLAUDE`, `MCP_APPS_MISTRAL`
     and `MCP_APPS_CURSOR` spread `MCP_APPS_FULL`, and claude-code, mistral,
     codex and every unknown style use `MCP_APPS_FULL_SURFACE`.
   - When the setting is off, the proxy doesn't inject the polyfill or relay
     WebMCP tools. Native `document.modelContext` may still exist; absence of
     that property is not the disabled-mode acceptance test.
   - The renderer's `widgetMcpAppsCapabilitiesReloadKey` hashes the whole
     resolved object (`widget-react/src/mcp-apps-renderer.tsx:1482-1484`), so
     toggling the setting reloads the iframe.
6. **Approval follows app tools, not page tools.** `buildAppTools` uses
   `needsApprovalFor("never", false)` (`server/utils/chat-v2-orchestration.ts:912-927`).
   No server change.
7. **Out of scope:**
   - the eval browser harness and `render_server_widget` (no proxy, and no app
     tools today)
   - agent-harness turns (they already flag `appTools` as unavailable)
   - upgrading production dependencies to ext-apps v3 (a pinned prototype
     fixture is in scope for compatibility testing)
   - publishing to any browser agent
   - image results

## Shared implementation

Reuse existing code before adding helpers, and list these dependencies in each
PR's **Reused** section:

- `widget-react/src/app-tools-registry.ts` remains the one owner of app aliases,
  instance selection, pending-call tracking and snapshots. Keep the existing
  client-fulfilled wire contract and `buildAppTools` server orchestration.
- `sdk/src/widget-runtime/` owns framework-free source-selection rules, shared
  descriptor types and bridge request helpers. Derive the descriptor type from
  `AppBridge` there and re-export it from widget-react; the SDK must not import
  widget-react or inspector internals. Reuse `mcpAppToolResultSchema`,
  `LoggingTransport` and the existing invocation types.
- Inline and modal views use one discovery/refresh implementation. Chat and
  Playground use one `dispatchAppToolCall` implementation. Move existing code
  when extracting it, retaining legacy pagination and lifecycle behavior;
  remove the replaced bodies rather than maintaining copies.
- Use one browser-safe wire-helper source for descriptor normalization,
  JSON-safe result encoding and byte limits in the injected polyfill and proxy.
  Both realms execute the same source; each still validates its own untrusted
  boundary. Keep it as explicit ES2017 source text, composed into both scripts,
  without `Function.prototype.toString()` or a hand-maintained second copy.
  Tests evaluate the exact source shipped to the view and proxy.
  Keep method names and byte limits in a small SDK contract module; inject its
  JSON data into the script source and import it in host request helpers.
- Inspect `shared/declared-tools.ts` for existing schema/byte-limit primitives.
  If a primitive is suitable for both paths, move the minimal policy-free leaf
  to an appropriate shared module and update its callers. Do not pull the
  page-tool naming, approval policy or CDP state machine into the app runtime.
  The existing JSON helpers are not automatically safe bounded serializers.
- Chess fixtures share schemas and handler bodies between legacy, direct
  WebMCP and the prototype wrapper. Keep only registration/result adapters
  specific to each protocol. Promote the spike's code and fixtures into the
  production PRs; do not rebuild a second implementation after the spike.

## Security

- **The view is untrusted.** It can skip the polyfill and post anything. The
  proxy:
  - accepts private replies only when `event.source === inner.contentWindow`
    and the `requestId` is pending for this mount; tools-changed notifications
    have no request id and are source-checked and throttled separately;
  - re-validates every descriptor: name `^[A-Za-z0-9_.-]{1,128}$`, a non-empty
    string description, and an object or absent `inputSchema`. It **drops**
    a non-object `type` rather than rewriting it;
  - drops anything malformed;
  - caps the entire serialized result at 256 KiB of UTF-8, including text,
    `structuredContent`, JSON escaping and result-envelope overhead;
  - never forwards an unbounded original value alongside a bounded text copy.

  The registry caps still apply: 64 tools, a 512-character description and an
  8 KB schema (`widget-react/src/app-tools-registry.ts:86-88`).
- **Descriptions are app-authored model input.** That's the same trust level
  as App Tools today: `buildAppTools` prefixes `[appName]`.
- **Isolation.** The registry is per document, so sibling views can't list or
  call each other's tools (native consumer APIs would allow same-origin access).
  Because we never delegate `allow="tools"`, native registration stays
  rejected and no browser agent ever sees view tools.
- **No flooding.** The polyfill coalesces `tools-changed` per microtask, and
  the proxy throttles it to a trailing edge of at most one per 250 ms per
  mount. Empty WebMCP lists don't take a registry slot (the cap is 64
  instances: `widget-workspace.tsx:38`, `app-tools-registry.ts:296-304`).
- **The CSP can't block the polyfill.** It goes in the guard slot, ahead of our
  CSP `<meta>`, in both CSP branches and every mount mode
  (`sandbox-proxy.html:885-930, 1389-1399`).

### Result encoding and limits

- Serialize the tool's return value once in the view and use the JSON-safe
  snapshot for both text and `structuredContent`. Strings remain text;
  objects become JSON text and structured content; other JSON values use
  `{result: value}` for structured content. Normalize a top-level `undefined`
  result to `null`, matching the prototype's consumer behavior.
- Catch serialization and structured-clone failures, including cyclic values,
  `BigInt` and throwing `toJSON` methods. Return a small `isError: true` result
  that identifies a result-encoding failure; never leave the request pending.
  The handler may already have changed state, so never automatically retry it.
- Check the private reply's serialized size before the view posts it, then
  revalidate and bound the complete `CallToolResult` before the proxy forwards
  it. Use the same 256 KiB limit and shared helper source at both boundaries.
  The host also rejects a result that exceeds the result contract. Untrusted
  views can bypass the polyfill, so its check alone is insufficient.
- An oversized result becomes a small explicit error with no original
  `structuredContent` or partial JSON. Error text is bounded too. These limits
  bound what the host forwards and retains; they do not prevent an untrusted
  view from allocating or attempting to post a large value itself.
- Cover multibyte strings, JSON escaping, combined text/structured duplication,
  boundary-sized payloads, oversized structured-only values, `undefined`,
  `BigInt`, cycles and clone/encoding failures in the shared contract tests.

## Wire protocol

**Host ↔ proxy (JSON-RPC 2.0 over the AppBridge transport; names from #798):**
- `ui/sandbox-list-tools`: params `{cursor?}` → `{tools}` (one page).
- `ui/sandbox-call-tool`: params `{name, arguments}` → `CallToolResult`. An
  unknown tool is -32602; a dead view or remount is -32603.
- `ui/notifications/sandbox-tools-changed`: proxy → host.
- `notifications/cancelled` for a relayed id is intercepted and becomes a
  private cancel; it isn't forwarded to the view.
- When `webmcpTools` is off, the reserved requests are answered -32601 by the
  proxy and never forwarded.

**Proxy ↔ view (private `type`; never forwarded to the host):**
- proxy → view:
  - `{type:"mcpjam:webmcp/list", requestId}`
  - `{type:"mcpjam:webmcp/call", requestId, name, input}`
  - `{type:"mcpjam:webmcp/cancel", requestId}`
- view → proxy:
  - `{type:"mcpjam:webmcp/list-result", requestId, tools, replaced?}`.
    `replaced: true` means the view overwrote our polyfill.
  - `{type:"mcpjam:webmcp/call-result", requestId, ok, value | error}`;
    `value` is the bounded JSON-safe snapshot, never the raw handler value.
  - `{type:"mcpjam:webmcp/tools-changed"}`

**Remounts.** Every inner frame is new, including the proxy's own automatic
remounts (`sandbox-proxy.html:1113-1124, 1458`), so it starts with no tools.
On each mount the relay:
- fails pending requests with -32603;
- emits `sandbox-tools-changed` **only** if the previous view had tools or
  pending requests, so a legacy view never sees extra traffic.

The host resets its source-selection state for the new mount and rejects late
discovery results from the old one. When an opaque view navigates itself and
the existing proxy closes its channel, invalidate its tools and pending calls;
do not promise an automatic reload that this mount mode does not support.

## Execution

### Common preamble (every PR)

- **Kestral:** create one task, "WebMCP tools for MCP App views", with this plan
  as its spec, and link each PR in the PR template's first section (AGENTS.md).
- **Worktree:**
  `git fetch origin && git worktree add ../insp-webmcp-<n> -b <branch> origin/main`.
  Use Node from `mcpjam-inspector/.nvmrc` and run
  `npm install --legacy-peer-deps`.
- **Run the app:**
  `npm run dev:worktree -w @mcpjam/inspector -- <N> --no-worker`. It builds
  the SDK and runs `bundle:all`, which regenerates the gitignored
  `SandboxProxyHtml.bundled.ts`.
- **Style:**
  - Format only the lines you change, and never `prettier --write`.
  - No `as unknown as` (ratcheted by `slop:check`), no `as any`, no swallowed
    errors, and no `console.*` in server code.
  - **Comments:** don't write `#797`, `#798` or `YYYY-MM-DD` in comments; the
    slop `history-comment` rule counts them (`scripts/slop/rules.mjs:57-58,
    136-140`). Use full URLs.
- **File budget:** files over 800 lines may grow by at most 50. Watch:
  - `mcp-apps-renderer.tsx` (4,936)
  - `app-tools-registry.ts` (834)
  - `use-chat-session.ts` (6,332)
  - `chat-v2-orchestration.ts` (2,077)

  Put new logic in new modules. `.html` and tests aren't measured.
- **Gates:** `npm run slop:check`; the affected typechecks
  (`npm run typecheck:client -w @mcpjam/inspector` for client, `shared/` and
  widget-react consumers; `typecheck:server`; SDK and widget-react per their
  `package.json`); then the targeted tests via
  `npm run test -w @mcpjam/inspector -- <path>` (or the workspace's own
  script). Run `npm run slop:size` before opening the PR.
  Map each PR to the QA IDs below and attach evidence for its applicable gate.
  Existing passing results can be carried forward only when relevant code,
  fixtures, dependencies and build inputs are unchanged.
- **Merge order:**

  | Step | Can start | Needs before merge / release |
  |---|---|---|
  | Spike S0 | now, in an isolated worktree | real-browser gate below |
  | PR 0, PR 1, PR 2 | after S0 passes | promote the proven fixture/relay code |
  | PR 3 | after PR 1 and PR 2 merge | integrated QA gate below |
  | BE-1 | after PR 3 works end to end | prod deployment before PR 4 release |
  | PR 4 | after PR 3 works end to end | settings QA gate and BE-1 on **prod** before release |
  | ChatGPT default | after app-view evidence exists | surface-specific evidence recorded and tests updated |

  The memory rule still holds: one PR per review, and fix review findings
  before starting a dependent step.

---

### Spike S0 — prove the app-view bridge before the rollout

Build a thin test harness using the actual sandbox proxy, injected source and
AppBridge request helpers that PR 2/PR 3 will ship. Pass `webmcpTools: true`
through the harness; no client settings UI or backend persistence is needed.
Keep the test under the relevant existing test directories in the worktree.
The implementation is promoted into later PRs, with no duplicate throwaway relay.

- Exercise register → list → call → cancel → remount against write, srcdoc and
  opaque mounts. Assert a cancelled or remounted request settles and late
  replies cannot revive old tools or complete a new request.
- Use real Chromium with native WebMCP both disabled and enabled, plus
  Electron with its current native-WebMCP launch flags. Verify that our own
  `document.modelContext` is installed before app scripts and works under the
  actual CSP and iframe permissions. jsdom alone cannot establish this.
- Run the same minimal fixture in a packaged/minified desktop build before
  accepting the gate, so the source-string injection is exercised after the
  real build transforms. Record exact browser/Electron versions.
- Keep three fixture adapters over the same handlers: current legacy App Tools,
  direct WebMCP registration, and the **actual** `App.registerTool()` wrapper
  from a pinned commit of upstream PR #798. Pin it in test-only fixture setup;
  do not upgrade the application's ext-apps dependency.
- Test the prototype wrapper both with its normal capability declaration and
  with an explicit leftover `tools: {}`. The latter must reach WebMCP after
  the initial `tools/list` returns -32601. A working legacy view must retain its
  legacy path with no additional `ui/sandbox-*` discovery traffic.
- Check bounded success/error results, serialization failure, an empty tool
  list, registration changes, and capability-off behavior. With the feature
  off, assert no injected polyfill or WebMCP tool exposure; native API presence
  is allowed. For an opaque self-navigation, assert channel closure and cleanup;
  for a host-triggered fresh mount, assert registration/discovery recovers.

**Exit gate:** record commands, versions, the pinned upstream commit and the
browser results and S0 QA cells in
`mcpjam-inspector/docs/webmcp-app-tools-spike.md`. Resolve
failures in injection, routing, cancellation, result encoding or lifecycle
before expanding into PR 0–3. ChatGPT app-view verification is independent;
missing evidence keeps that preset off and does not block MCPJam support.

### PR 0 — chess-mcp WebMCP fixture (repo `MCPJam/chess-mcp`, `~/chess-mcp`)

`chess.mcpjam.com` is live, so the legacy tool stays as it is.

- `server.ts`:
  - Register a second resource, `ui://chess/board-webmcp.html`, built from the
    same HTML with `<script>window.__CHESS_TOOLS_VIA="webmcp"</script>`
    inserted after `<head>`.
  - Add a second tool, `start_game_webmcp`, that points at it.
  - Leave `start_game` as it is.
- `src/mcp-app.tsx`:
  - `App` is built at module scope with `tools` (:56-62). Make `tools`
    conditional, and leave it off when
    `window.__CHESS_TOOLS_VIA === "webmcp"`. Declare
    `interface Window { __CHESS_TOOLS_VIA?: "webmcp" }`.
  - In WebMCP mode, register the four tools with
    `document.modelContext?.registerTool({name, description, inputSchema: z.toJSONSchema(schema), execute}, {signal})`.
    zod 4.4.3 has `z.toJSONSchema`. Parse the input with zod inside
    `execute`, since WebMCP doesn't validate it.
  - Return plain objects that **include** the identity line and the ASCII board
    as fields (for example `{summary, board, fen, …}`).
  - Share the schemas, input parsing and four handler bodies with the legacy
    `app.registerTool` path. Registration and result wrapping are thin adapters.
- Promote S0's pinned prototype-wrapper fixture into compatibility tests. Share
  the same handler contracts; do not add a production v3 dependency or deploy
  the prototype fixture to the live chess server.
- Dev dependency: `webmcp-types` (0.1.10 on npm), added to `tsconfig`
  `types`.
- Verify: `npm run build && npm run serve`, then call both start tools through
  `npx -y @mcpjam/cli`. Deploy with `npm run deploy` only after PR 3 works
  locally against `http://localhost:3001/mcp`.

### PR 1 — `webmcpTools` client capability, end to end in the resolver (branch `feat/webmcp-app-tools-1-capability`)

- **SDK:**
  - `sdk/src/host-config/types.ts:513-591`: add `webmcpTools?: boolean` to
    `McpAppsCapabilities`, with a doc comment: what it does, absent ⇒ off,
    and links to the ext-apps issue and PR.
  - `sdk/src/host-config/canonicalize.ts:96-121`: add the key to
    `MCP_APPS_CAPABILITY_KEYS`. The generic boolean branch (`:1501-1508`)
    already validates it.
  - `sdk/src/host-compat/catalog-schema.ts:40-111`: add the zod mirror key.
  - `sdk/src/host-compat/capabilities.ts`:
    - add `export const MCP_APPS_MCPJAM = frozen({...MCP_APPS_FULL, webmcpTools: true})`;
    - leave `webmcpTools` absent on `MCP_APPS_CHATGPT` (:87) until app-view
      support is verified for that surface; the site-tools page is not evidence
      for this preset;
    - leave `MCP_APPS_FULL` unchanged.
- **Client and widget resolver** (the key would otherwise be dropped):
  - `client/src/lib/client-styles/types.ts:359-388` and
    `widget-react/src/widget-host.ts:139-166`: add `webmcpTools?: boolean` to
    both `ResolvedMcpAppsCapabilities`.
  - `client/src/lib/client-config-v2.ts:723-783` `mergeMcpAppsCapabilities`:
    add `webmcpTools: override.webmcpTools ?? base.webmcpTools`.
  - `client/src/lib/client-styles/built-ins.ts:908`: point the `mcpjam` style
    at an `MCP_APPS_MCPJAM_SURFACE` derived the same way `MCP_APPS_FULL_SURFACE`
    is. ChatGPT (:386) remains off through `MCP_APPS_CHATGPT_SURFACE`; it can
    inherit a separately verified default in a later change.
  - Confirm the default MCPJam client resolves to the `mcpjam` style. Unknown
    styles fall back to `MCP_APPS_FULL_SURFACE` (`client-config-v2.ts:826-828`),
    i.e. off.
- **Tests:**
  - canonicalize accepts a boolean and rejects a non-boolean;
  - merge test: preset true; override false wins; absent stays absent;
  - resolved capabilities: mcpjam is true; chatgpt, claude, claude-code,
    cursor, codex and an unknown style are undefined; an explicit override
    still works for each client;
  - `sdk-matrix-parity.test.ts` (:28-56): add `"webmcpTools"` to its
    optional-keys list.
- **Compat verdicts are unaffected.** `widget-scan.ts:39-67` reads an explicit
  check list from the backend catalog seed. Confirm no golden or snapshot tests
  change.
- **Changeset:** `@mcpjam/sdk` minor.
- KES-631 (#6563) edits `mcpProfile.apps` in the same types file; rebase if it
  lands first.

### BE-1 — backend accepts the override (repo `mcpjam-backend`, after PR 3 works)

The backend canonicalizes with the **pinned** published SDK, 9.3.1
(`convex/lib/hostConfigV2.ts:25`; main's SDK is 10.0.0). That SDK rejects
unknown `mcpAppsOverrides` keys. Don't bump it. Use the existing pattern for
keys the pinned SDK doesn't know:
- Add `'webmcpTools'` to `PROBE_MCP_APPS_KEYS` (`hostConfigV2.ts:1389-1396`), so
  the key is stripped before the SDK canonicalizes.
- Restore and validate it in `restoreProbeProfileFields` (`:1514+`) as a boolean,
  using the same shape as `resourceCacheTtl`.
- Mirror the type next to `safeAreaInsets` (`:814-899`).
- No Convex validator changes: `mcpProfile` is `v.optional(v.any())`. No change
  to `marketHostCatalog`: its seed is a hand-written literal that doesn't carry
  the key.
- **Tests:** an override with `webmcpTools: true` round-trips through save,
  canonicalize and read, with a stable hash; a non-boolean is rejected.
- **Deploy:** main auto-deploys staging, and prod needs a deploy per the deploy
  playbook. This must be on **prod** before the inspector release that ships
  PR 4.
- Out of scope, but report it: `safeAreaInsets` is stripped and never
  restored. That's an existing bug; file it separately.

### PR 2 — sandbox proxy polyfill and relay (branch `feat/webmcp-app-tools-2-proxy`)

Promote S0's relay and fixture coverage. Inert in the product until PR 3 sets
the new param; S0 exercises it through the harness.

- **Polyfill:**
  - Introduce the small SDK wire-contract module used by both host requests
    and proxy script generation: method names and `MAX_WEBMCP_RESULT_BYTES`.
    Pass these constants as serialized bootstrap data to the shared script
    source; do not repeat the protocol literals or limits in each realm.
  - New `mcpjam-inspector/server/routes/apps/mcp-apps/webmcp-view-polyfill.ts`
    exporting `WEBMCP_VIEW_POLYFILL_JS` as a **plain ES2017 string constant**
    (#798's approach).
  - **Don't build it from function source text.** Packaged desktop builds
    minify the server (Electron Forge Vite base config), and bundlers rename
    colliding top-level functions.
  - Port #798's `MODEL_CONTEXT_POLYFILL_SOURCE` from the commit recorded by S0.
    Fetch with
    `git -C ~/ext-apps fetch origin pull/798/head:refs/remotes/origin/pr-798`,
    record `git -C ~/ext-apps rev-parse origin/pr-798`, and read
    `src/model-context-host.ts` at that exact commit. Preserve attribution and
    the upstream license; document the local adaptations for later upstreaming.
  - Keep shared wire helpers in one sibling `webmcp-wire-source.ts` module as
    explicit source text, composed into the polyfill and proxy. The sandbox
    HTML renderer injects the same helper source for the proxy; no copied
    serializers or normalizers in the HTML, tests or host dispatch sites.
    Make these changes:
    1. Always install with
       `Object.defineProperty(document, "modelContext", {value, configurable: true})`,
       with a `Symbol.for("mcpjam.webmcp.polyfill")` marker.
    2. Add the private channel: handle `mcpjam:webmcp/*` from `window.parent`;
       call `execute(input, {signal})`; encode and bound the result through the
       shared wire helpers before replying with `postMessage(…, "*")`.
    3. Coalesce `tools-changed` per microtask.
    4. Keep the validation (duplicate or invalid name, missing description,
       non-function `execute`) and the abort-signal unregister.
    5. On each list, report `replaced: true` if `document.modelContext` no
       longer carries our marker.
- **Serving:**
  - Add a `"__MCPJAM_WEBMCP_POLYFILL__"` placeholder in `sandbox-proxy.html`.
    Add a corresponding wire-helper placeholder for the proxy's own realm.
  - Replace it in `renderSandboxProxyHtml()`
    (`server/routes/apps/mcp-apps/sandbox-proxy-html.ts:160-171`), like
    `__MCPJAM_RECORDER_SHIM__` (:162-164).
  - An unreplaced placeholder means "no polyfill", handled the way
    `RECORDER_SHIM` is (`sandbox-proxy.html:792, 872`).
- **Injection:**
  - Read a new `webmcpTools` param in the `sandbox-resource-ready` handler
    (`sandbox-proxy.html:1278-1417`) and keep it in proxy state, so
    `remountLast` keeps the relay on.
  - When it's true, prepend the polyfill `<script>` inside the guard slot
    (`guardScript`, :1389-1391).
- **Relay** (named functions inside the proxy, so `extract()` tests can reach
  them):
  - `webmcpRelayHandleHostMessage(data)` is a new `else if` before the final
    branch (:1428).
    - It handles the two reserved methods and `notifications/cancelled` for
      relayed ids.
    - It forwards to the view through `sendToInner`, so the opaque load buffer
      (:1217-1224) and dead-channel state (:1436) apply.
    - The literal `sendToInner(event.data);` must stay in the host branch,
      because `sandbox-proxy-mount.test.ts:853-860` pins it.
  - `webmcpRelayHandleViewMessage(data)` intercepts `mcpjam:webmcp/*` from the
    inner window **before** the forward allowlist (:1461-1473).
    - It answers the host with its original `id`, sent to `hostOrigin`, which
      is always set by then (:1273-1277).
    - Call a named function there rather than posting inline: :836-847 forbids
      an inline `window.parent.postMessage` in that span.
  - `normalizeWebmcpTool` and `toWebmcpCallToolResult` use the single shared
    wire-helper source and the **Result encoding and limits** contract above.
    Preserve bounded text and structured results only when the complete
    envelope fits. Oversize/encoding errors become small `isError: true`
    results with no retained original payload. Do not retry a handler.
  - `webmcpRelayReset()` runs from `mountInner` (:1022) and follows the
    remount rule above. Throttle on a trailing edge. The list request times out
    in the proxy after 10 s; calls rely on the host's timeout and signal.
    Integrate the same cleanup with the existing opaque-channel-close path.
- **Host iframe:** `widget-react/src/sandboxed-iframe.tsx` gets a new prop
  `webmcpTools?: boolean` (default false). Add it to the `sandbox-resource-ready`
  params (:598-652) and the `resourceReadyKey` inputs (:546-582).
- **Tests** (vitest + jsdom):
  - New `server/__tests__/sandbox-proxy-webmcp.test.ts`, which `extract()`s the
    relay functions. Cover list, call, error, unknown tool, cancel, remount
    reset (both branches of the emit rule), trailing throttle, wrong
    `event.source` dropped, and flag off → -32601 with no forward.
  - Shared wire tests cover the full byte/serialization matrix above, including
    a hostile private reply that bypasses the polyfill. Execute the shipped
    source in both realms; keep one set of contract vectors.
  - Evaluate the **exact** `WEBMCP_VIEW_POLYFILL_JS` string in jsdom: register,
    duplicate, abort, getTools, executeTool, coalesced change, `replaced`.
  - Extend `sandbox-proxy-mount.test.ts` for polyfill presence and order (guard
    slot before the CSP meta) in write and opaque mounts.
  - Placeholder-replacement tests for both polyfill and shared helper source:
    - `server/routes/apps/__tests__/sandbox-proxy-routes.test.ts:35`
    - `server/routes/apps/mcp-apps/__tests__/sandbox-proxy-html.test.ts:171`
    - `server/routes/web/__tests__/auth.test.ts:117`
  - `widget-react` sandboxed-iframe tests for the new param and key.
- **Validation:** `npm run test -w @mcpjam/inspector -- server/__tests__/sandbox-proxy`,
  the placeholder tests, `typecheck:server`, and the widget-react tests.
  Retain S0's real-browser and packaged-desktop coverage; repeat it when the
  relay, injected source or relevant build inputs change.

### PR 3 — host discovery and dispatch (branch `feat/webmcp-app-tools-3-host`, after PR 1 and PR 2)

- **SDK, new module in `sdk/src/widget-runtime/`** (zod is already a dependency
  there; widget-react has none). Export it from the entry widget-react already
  uses for `createHostAppBridge`.
  - Export the shared `AppToolDescriptor` type derived from `AppBridge` here;
    widget-react re-exports it from its existing entry. No reverse package
    dependency and no separately maintained descriptor interface.
  - Import PR 2's wire-contract constants. Test the rendered proxy and injected
    source against that same contract; no second handwritten set of names or
    byte limits in this module.
  - `appToolSourceFor(appCaps, mcpAppsCaps): "mcp-apps" | "webmcp" | null`.
    This is the initial candidate only. WebMCP requires `webmcpTools === true`.
    Keep the -32601-only initial-discovery fallback in one shared helper. Use
    the structured error code, never message matching or the app's version.
  - `listViewWebmcpTools(requester, {signal})` → `AppToolDescriptor[]`. The list
    schema is typed `z.ZodType<{tools: AppToolDescriptor[]}>`, with
    `inputSchema.type` as the literal `"object"`.
  - `callViewWebmcpTool(requester, name, args, {signal})` reuses
    `mcpAppToolResultSchema` (`widget-runtime/index.ts:60`). Its result type
    matches `bridge.callTool`, so the scrub, record and typing at the dispatch
    sites don't change. Enforce the complete-result byte bound on this receive
    path too; do not independently reshape the result in Chat and Playground.
  - **Cast-free typing:**
    - Declare `interface SandboxToolsRequester` with method syntax and
      non-generic signatures (two overloads, or one returning
      `Promise<unknown>` parsed locally), with options
      `{signal?: AbortSignal}`.
    - Under `strictFunctionTypes`, method parameters are checked bivariantly,
      so `AppBridge` is assignable as is. Type `params?: object`.
    - Don't make it generic over `z.output<S>`.
    - Do not rely on an exported `ExtensionAppBridge`: the modal uses a plain
      `new AppBridge`. Prove structural assignability with the typecheck.
  - `isSandboxToolsChanged(method)`.
  - Tests: the initial source matrix; -32601-only fallback; no fallback on
    empty lists, timeouts, malformed data or tool-call errors; list/call request
    shape; malformed/oversized results rejected; `signal` passed through.
- **Shared discovery in widget-react:** extract the existing refresh logic
  into a small `app-tool-discovery.ts` module used by inline and modal views.
  It owns selected-source state per bridge/mount, in-flight refresh coalescing,
  empty-list cleanup and stale-result rejection. Retain existing legacy
  pagination and registration behavior. Reuse the registry's pending-call and
  instance cleanup; do not create a parallel registry or cancellation owner.
  Retire the replaced renderer body and keep React integration thin.
- **widget-react, new module `widget-react/src/app-tool-dispatch.ts`**
  (exported from the package index):
  - `dispatchAppToolCall(entry, args, {signal})` branches on
    `entry.instance.toolSource`.
  - The legacy branch is today's `entry.bridge.callTool({name, arguments})`,
    with no signal, exactly as now.
  - Test both branches.
- **Registry** (`app-tools-registry.ts`, ≤+50 lines):
  - Add `AppInstance.toolSource?: "mcp-apps" | "webmcp"`; absent ⇒ `"mcp-apps"`.
  - `resolve()` already returns `instance`.
  - No wire or server change.
- **Renderer** (`mcp-apps-renderer.tsx`; aim for about 25-40 lines):
  - Make `refreshAppProvidedTools` (:2290-2400) delegate to shared discovery.
    Derive the initial candidate from
    `bridge.getAppCapabilities()` and `mcpAppsCapabilitiesRef.current` (:2658).
    Don't read the `effectiveMcpAppsCapabilities` closure, which goes stale
    inside `registerBridgeHandlers` (deps :3866-3874).
    - Return early on `null`; otherwise use the selected source for this mount
      or perform initial discovery with the narrowly defined -32601 fallback.
    - For webmcp: list one page with `listViewWebmcpTools`.
    - **If a WebMCP list is empty, unregister and don't register.** Retain the
      selected source in discovery state so subsequent change events re-list.
      Otherwise call `registerInstance({…, toolSource})` (:2366) with the
      source that actually succeeded, including fallback results.
  - `onAppInitialized` (:3485): replace the `appCaps?.tools` guard with "initial
    candidate is not null", then let shared discovery select the source.
  - Interceptor (:3984-3993): call refresh for `notifications/tools/list_changed`
    or `isSandboxToolsChanged(method)`. Pass the event kind into shared
    discovery; it filters against the selected source and coalesces events
    arriving during initial discovery. Reset selection on a new mount and
    clear stale state on teardown/channel closure.
  - Pass `webmcpTools={mcpAppsCapabilities.webmcpTools === true}` to
    `SandboxedIframe`.
  - Fullscreen auto-promote for WebMCP (fire once after the first non-empty
    registration) only if it fits the budget; otherwise list it as a
    follow-up. Legacy auto-promote stays unchanged.
- **Modal** (`mcp-apps-modal.tsx`, 526 lines):
  - Add a `webmcpTools: boolean` prop to `McpAppsModalProps` (:28-120); the
    modal has no capabilities prop today. Pass it to its iframe.
  - Swap its `appCaps?.tools` check (:330-341) for the initial candidate, and
    extend its interceptor (:387-399) through the same discovery module. The
    modal supplies its bridge, mount identity and iframe accessor, with no
    separate source-selection or retry implementation.
- **Dispatch sites:** replace `entry.bridge.callTool` with
  `dispatchAppToolCall`, keeping the race, scrub, record and output code:
  - `client/src/hooks/use-chat-session.ts:4284`
  - `client/src/components/ui-playground/hooks/useToolExecution.ts:659`
- **Tests:**
  - Registry: `toolSource` round-trips.
  - `useToolExecution.app-routing.test.ts`: a webmcp instance dispatches through
    the request path.
  - Chat and Playground both exercise `dispatchAppToolCall`; neither contains
    its own WebMCP/legacy branch. Inline and modal use the same discovery
    contract suite, including source reset, late replies and empty-list state.
  - Retain S0's actual pinned prototype-wrapper fixture with and without the
    leftover `tools` capability; a mocked v3-shaped object is insufficient.
  - Cover QA-07 through QA-12 with shared two-instance fixtures: identical tool
    names, mixed sources/mounts, independent teardown, modal handoff, concurrent
    calls and chat-session isolation. Assert the resulting app state as well
    as the tool output; a correctly shaped result alone cannot prove routing.
  - Renderer (the bridge mock gains `request` and `getAppCapabilities`):
    - lists on init when `webmcpTools` is set and the app has no `tools`;
    - re-lists on `sandbox-tools-changed`;
    - a legacy view ignores `sandbox-tools-changed`;
    - an empty list doesn't register;
    - no WebMCP listing when the capability is unset; legacy still works;
    - after initial -32601 fallback, WebMCP events refresh the view and dispatch
      uses WebMCP, even though the advertised app capabilities still say tools.
- **Docs:** add a "Tools through WebMCP" section to `docs/inspector/clients.mdx`
  (or `playground.mdx`). Cover the supported API subset, default-off clients,
  bounded text/structured results and the prototype-wrapper migration case.
  Do not claim ChatGPT app-view support from its browser site-tools feature.
- **Changesets:** `@mcpjam/sdk`, `@mcpjam/widget-react` and
  `@mcpjam/inspector` (minor).

### PR 4 — per-client toggle in the Apps settings (after PR 3; release gated on BE-1 in prod)

- `client/src/lib/apps-capability-dimensions.ts:28-107`: add a `webmcpTools`
  row, labeled something like "Tools through WebMCP". Use the `ui-copy` skill
  for the wording.
- `AppsExtensionTab.tsx:584-602`: add `webmcpTools` to the boolean keys the
  JSON editor keeps. It drops unknown keys silently today.
- Writes go to `mcpAppsOverrides` through `setBooleanOverride` /
  `enableSingleDimensionFromOff` (`AppsExtensionTab.tsx:1564-1712`), which is
  why prod needs BE-1 first.
- Tests: toggle on and off round-trips into the override; the JSON editor
  preserves the key.

## QA matrix and release gates

**All cells start as Not run.** This is a required verification plan, not a
claim that the feature or tests already exist. Record results in S0's report,
`mcpjam-inspector/docs/webmcp-app-tools-spike.md`, and extend that same report
through PR 3 and PR 4. Each result records QA ID, exact variant, commit/build,
browser/Electron version, fixture/upstream pin, command or manual steps,
expected/actual result, status and a test log or short recording. Keep access
tokens out of evidence.

Before changing the runtime, run the existing legacy suites and capture a
legacy browser baseline. Compare relevant protocol traffic, model-visible
output, alias identity and UI state after implementation. Exclude volatile
timestamps/request IDs from trace comparisons; do not normalize away routing,
method, payload, error or source differences. Record unrelated pre-existing
failures separately without relabeling a mandatory untested case as passing.

### Required coverage combinations

Fixture sources: **L** = current legacy App Tools, **W** = direct WebMCP,
**V** = pinned upstream v3 wrapper, **V+tools** = that wrapper with a leftover
explicit `tools: {}`. All use shared schemas/handlers. Two-app fixtures have
distinct visible board IDs and independent state, but intentionally identical
raw tool names and overlapping request IDs on their separate connections.
An app instance means a separate rendered app; its nested wrapper/app iframes
are one instance. Inline and modal copies of one parent tool call are the
separate active-surface case in QA-11.

| Coverage slice | Required combinations | Verification level |
|---|---|---|
| Source selection | L, W, V, V+tools × capability true, false, absent | Parameterized SDK/discovery tests; prove the real pinned wrapper in browser tests |
| Browser bridge | Chromium native WebMCP off; Chromium native on; Electron dev; packaged/minified Electron. For each: write, srcdoc and opaque mounts × all four sources with the feature on | Real-browser register/list/call smoke; S0 and integrated PR 3 evidence |
| Disabled bridge | Each runtime/mount above with L and W, feature false and absent | L retains its legacy path; W has no injected polyfill or advertised tools; native API presence is allowed |
| CSP | Declared/restrictive and permissive CSP × all three mount modes | Real-browser injection-order checks; include native-enabled Chromium and packaged Electron |
| Product paths | Chat and Playground × inline and modal × L, W, V, V+tools | Shared integration suite plus L/W user-flow smoke in web and packaged Electron |
| Multiple apps | L/L, W/W and L/W × write/write, opaque/opaque and write/opaque; repeat with reversed registration order | Deterministic routing suite; browser W/W and L/W with mixed mounts in Chat and Playground, in web and packaged Electron |
| Client settings | MCPJam default on; ChatGPT/Claude/Claude Code/Cursor/Codex/unknown default absent; explicit true/false overrides | Resolver tests, UI save/reload and backend round-trip tests; ChatGPT default changes require separate evidence |

Use parameterized tests and shared fixture adapters for these combinations.
Run the specified slices, rather than multiplying every unrelated dimension
into one exhaustive product. Keep existing checks for other supported browsers;
the table does not remove them or imply those browsers were newly verified.

### Behavior matrix

**A** = deterministic automated contract/component test. **B** = real-browser
test using the actual proxy and injected source. **U** = user-flow smoke with
visible state and recorded tool output. Every row is required at its named gate.

| ID | Scenario | Required result | Evidence / gate |
|---|---|---|---|
| QA-01 | Legacy start/list/call, list-changed and pagination with WebMCP on/off/absent | Same legacy methods, aliases, results and pagination semantics as baseline, including an empty-string cursor and the page cap. No new `ui/sandbox-*` traffic for a working legacy view. | A+B at S0 for relay behavior; A+B+U at PR 3 for integrated behavior |
| QA-02 | W, V and V+tools register and execute | One selected source. V+tools falls back only after initial -32601; tool runs once, updates the intended board and returns useful model-visible text. | A+B at S0; U at PR 3 |
| QA-03 | Empty legacy list, timeout, malformed list, other list error, or failed call | No accidental fallback, merged catalogs or cross-protocol invocation retry. Errors settle through existing error handling. | A+B at S0 and PR 3 |
| QA-04 | Capability false/absent and client switching | WebMCP exposure and injection are off, legacy still works, switching settings reloads the view and removes old WebMCP aliases. Native API presence alone does not fail the check. | A+B at S0 for disabled relay; A+B at PR 3 for presets/lifecycle |
| QA-05 | Write/srcdoc/opaque with native WebMCP on/off | Correct tools list and execute in every required combination; opaque mode does not depend on `contentDocument`; the expected polyfill is installed before app scripts when enabled. | B at S0 and PR 3 |
| QA-06 | Restrictive/permissive CSP and packaged injection | Polyfill and shared helpers run before app CSP as designed, both placeholders are replaced, and undeclared app resource access remains blocked under restrictive CSP. Minification does not break execution. | A+B at S0 and PR 2; packaging evidence at PR 3 |
| QA-07 | Two W apps expose the same `make_move` name | Distinct model-facing aliases resolve to the correct instances. Calling board A changes only A; B's state and result stream remain unchanged. Repeat targeting B. | A+B+U at PR 3 |
| QA-08 | L/L and L/W apps coexist; mixed mount modes and registration orders | Each instance keeps its own protocol and tool set. Refreshing one source cannot clear or replace the other; registration order does not decide which board receives a call. | A+B at PR 3 |
| QA-09 | Concurrent calls to A and B, replies deliberately out of order, overlapping connection-local IDs | Each result completes exactly its own request. No broadcast, swapped result, double completion or incorrect busy indicator. | A+B at PR 3 |
| QA-10 | Close, reload, remount or cancel A while B is idle or executing | Only A's affected requests/tools are cleaned up. B keeps its aliases, state, active status and pending calls. Old A replies cannot attach to the new mount. | A+B at PR 3 |
| QA-11 | Inline → modal → inline for the same app, with an inline call already pending | One active provider is advertised per parent tool call. Opening the modal does not itself abort the still-mounted inline call; its result stays attached to its original invocation. Closing the modal restores inline routing without duplicate tools. | A+B+U at PR 3 |
| QA-12 | Identical tools in different chat sessions, workspaces or Playground lanes | Each snapshot and dispatch sees only its owning scope. Switching or disposing one scope cannot route a call into another or remove its tools. | A plus browser scope-switch smoke at PR 3 |
| QA-13 | Cancellation, never-settling handler, timeout and teardown during list/call | WebMCP signal reaches the handler when its frame is alive; caller settles even if the handler ignores cancellation. Pending state clears, late replies are ignored, and side effects are never retried automatically. Legacy behavior matches baseline. | A+B at S0 for relay; A+B at PR 3 for registry/turn completion |
| QA-14 | Write reload, opaque self-navigation and fresh host mount | Write reload re-discovers tools; opaque self-navigation closes the channel and invalidates tools/calls; a fresh host mount recovers. Discovery state resets and stale lists cannot re-register old tools. | A+B at S0 and PR 3 |
| QA-15 | Empty WebMCP list, late registration, unregister/re-register, change-event burst | Empty views hold no registry slot but can later discover tools. The final tool set is current, notifications are bounded, and events during discovery are not lost. | A+B at S0 and PR 3 |
| QA-16 | Wrong-frame messages, unexpected/replayed IDs and old-mount responses | Source, request and mount checks reject the message without settling another call or changing another app's tools. Include a sibling frame sending an otherwise valid-looking reply. | A+B at S0 and PR 3 |
| QA-17 | Invalid tool name/description/schema and excessive tool count/schema size | Invalid descriptors are rejected without rewriting an incompatible schema into a different contract; existing registry limits still hold and other valid tools remain usable. | A at PR 2/3; browser malformed-descriptor smoke at PR 3 |
| QA-18 | Strings/objects/primitives, Unicode, escaped text, boundary sizes, oversized structured content, cycles, BigInt and encoding/clone failures | Model gets useful text for valid results. Entire result stays within the UTF-8 byte budget, including both copies. Failures settle with a bounded error, retain no original oversized payload and do not rerun the handler. | A+B at S0/PR 2; model-output integration at PR 3 |
| QA-19 | Existing app rendering and ordinary host bridge operations | Initial tool input/output, model-context updates, resize/display modes, server-tool calls, debug attribution and legacy auto-promotion match baseline; app/page/server tool routing and approval semantics remain distinct. | Existing A suites plus targeted L/W U smoke at PR 3 |
| QA-20 | Local/hosted sandbox delivery and production bundles | Both serving paths replace placeholders and deliver the same helper/polyfill contract. The packaged desktop uses the tested source and passes core discovery/call/routing checks. | Existing route A suites at PR 2; B at S0 and PR 3 |
| QA-21 | Toggle and JSON editor save/reload, backend canonicalization/hash | Explicit true/false survives editing, saving and reloading; absent remains absent. Disabling removes exposure and re-enabling recovers it. Invalid types are rejected; BE-1 is deployed before production settings release. | A+B+U at BE-1/PR 4 |

### Test ownership, evidence and gates

Extend existing suites and share fixtures instead of building a second test
framework. Current test anchors (paths relative to the inspector repo root):

- `mcpjam-inspector/client/src/components/chat-v2/thread/mcp-apps/__tests__/app-tools-registry.test.ts`
- `mcpjam-inspector/client/src/components/chat-v2/thread/mcp-apps/__tests__/mcp-apps-renderer.test.tsx`
- `mcpjam-inspector/client/src/components/chat-v2/thread/mcp-apps/__tests__/app-tools-sanitizer.test.ts`
- `mcpjam-inspector/client/src/components/ui-playground/hooks/__tests__/useToolExecution.app-routing.test.ts`
- `widget-react/src/__tests__/sandboxed-iframe-reload.test.tsx`
- `widget-react/src/__tests__/mcp-apps-modal-csp.test.tsx`
- `mcpjam-inspector/server/__tests__/sandbox-proxy-mount.test.ts`

Add focused SDK/wire/discovery tests beside the new modules. Browser fixtures
must use the shipped source, and the real pinned v3 wrapper, rather than mocks
that reproduce the proposed implementation. For routing assertions, invoke
known aliases deterministically and inspect both boards; an LLM choosing the
correct board once is not proof of isolation.

- **S0 gate:** all S0-marked portions and required runtime/mount combinations
  pass before broad implementation. Relay-only evidence does not satisfy
  registry, Chat, Playground or modal cases that arrive in PR 3.
- **PR 2 gate:** wire/security/CSP/serving rows pass with the exact rendered
  artifacts. Preserve S0 evidence unless a relevant input changed.
- **PR 3 gate:** QA-01 through QA-20 pass at their integrated level before
  merging the host integration or releasing core support. Include both Chat
  and Playground, two independent apps, modal handoff and packaged Electron.
- **PR 4 gate:** QA-21 passes against the target backend. Recheck the affected
  disabled/enabled, reload and routing cases; carry forward other results only
  when their relevant inputs are unchanged. Confirm BE-1 is on production
  before the production release containing the settings UI.
- A mandatory failed, blocked or Not run cell blocks its applicable gate.
  Track status per required variant; a single passing example cannot stand in
  for an entire row. A proposed scope reduction must be explicitly reflected
  in this plan and its release claims, never hidden as a passing cell.

For U evidence, serve the chess fixture at `http://localhost:3001/mcp`, run
`npm run dev:worktree -w @mcpjam/inspector -- <N> --no-worker`, and use the
printed private access link. Capture the four app-tool badges, a successful
move and its model-visible board text, then the two-board and modal scenarios.
Run Electron from the repo root with
`npm run electron:dev -w @mcpjam/inspector` and repeat the applicable checks in
the packaged build using S0's recorded packaging command. Record actual
versions and artifact identity; never mark a development run as packaged QA.

## Upstream follow-ups (Marcelo to post; outward-facing)

Comment on the ext-apps issue and PR:
1. A host (MCPJam) already ships App Tools, which corrects the issue's "no host
   implemented app tools yet".
2. Share S0's measured native-versus-injected behavior, including browser
   versions and permissions, before recommending native shadowing to other
   hosts. Do not present an untested compatibility assumption as a finding.
3. Opaque mounts (Claude-style, no `allow-same-origin`) break a relay that
   reads `contentDocument`; a postMessage channel in the polyfill avoids that.
4. `{content: []}` results are invisible to the model in hosts that, per
   SEP-1865, send the model only `content`, so recommend a text block.

## Known trade-offs

- In the Playground, a client policy that shows `structuredContent` to the
  model (`useToolExecution.ts:174-215`) shows the JSON twice, as text and as
  structured content. Chat sends text only. Both copies count toward the same
  result limit; accept the duplication only within that bound.
- A view that bundles its own polyfill and overwrites `document.modelContext`
  gives zero tools. `replaced: true` surfaces it as a host debug-log event.
- ChatGPT's built-in-browser WebMCP support does not establish MCP App iframe
  support. Its preset remains unchanged until evidence for the actual app-view
  surface is available; explicit overrides remain supported after BE-1/PR 4.
- Upstream #798 is a prototype. Pin the version used for fixtures and record
  local adaptations. Keep the public boundary small so shared upstream code
  can replace the local adapter when its transport and lifecycle meet our needs.
