import { useCallback, useRef } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  buildProjectServerPath,
  routePaths,
  useAppNavigate,
} from "@/lib/app-navigation";
import type { ServerDetailTab } from "@/components/connection/hooks/use-server-detail-controller";
import { serverTabSearch } from "./server-canvas-url";

/**
 * The one rollout flag for the server canvas. The Inspector server resolves
 * it (`/api/web/flags`); off, missing or still loading all mean off.
 */
export const SERVER_CANVAS_FLAG = "server-canvas";

export function useServerCanvasEnabled(): boolean {
  return useFeatureFlagEnabled(SERVER_CANVAS_FLAG) === true;
}

/**
 * How the Servers tab routes a project server's details. With the flag on,
 * `/servers/:serverId` renders the canvas page and opening a server goes
 * there; with it off, or for a server not saved to a project, the modal
 * opens exactly as before.
 */
export function useServerCanvasRoute({
  enabled,
  routeServerId,
  routeServerName,
  routeLoading,
  hostedProjectId,
  projectServers,
  hostedServerIdFor,
  openModal,
}: {
  /** `useServerCanvasEnabled()`, read once by the caller. */
  enabled: boolean;
  routeServerId: string | null | undefined;
  /** The server the permalink resolved to, once it has. */
  routeServerName: string | null | undefined;
  /** The permalink is still being resolved against the project's servers. */
  routeLoading: boolean;
  hostedProjectId: string | null;
  projectServers: Record<string, ServerWithName>;
  hostedServerIdFor: (serverName: string) => string | undefined;
  openModal: (server: ServerWithName, tab: ServerDetailTab) => void;
}) {
  const navigate = useAppNavigate();
  const active = enabled && Boolean(hostedProjectId && routeServerId);
  const server =
    active && routeServerName ? projectServers[routeServerName] : undefined;

  // Read through refs so `openDetail` keeps one identity: callers subscribe
  // with it.
  const latest = useRef({ enabled, hostedProjectId, hostedServerIdFor, openModal });
  latest.current = { enabled, hostedProjectId, hostedServerIdFor, openModal };
  const openDetail = useCallback(
    (target: ServerWithName, tab: ServerDetailTab) => {
      const current = latest.current;
      const serverId =
        current.enabled && current.hostedProjectId
          ? current.hostedServerIdFor(target.name)
          : undefined;
      if (!serverId) {
        current.openModal(target, tab);
        return;
      }
      navigate(`${buildProjectServerPath(serverId)}${serverTabSearch(tab)}`);
    },
    [navigate],
  );

  const back = useCallback(() => navigate(routePaths.servers), [navigate]);

  return {
    /** A `/servers/:serverId` route the canvas page owns. */
    active,
    /** The project server to render the page for. */
    server,
    /** Waiting for the route to resolve: render a loading state, not the list. */
    pending: active && routeLoading,
    openDetail,
    back,
  };
}
