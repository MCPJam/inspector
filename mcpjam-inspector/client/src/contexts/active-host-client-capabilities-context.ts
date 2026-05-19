import { createContext, useContext } from "react";

/**
 * Per-scope active `clientCapabilities` blob from the active host config.
 *
 * Mirrors {@link ActiveMcpProfileContext} /
 * {@link ChatboxHostCapabilitiesOverrideContext}: a single Provider sets the
 * value for whatever scope owns the host config (chatbox, eval suite, direct
 * chat). Downstream consumers read via {@link useActiveHostClientCapabilities}.
 *
 * **Important — this is `clientCapabilities`, not `hostCapabilities`:**
 *   - `clientCapabilities` is what the MCP client (the host) advertises to
 *     the SERVER in the base-protocol `initialize` exchange. The MCP UI
 *     extension lives here under `extensions["io.modelcontextprotocol/ui"]`.
 *   - `hostCapabilities` (handled by
 *     {@link ChatboxHostCapabilitiesOverrideProvider}) is what the host
 *     advertises to WIDGETS via the MCP Apps `ui/initialize` response.
 *
 * The render gate in `PartSwitch` / `WidgetReplay` uses this context to
 * decide whether to render a widget iframe for a tool that declares UI
 * metadata. Hosts that don't advertise the MCP UI extension (e.g. Codex,
 * which is elicitation-only) drop to the plain `ToolPart` result row.
 *
 * `undefined` (the default) means "no host config in scope" — preserves
 * historical behavior for surfaces without an `activeHost` by allowing
 * the render decision to fall through to the legacy tool-metadata-only
 * check. See `hostSupportsWidgetRendering` in `lib/host-capabilities.ts`.
 */
const ActiveHostClientCapabilitiesContext = createContext<
  Record<string, unknown> | undefined
>(undefined);

export const ActiveHostClientCapabilitiesProvider =
  ActiveHostClientCapabilitiesContext.Provider;

export function useActiveHostClientCapabilities():
  | Record<string, unknown>
  | undefined {
  return useContext(ActiveHostClientCapabilitiesContext);
}
