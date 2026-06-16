---
"@mcpjam/inspector": patch
---

Tier B Phase 3d-i-a: relocate the data/chrome/instrumentation slices of the
`WidgetHost` contract into `@mcpjam/widget-react`.

The package now owns the `surface` (completed), `debug`, and `components` slices,
the primitives (`CspMode`, `DisplayMode`, `UiProtocol`, `OpenAiAppsCapabilities`),
and the debug data types (`WidgetDebugInfo`, `WidgetGlobals`, `WidgetSandboxInfo`,
`WidgetSandboxApplied`, `WidgetLifecycleEvent`, `WidgetMount`, `CspViolation`,
`UiLogEvent`) + `WidgetDebugSink` — defined structurally so the package stays
free of inspector internals. The inspector's `widget-host.ts` re-exports them, so
every existing `./widget-host` import site (the cluster + the `use-widget-host`
adapter) is unchanged.

Drift-safety is preserved: `use-widget-host.ts` builds the host from the real
stores and returns it typed as the package contract, so any source-shape drift
fails typecheck there (replacing the old `typeof import(...)` pins for these
slices).

The fn-heavy / profile-derived slices (`environment`, `resolvers`, `services`)
and the final `WidgetHost` move follow in 3d-i-b. No behavior change.
