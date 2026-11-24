import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import {
  EVENT_DELIVERY_MODES,
  resolveHostEventDeliveryModes,
  type EventDeliveryMode,
  type EventsSupportHost,
} from "@mcpjam/sdk/browser";
import { useHostList, type HostListItem } from "@/hooks/useClients";
import { clientDisplayName } from "@/lib/client-display-name";

/** How MCPJam's own client is named when no saved client is chosen. */
export const BUILT_IN_EVENTS_HOST_NAME = "MCPJam (built-in)";

/** The client a subscription receives events as. */
export interface EventsHostChoice {
  /** `null` is MCPJam (built-in). */
  id: string | null;
  name: string;
  /** The delivery modes it receives events by. */
  modes: EventDeliveryMode[];
  /** The chosen client no longer exists, so nothing can subscribe as it. */
  missing: boolean;
}

/**
 * The chosen client, resolved against the project's client list (`undefined`
 * while it loads). A chosen client that is gone is `missing`, never swapped
 * for built-in. The active client's own config decides its modes; others come
 * from the list, or their style default on an older backend.
 */
export function resolveEventsHostChoice(args: {
  hostId: string | null;
  hosts: HostListItem[] | undefined;
  activeHostId?: string | null;
  activeHost?: EventsSupportHost | null;
}): EventsHostChoice | undefined {
  if (args.hostId === null) {
    return {
      id: null,
      name: BUILT_IN_EVENTS_HOST_NAME,
      modes: [...EVENT_DELIVERY_MODES],
      missing: false,
    };
  }
  const listed = args.hosts?.find((host) => host.hostId === args.hostId);
  if (args.hostId === args.activeHostId && args.activeHost) {
    return {
      id: args.hostId,
      name: listed ? clientDisplayName(listed) : "Active client",
      modes: resolveHostEventDeliveryModes(args.activeHost),
      missing: false,
    };
  }
  if (!args.hosts) return undefined;
  if (!listed) {
    return {
      id: args.hostId,
      name: "Deleted client",
      modes: [],
      missing: true,
    };
  }
  return {
    id: args.hostId,
    name: clientDisplayName(listed),
    modes:
      listed.eventDeliveryModes ??
      resolveHostEventDeliveryModes({ hostStyle: listed.hostStyle ?? null }),
    missing: false,
  };
}

/**
 * The client the Events tab subscribes as. Hosted: MCPJam (built-in), so a
 * project-wide subscription never borrows a saved client's identity. Local:
 * the active client, because the local runtime reuses the connection that
 * client opened. Neither is a choice: client policy lives in Clients.
 */
export function useEventsHost(args: {
  hosted: boolean;
  projectId: string | null;
  activeHostId?: string | null;
  activeHost?: EventsSupportHost | null;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({
    isAuthenticated,
    projectId: args.projectId,
  });
  const activeHostId = args.activeHostId ?? null;
  const hostId = args.hosted ? null : activeHostId;

  const choice = useMemo(
    () =>
      resolveEventsHostChoice({
        hostId,
        hosts: isLoading ? undefined : hosts,
        activeHostId,
        activeHost: args.activeHost ?? null,
      }),
    [hostId, hosts, isLoading, activeHostId, args.activeHost],
  );

  return { choice, hosts, hostId };
}
