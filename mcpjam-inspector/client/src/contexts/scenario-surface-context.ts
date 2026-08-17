import { createContext, useContext } from "react";

/**
 * Signals that the current React subtree is rendering a scenario surface —
 * the published scenario runtime (at `/scenario/<slug>/<token>`), the
 * inspector's Scenarios → Preview pane (which iframes the same runtime),
 * or the Scenarios → Sessions transcript view.
 *
 * Used by `mcp-apps-renderer` to default MCP-Apps CSP enforcement to
 * `"permissive"` for scenario surfaces (matching the Playground default)
 * instead of the strict `"widget-declared"` mode used elsewhere. Rationale:
 * scenarios are end-user-facing demo/preview surfaces where the friction
 * of an MCP server with an incomplete `_meta.ui.csp` declaration is worse
 * than the loss of host-side CSP enforcement. Users who need strict
 * enforcement can flip the host's `apps.sandbox.csp.mode` away from
 * `"relaxed"` — the host policy still wins when it's set.
 *
 * `false` (the default) preserves widget-declared behavior for every
 * non-scenario surface (Connect → Chat, eval suite editors, etc.).
 */
const ScenarioSurfaceContext = createContext<boolean>(false);

export const ScenarioSurfaceProvider = ScenarioSurfaceContext.Provider;

export function useIsScenarioSurface(): boolean {
  return useContext(ScenarioSurfaceContext);
}
