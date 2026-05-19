import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";

/**
 * Resolver returning the effective `clientCapabilities` blob the render
 * gate should evaluate for a given tool, scoped to its server.
 *
 * Returning `undefined` means "no host config in scope" — preserves the
 * legacy `hostSupportsWidgetRendering(undefined) === true` behavior so
 * surfaces without a wrapping `ActiveHostCapsResolverScope` keep
 * rendering widgets (test fixtures, edge surfaces).
 *
 * In commit 1 of the per-server-gate refactor, the resolver ignores its
 * `serverId` argument and returns host-level capabilities only.
 * Commit 2 wires `appState.servers` and the per-server override path.
 */
export type ActiveHostCapsResolver = (
  serverId?: string
) => Record<string, unknown> | undefined;

const NO_OP_RESOLVER: ActiveHostCapsResolver = () => undefined;

/**
 * Per-scope resolver that returns the effective `clientCapabilities` for
 * the active host (and, after commit 2, the tool's server). Mirrors
 * {@link ActiveMcpProfileContext} / {@link ChatboxHostCapabilitiesOverrideContext}:
 * a single Provider sets the value for whatever scope owns the host
 * config (chatbox, eval suite, direct chat). Downstream readers call
 * {@link useActiveHostCapsResolver} and pass the tool's `serverId`.
 *
 * **`clientCapabilities` vs `hostCapabilities`:**
 *   - `clientCapabilities` is what the MCP client (the host) advertises
 *     to the SERVER in the base-protocol `initialize` exchange. The MCP
 *     UI extension lives here under
 *     `extensions["io.modelcontextprotocol/ui"]`.
 *   - `hostCapabilities` (handled by
 *     {@link ChatboxHostCapabilitiesOverrideProvider}) is what the host
 *     advertises to WIDGETS via the MCP Apps `ui/initialize` response.
 *
 * **Why a resolver and not a cached value:** the render gate must agree
 * with what `initialize` actually sent. `initialize` uses per-server
 * `resolveEffectiveClientCapabilities` from `lib/effective-client.ts`,
 * where a per-server override can strip or add the UI extension. Caching
 * host-level caps lets the renderer disagree with `initialize` for any
 * server with an override. Calling the same function at render time, with
 * the tool's `serverId`, keeps both sides in lockstep by construction.
 */
const ActiveHostCapsResolverContext =
  createContext<ActiveHostCapsResolver>(NO_OP_RESOLVER);

export const ActiveHostCapsResolverProvider =
  ActiveHostCapsResolverContext.Provider;

export function useActiveHostCapsResolver(): ActiveHostCapsResolver {
  return useContext(ActiveHostCapsResolverContext);
}

/**
 * Convenience wrapper that builds the resolver and provides it. Falls
 * back to the template seed for `hostStyle` when no persisted
 * `activeHost` is in scope — preserves the prefs-only / hosted-chatbox
 * paths today.
 *
 * Apply once per chat surface root (analog to `ChatboxHostStyleProvider`).
 *
 * **Commit 1 note:** this resolver ignores `serverId` and returns
 * host-level capabilities only. The shape change lands first, with no
 * new dependency on `appState.servers`, so this commit is functionally
 * equivalent to the previous cached-caps provider. Commit 2 changes the
 * resolver body to call `resolveEffectiveClientCapabilities` with the
 * tool's server config.
 */
export function ActiveHostCapsResolverScope({
  activeHost,
  hostStyle,
  children,
}: {
  activeHost?: HostConfigDtoV2 | null;
  hostStyle: string;
  children: ReactNode;
}) {
  const hostCaps = useMemo(() => {
    if (activeHost?.clientCapabilities) return activeHost.clientCapabilities;
    return seedFromHostTemplate(hostStyle as HostTemplateId).clientCapabilities;
  }, [activeHost?.clientCapabilities, hostStyle]);

  const resolver = useMemo<ActiveHostCapsResolver>(
    () => (_serverId?: string) => hostCaps,
    [hostCaps]
  );

  return (
    <ActiveHostCapsResolverProvider value={resolver}>
      {children}
    </ActiveHostCapsResolverProvider>
  );
}
