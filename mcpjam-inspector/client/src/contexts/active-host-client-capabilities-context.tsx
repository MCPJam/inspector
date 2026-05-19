import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";

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

/**
 * Convenience wrapper that resolves the active host's `clientCapabilities`
 * and provides it to the context. Falls back to the template seed for the
 * given `hostStyle` when no persisted `activeHost` is in scope — without
 * this, prefs-only surfaces (no Convex `activeHost` hydrated) would leave
 * the gate reading the legacy-preservation default and silently re-enable
 * widget rendering for hosts whose template strips the MCP UI extension
 * (Codex).
 *
 * Use this at the outer chat surface root (analog to
 * `ChatboxHostStyleProvider`). Apply once per surface; nested scopes are
 * fine — React context picks the closest provider.
 */
export function ActiveHostClientCapabilitiesScope({
  activeHost,
  hostStyle,
  children,
}: {
  activeHost?: HostConfigDtoV2 | null;
  hostStyle: string;
  children: ReactNode;
}) {
  const value = useMemo(() => {
    if (activeHost?.clientCapabilities) return activeHost.clientCapabilities;
    return seedFromHostTemplate(hostStyle as HostTemplateId).clientCapabilities;
  }, [activeHost?.clientCapabilities, hostStyle]);
  return (
    <ActiveHostClientCapabilitiesProvider value={value}>
      {children}
    </ActiveHostClientCapabilitiesProvider>
  );
}
