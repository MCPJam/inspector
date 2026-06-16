---
"@mcpjam/inspector": patch
---

Tier B Phase 3d-i-b: complete the `WidgetHost` contract fold-in into
`@mcpjam/widget-react`, closing the temporary two-`WidgetHost` gap.

The remaining slices — `environment` (raw ambient inputs), `resolvers` (bound
config/style fns), `services` (widget-content fetch + MCP transport), and the
result/profile shapes — now live in the package, and **`WidgetHost` itself** is
package-owned. The inspector's `widget-host.ts` becomes a **pure re-export shim**
(no local contract), keeping only the two inspector-sourced value re-exports
(`extractMethod`, `stableStringifyJson`) until they relocate with the renderer in
3d-ii.

Typing follows the audited renderer usage rather than deep-replicating the
inspector profile graph:
- `ResolvedHostStyle` is a minimal structural surface (only the fields the
  renderer reads); the real `HostStyleDefinition` is assignable to it.
- ext-apps types (`McpUiHostContext`/`McpUiHostCapabilities`/`McpUiResourceCsp`/
  `McpUiResourcePermissions`/`McpUiStyles`) are imported from
  `@modelcontextprotocol/ext-apps`; `MCPPrompt`/`MCPResourceTemplate` from
  `@mcpjam/sdk/browser`.
- `HostConfigMcpProfileV1` is imported from `@mcpjam/sdk/host-config/internal`
  (resolver↔adapter contravariance requires the real profile type). This is the
  one intentional SDK-internal ref in the surface; hiding it behind the
  `resolveEnvironment` fold is deferred to the publish-ready pass (3d-iii) while
  the package is still private.

`@mcpjam/widget-react` gains `@mcpjam/sdk` + `@modelcontextprotocol/ext-apps` as
deps (externalized in tsup; the emitted `.d.ts` references them as external imports
only — nothing inlined). Drift-safety holds: `use-widget-host.ts` builds the host
from the real stores/resolvers and returns it typed as the package contract, so
any drift fails typecheck. No behavior change.
