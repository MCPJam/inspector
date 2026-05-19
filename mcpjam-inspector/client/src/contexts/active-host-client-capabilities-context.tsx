import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";
import { resolveEffectiveClientCapabilities } from "@/lib/effective-client";
import { useOptionalSharedAppState } from "@/state/app-state-context";

/**
 * Resolver returning the effective `clientCapabilities` blob the render
 * gate should evaluate for a given tool, scoped to its server.
 *
 * Returning `undefined` means "no host config in scope" — preserves the
 * legacy `hostSupportsWidgetRendering(undefined) === true` behavior so
 * surfaces without a wrapping `ActiveHostCapsResolverScope` keep
 * rendering widgets (test fixtures, edge surfaces).
 *
 * Calls `resolveEffectiveClientCapabilities` from `lib/effective-client`,
 * the same function used by the connect path to build `initialize`. So
 * the gate cannot drift from what the server was actually initialized
 * with: per-server `clientCapabilities` overrides strip/add the UI
 * extension here exactly as they do at initialize-time.
 */
export type ActiveHostCapsResolver = (
  serverId?: string
) => Record<string, unknown> | undefined;

const NO_OP_RESOLVER: ActiveHostCapsResolver = () => undefined;

/**
 * Per-scope resolver that returns the effective `clientCapabilities` for
 * the active host + the tool's server. Mirrors
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
 * Convenience wrapper that builds the resolver and provides it.
 *
 * Resolution:
 *   1. Looks up the tool's server config from `appState.servers`.
 *   2. Passes `{ host, serverConfig }` to `resolveEffectiveClientCapabilities` —
 *      same call as the connect path, so the render gate and `initialize`
 *      always evaluate the same capability blob.
 *   3. Falls back to the template seed for `hostStyle` when no persisted
 *      `activeHost` is in scope — preserves prefs-only and hosted-chatbox
 *      paths where the bootstrap doesn't carry full host capabilities.
 *
 * Apply once per chat surface root (analog to `ChatboxHostStyleProvider`).
 *
 * **Product note on per-server overrides:** a server with its own
 * `clientCapabilities` advertising the UI extension will render widgets
 * even when the host (e.g. Codex) strips it. This is intentional —
 * server-level override beats host identity, matching the precedence in
 * `resolveEffectiveClientCapabilities` and the inspector's role as a
 * conformance/test surface.
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
  // Optional: surfaces like isolated test mounts may render the scope
  // without an AppStateProvider. When absent, per-server overrides are
  // unavailable (resolver evaluates host-level caps only); the gate
  // still works for the host axis.
  const appState = useOptionalSharedAppState();
  const servers = appState?.servers ?? null;

  // Effective host. When the surface has no persisted active host
  // (prefs-only Chat tab, hosted chatbox whose bootstrap doesn't carry
  // clientCapabilities yet), synthesize one from the template seed for
  // the current `hostStyle`. This keeps Codex etc. gating correctly even
  // without a Convex host record.
  const effectiveHost = useMemo<
    Pick<HostConfigDtoV2, "clientCapabilities">
  >(() => {
    if (activeHost?.clientCapabilities) {
      return { clientCapabilities: activeHost.clientCapabilities };
    }
    return {
      clientCapabilities: seedFromHostTemplate(hostStyle as HostTemplateId)
        .clientCapabilities,
    };
  }, [activeHost?.clientCapabilities, hostStyle]);

  const resolver = useMemo<ActiveHostCapsResolver>(() => {
    // Per-render memo: repeated `resolveCaps(serverId)` calls for the
    // same `serverId` inside one render (e.g. multiple tool parts from
    // the same server) reuse the result. The outer `useMemo` keys on
    // `(effectiveHost, servers)` so external changes invalidate.
    const cache = new Map<
      string | undefined,
      Record<string, unknown> | undefined
    >();
    return (serverId?: string) => {
      if (cache.has(serverId)) return cache.get(serverId);
      const serverConfig =
        serverId && servers ? servers[serverId]?.config ?? null : null;
      const caps = resolveEffectiveClientCapabilities({
        host: effectiveHost,
        serverConfig,
      }) as Record<string, unknown>;
      cache.set(serverId, caps);
      return caps;
    };
  }, [effectiveHost, servers]);

  return (
    <ActiveHostCapsResolverProvider value={resolver}>
      {children}
    </ActiveHostCapsResolverProvider>
  );
}
