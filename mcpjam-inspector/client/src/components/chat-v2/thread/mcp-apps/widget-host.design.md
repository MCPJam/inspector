# Tier B — interactive widget runtime extraction (`WidgetHost`)

Status: **Phase 0 (design)** — `widget-host.ts` lands the contract only; nothing
consumes it yet and there is no behavior change.

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
| `readResource` / `listResources` / `listPrompts` | MCP transport | `services.*` |
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
  services: WidgetHostServices;          // fetchWidgetContent + readResource/listResources/listPrompts
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

## Phased plan

| Phase | What | Risk |
| --- | --- | --- |
| **0** (this) | `WidgetHost` contract + this doc. No behavior change. | low |
| **1** | In-place DI refactor: land `WidgetHostProvider` + `useWidgetHost`; migrate services → environment → surface → debug reads; renderer imports zero `@/stores`/`@/contexts`. Run the Tier-B guard against it *before* moving. | med |
| **2** | Extract the framework-free core (`host-app-bridge`, transports, `iframe-sandbox-policy`, reconciled `mcp-apps-utils`). | low–med |
| **3** | Relocate the React renderer into the package; inspector becomes a thin `WidgetHost` adapter; add a Tier-B import guard. | med |
| **4** | Wire the package's `renderWidget` seam; optionally collapse the inspector's parallel `PartSwitch`. Unblocks the eval trace viewer (Option B). | med |

## Package shape (open decision)

Recommended: a new **`@mcpjam/widget-react`** package (heavy
`@modelcontextprotocol/ext-apps` + `@mcp-ui/client` deps), depending on
`@mcpjam/sdk` for the policy/compat core, consumed by the inspector via the
`renderWidget` seam. `@mcpjam/chat-ui` stays the lean Tier-A renderer and never
imports it. Alternative considered: a `@mcpjam/chat-ui/widget` subpath — rejected
because it would force Tier A consumers to risk pulling the heavy widget peer
deps and would require a carve-out in the Tier-A import guard.
