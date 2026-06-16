---
"@mcpjam/inspector": patch
---

Tier B Phase 3d-ii-a: relocate the pure detection/parsing utilities into
`@mcpjam/widget-react`.

`tool-result-utils` (result `_meta`/`_serverId` readers) and the `mcp-apps-utils`
UI-type detection core (`UIType`, `detectUIType`, `detectUiTypeFromTool`,
`getUIResourceUri`, + the SEP-1865 tool-visibility re-exports) now live in the
package. The inspector modules become re-export shims so every existing
`@/lib/tool-result-utils` / `@/lib/mcp-ui/mcp-apps-utils` import site is
unchanged; the `ListToolsResultWithMetadata`-typed `isMCPApp`/`isOpenAIApp`/
`isOpenAIAppAndMCPApp` helpers stay in the inspector (they need an inspector api
type).

The package gains `@mcp-ui/client` + `@modelcontextprotocol/client` deps
(externalized in tsup; dts references them as external imports only). First step
of the renderer/cluster relocation (3d-ii). No behavior change.
