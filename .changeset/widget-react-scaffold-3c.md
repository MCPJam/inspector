---
"@mcpjam/inspector": patch
---

Tier B Phase 3c: scaffold the `@mcpjam/widget-react` package and prove the
integration contract the renderer relocation (3d) will use.

The new package owns the `WidgetHost` React context + `useWidgetHost()` hook
contract; the inspector keeps its concrete `use-widget-host` adapter and will
feed it through `<WidgetHostProvider>`. This slice wires the boundary end to end
without moving the renderer:

- New workspace `@mcpjam/widget-react` (ESM/tsup, `moduleResolution: bundler`,
  **react/react-dom-only peers** — audited: the widget cluster imports no
  `ai`/`@ai-sdk/react`), with its own Tier-B import guard and a `styles.css`
  export pipeline. Marked `private` until the renderer lands and a publish-ready
  surface pass is done.
- Build order (`sdk → chat-ui → widget-react → inspector`), root typecheck/test
  wiring, and inspector source aliases (client tsconfig paths + vite + vitest),
  mirroring the chat-ui/sdk pattern so a clean checkout never needs a
  widget-react build.
- A package-consumer **smoke test** in the inspector that imports through the
  same `@mcpjam/widget-react` alias and renders under the provider — catching
  cross-boundary wiring breakage before 3d.

No runtime/behavior change to the inspector.
