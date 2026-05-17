import { createContext, useContext } from "react";

/**
 * Signals that the current React subtree is rendering a chatbox surface —
 * the published chatbox runtime (at `/chatbox/<slug>/<token>`), the
 * inspector's Chatboxes → Preview pane (which iframes the same runtime),
 * or the Chatboxes → Sessions transcript view.
 *
 * Used by `mcp-apps-renderer` to default MCP-Apps CSP enforcement to
 * `"permissive"` for chatbox surfaces (matching the Playground default)
 * instead of the strict `"widget-declared"` mode used elsewhere. Rationale:
 * chatboxes are end-user-facing demo/preview surfaces where the friction
 * of an MCP server with an incomplete `_meta.ui.csp` declaration is worse
 * than the loss of host-side CSP enforcement. Users who need strict
 * enforcement can flip the host's `apps.sandbox.csp.mode` away from
 * `"relaxed"` — the host policy still wins when it's set.
 *
 * `false` (the default) preserves widget-declared behavior for every
 * non-chatbox surface (Connect → Chat, eval suite editors, etc.).
 */
const ChatboxSurfaceContext = createContext<boolean>(false);

export const ChatboxSurfaceProvider = ChatboxSurfaceContext.Provider;

export function useIsChatboxSurface(): boolean {
  return useContext(ChatboxSurfaceContext);
}
