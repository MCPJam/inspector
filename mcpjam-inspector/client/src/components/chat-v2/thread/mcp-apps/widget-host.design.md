# Tier B — interactive widget runtime extraction (`WidgetHost`)

Status: **Phases 0–2 merged** (for inspector-internal consumption); **Phase 3 in
progress**. The `WidgetHost` contract + `useWidgetHost()` hook (Phases 0–1) and
the framework-free core in `@mcpjam/sdk/widget-runtime` (Phase 2) are landed; the
React renderer relocation into `@mcpjam/widget-react` is underway. npm-publishing
the SDK `widget-runtime` surface still needs a public-surface pass (see
"Pre-publish").

This is the follow-on to the Tier A extraction (`@mcpjam/chat-ui`, the read-only
transcript renderer). Tier A renders a **placeholder** for widget-bearing tool
calls via the `renderWidget` seam. Tier B is the renderer that *satisfies* that
seam — the interactive MCP-Apps / OpenAI-Apps widget runtime.

## Why a boundary first (not a file move)

The same lesson as Tier A: **don't move files first — invert dependencies in
place first.** The widget runtime is ~7,000+ LOC and `mcp-apps-renderer.tsx`
alone is ~3,866 lines, reaching into **~14 ambient inspector sources** (6
zustand stores, 6 React contexts, 2 resolver modules). A lift-and-shift is not
viable; a dependency inversion is.

> Phase 1 is not "move the renderer." Phase 1 is "turn the renderer's
> store/context reads into an injected `WidgetHost`, in place,
> behavior-preserving." Only once the renderer imports zero `@/stores` /
> `@/contexts` do we relocate it behind the existing `renderWidget` seam.

## The seam already exists

`@mcpjam/chat-ui` already exposes the host seam the runtime plugs into:

```ts
renderWidget?(input: WidgetRenderInput): ReactNode   // absent → WidgetPlaceholder
```

Today only `ReadOnlyTranscript` (ShareUsageThreadDetail) goes through the
package; the live chat still uses the **inspector's own** `PartSwitch`, which
renders `ToolPart` + `WidgetReplay` as siblings. Tier B doesn't need a new
contract — it needs a renderer that satisfies this one, plus a `WidgetHost` to
feed that renderer the inspector state it currently reads ambiently.

## What couples the runtime today

`mcp-apps-renderer.tsx` reads, ambiently:

| Source | Examples | Becomes |
| --- | --- | --- |
| `usePreferencesStore` | `themeMode`, `hostStyle` | `env.theme` / `env.hostStyle` |
| `useUIPlaygroundStore` | `mcpAppsCspMode` | `surface.playgroundCspMode` (an **input** — effective CSP mode is derived in the renderer from `surface.kind` + per-widget `minimalMode`; see L741-746) |
| `useUIPlaygroundStore` | locale, timeZone, displayMode, capabilities, safeArea, deviceType, isPlaygroundActive | `env.baseHostContext` |
| `useActiveMcpProfile` | active profile → capability/sandbox/compat resolution | `env.*` (resolved by inspector) |
| `useHostContextStore` | `draftHostContext` | `env.baseHostContext` |
| `useChatboxHost{Style,Theme}` + `…CapabilitiesOverride` | per-chatbox overrides | `env.*` |
| `useIsChatboxSurface` / `useWidgetSurface` | surface identity | `surface.kind` |
| `useWebManagedServers` | hosted endpoint routing | `surface.webManagedServers` |
| `usePersistentWidgetSurfaceHost` | persistent surface flag | `surface.persistentSurfaceHost` |
| `useWidgetDebugStore` (11 setters) | lifecycle / CSP / globals instrumentation | `debug` (1:1 sink) |
| `useTrafficLogStore.addLog` | JSON-RPC traffic | `debug.addTrafficLog` |
| `resolveEffective{HostCapabilities,McpAppsCapabilities,CompatRuntime}`, `resolveHostInfo` (client-config-v2) | capability/compat resolution | `env.*` (inspector calls them) |
| `fetchMcpAppsWidgetContent` (authFetch + endpoint + HOSTED_MODE) | widget HTML | `services.fetchWidgetContent` |
| `readResource` / `listResources` / `listPrompts` / `listResourceTemplates` | MCP transport (templates are local-only — throw in hosted/web-managed) | `services.*` |
| `SANDBOX_ORIGIN` (@/lib/config) | sandbox proxy origin | `surface.sandboxOrigin` |

Per-widget props (`MCPAppsRendererProps`, `WidgetReplayProps` — `toolCallId`,
`toolOutput`, `onCallTool`, `onRequest{Pip,Fullscreen}`, `renderOverride`, …)
are **already explicit** and untouched. The DI work is only the 14 ambient
reads above.

## Four buckets (scoping)

1. **MOVES into the package** (runtime-owned, just needs de-`@/`-ing):
   `mcp-apps-renderer`, `sandboxed-iframe` + `iframe-sandbox-policy`,
   `host-app-bridge`, `mcp-apps-logging-transport`, `app-tools-registry`,
   `widget-surface-store`/`-host` (zustand stays *internal* to the package),
   `useToolInputStreaming`, `widget-file-messages`, `widget-replay` (→ the
   package's `renderWidget` factory). Reconcile `mcp-apps-utils` against
   chat-ui's existing `widget-detection`.
2. **INJECTED via `WidgetHost`** (inspector-app state/services): the 14 ambient
   reads → `resolveEnvironment` + `services` + `surface` + `debug`; plus the
   modal chrome via `components.Modal`.
3. **STAYS in the inspector** (out of scope): the zustand **store
   definitions**; the **profile system** (`client-config-v2`, `client-styles`);
   the **context providers** (active-mcp-profile, chatbox-\*,
   web-managed-servers); and `checkout-dialog-v2` (billing / app-specific —
   explicitly excluded).
4. **REUSED from `@mcpjam/sdk`** (already shared — no work):
   `resolveSandboxCsp` / `resolveSandboxPermissions`, `host-config`,
   `widget-helpers`, the compat runtimes (`@mcpjam/sdk/browser`).

## The contract

See `widget-host.ts`. Summary:

```ts
interface WidgetHost {
  resolveEnvironment(serverId: string | undefined): WidgetHostEnvironment; // per-server
  services: WidgetHostServices;          // fetchWidgetContent + readResource/listResources/listPrompts/listResourceTemplates
  surface: WidgetSurfaceInfo;            // kind, persistentSurfaceHost, webManagedServers, sandboxOrigin
  debug?: WidgetDebugSink;               // 1:1 with widget-debug-store + traffic-log addLog
  components?: { Modal?: ComponentType<WidgetModalProps> };
}
```

The contract is anchored to real inspector signatures via
`typeof import(...)` / named result types, so it fails typecheck if a source
shape drifts before the migration catches up.

## How the inspector satisfies it

One `<WidgetHostProvider>` at the thread/chat root, built from the stores and
contexts it *already* reads — `resolveEnvironment` calls the existing
`resolveEffective*` helpers; `services` binds the existing api modules; `debug`
forwards to the existing zustand stores 1:1. The renderer swaps its ~14 hook
reads for a single `useWidgetHost()`.

## Risks / notes

- **Behavior preservation:** `debug` is a 1:1 sink (12 callbacks) specifically
  so Phase 1 is a pure refactor — consolidation is a separate, later change.
- **Reactivity / perf:** today each playground field is a fine-grained zustand
  selector; a single provider subscribing to all of them broadens the
  re-render to the widget subtree. Acceptable, and memoizable — but worth a
  perf check in Phase 1 since the renderer is hot.
- **`resolveEnvironment` must stay cheap/pure** (runs during render, per
  server); the inspector memoizes per `serverId`.
- **`sandboxOrigin`** is the one true env/build coupling in the sandbox path;
  it becomes `surface.sandboxOrigin` instead of a module-level import.
- **CSP mode is derived, not passthrough.** The effective sandbox CSP mode is
  `f(surface.kind, per-widget minimalMode, playground mcpAppsCspMode)`
  (mcp-apps-renderer.tsx:741-746). The contract exposes the input
  (`surface.playgroundCspMode`) and the renderer keeps the derivation, so
  Phase 1 stays behavior-preserving — including sourcing the surface from
  context (not `isPlaygroundActive`) to preserve the first-render
  iframe-rebuild fix (L729-739). `minimalMode` being per-instance is why CSP
  mode is not on the per-server `env`.
- **Surface collapse:** `kind` merges two distinct context signals
  (`useIsChatboxSurface`, `useWidgetSurface`); Phase 1 must confirm they are
  mutually exclusive before collapsing them.
- **`listResourceTemplates` is host-owned, not the raw api fn.** The renderer
  guards `HOSTED_MODE || webManagedServers` (mcp-apps-renderer.tsx:2861-2868),
  but `mcp-resource-templates-api.listResourceTemplates` only enforces
  `HOSTED_MODE`. The provider MUST wrap it and throw when
  `surface.webManagedServers` is true — Phase 1 must not bind the raw fn
  directly, or web-managed surfaces would drift.

## Phased plan

| Phase | What | Status |
| --- | --- | --- |
| **0** | `WidgetHost` contract + this doc. | ✅ merged |
| **1** | In-place DI refactor. **Shipped as a composite `useWidgetHost()` hook (not a provider)** with an `environment`/`resolvers` split; `resolveEnvironment` deferred. Renderer imports zero `@/stores`/`@/contexts` (Tier-B guard enforced). | ✅ merged |
| **2** | Framework-free core relocated to **`@mcpjam/sdk/widget-runtime`** (not the React package): tool-visibility, LoggingTransport, iframe-sandbox-policy, host-app-bridge, app-tool-invocation types. Inspector consumes via shims. | ✅ merged (internal); needs a pre-publish public-surface pass |
| **3** | Relocate the React renderer into a new **`@mcpjam/widget-react`** package; inspector becomes a thin adapter; add the package's Tier-B guard. Sliced 3a–3d below. | 🚧 in progress |
| **4** | Wire the package's `renderWidget` seam; optionally collapse the inspector's parallel `PartSwitch`. Unblocks the eval trace viewer. | later |

### Phase 3 slices

| Slice | What | Risk |
| --- | --- | --- |
| **3a** | Finish the in-place DI: invert the **modal** — the last app-state island (it builds its own AppBridge and read `useActiveMcpProfile`/`useWebManagedServers`/`resolveHostInfo`). Resolved `hostInfo`/`webManagedServers` now flow down as props. | med |
| **3b** ✅ | Invert the remaining app-state islands + lock the guard. `widget-replay` host-support gate → injected `resolveHostSupportsWidget` prop (PartSwitch, which already owns the identical gate, binds it — preserves WidgetReplay's `serverId` semantics without `@/contexts` / `@/lib/host-capabilities`, and matches the 3d seam: inspector owns host policy, package component applies it). `app-tools-registry` traffic logging → injected `addTrafficLog` callback supplied by the chat/playground dispatch hooks (registry drops `@/stores`). `useToolInputStreaming` / `widget-replay` type-only imports → contract module. Tier-B guard extended to 7 cluster files. | low–med |
| **3c** | Scaffold `@mcpjam/widget-react` and prove the **full** integration contract: source alias, build order, package guard, CSS/runtime imports, and a tiny inspector consumer through the same provider/adapter path the bulk move will use. | low |
| **3d** | Relocate the renderer + cluster into the package; the package owns the `WidgetHost` React context + `useWidgetHost()` *contract* while the inspector supplies the concrete host via a **provider/adapter**; inject the modal chrome + `checkout-dialog` via `components.Modal` (drops `@mcpjam/design-system` from the modal); move the deferred service/config couplings onto `services`/`surface` — `widget-file-messages` `authFetch`, the `SANDBOX_ORIGIN`/`HOSTED_MODE` consts, and `sandboxed-iframe`'s `@/lib/client-config` — so the modal + sandboxed-iframe can join the guard; fold `environment`+`resolvers` into a real `resolveEnvironment`; inspector files become shims. | med |

## Package shape (decided)

A new **`@mcpjam/widget-react`** package (heavy `@modelcontextprotocol/ext-apps`
+ `@mcp-ui/client` deps), depending on `@mcpjam/sdk` (widget-runtime + browser)
for the policy/compat core, consumed by the inspector via the `renderWidget`
seam. `@mcpjam/chat-ui` stays the lean Tier-A renderer and never imports it — its
Tier-A guard forbids `ext-apps`/`@mcp-ui/client`/`sandboxed-iframe`/
`design-system`, so the renderer cannot live there. Build mirrors chat-ui:
ESM/tsup, `moduleResolution: bundler`, source-aliased into the inspector; build
order `sdk → chat-ui → widget-react → inspector`. (Alternative considered: a
`@mcpjam/chat-ui/widget` subpath — rejected: it would force Tier-A consumers to
risk the heavy peer deps and need a carve-out in the Tier-A guard.)

Decisions locked for Phase 3:
- **`useWidgetHost()` ownership:** the package owns the `WidgetHost` React
  context + `useWidgetHost()` *contract*; the inspector supplies the concrete
  host via a provider/adapter (keeping the `@/stores`/`@/contexts` reads). This
  is where the Phase-1 "hook, not provider" choice flips — with a package
  boundary, the relocated renderer reads from the package's context.
- **Peer deps:** `react`/`react-dom` are peers. Do **not** copy chat-ui's
  `ai`/`@ai-sdk/react` peers blindly — audit for a real runtime import and
  prefer package-local/structural types otherwise.
- **Modal seam:** the package owns widget lifecycle + bridge; `components.Modal`
  receives children/state/callbacks only — the inspector keeps the portal/chrome
  (`design-system` dialog), billing, and `checkout-dialog`.
- **detectUIType:** verify the inspector's `MCP_UI` inline-resource branch
  matches chat-ui's pure detector, then share chat-ui's `UIType` vocabulary;
  defer collapsing the inspector's parallel `PartSwitch` to Phase 4.

## Pre-publish (separate from Phase 3 implementation)

Phases 0–2 are merged for **inspector-internal** consumption. Publishing
`@mcpjam/sdk/widget-runtime` to npm still needs a public-surface pass: the barrel
imports `AppBridge` from `@modelcontextprotocol/ext-apps`, so the whole subpath
requires `skipLibCheck:true` for NodeNext consumers. Fix by splitting the bridge
into a narrower subpath (e.g. `@mcpjam/sdk/widget-runtime/host-bridge`) or hiding
`AppBridge` behind a structural interface — settled **before** `@mcpjam/widget-react`
bakes in its final SDK import paths for publish.
