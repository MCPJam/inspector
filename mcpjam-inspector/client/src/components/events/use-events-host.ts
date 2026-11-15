import { useEffect, useMemo, useRef, useState } from "react";
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
 * The Events tab's client. Hosted: a choice, defaulting to the active client
 * (or built-in when none is active) and never changed behind the user's
 * back. Local: the active client, because the local runtime reuses the
 * connection that client opened.
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
  const [chosenHostId, setChosenHostId] = useState<string | null>(activeHostId);
  // The active client may hydrate after the tab mounts. Adopt it until the
  // user picks one; after that their choice stands.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setChosenHostId(activeHostId);
  }, [activeHostId]);
  const hostId = args.hosted ? chosenHostId : activeHostId;

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

  return {
    choice,
    hosts,
    hostId,
    setHostId: (next: string | null) => {
      touched.current = true;
      setChosenHostId(next);
    },
  };
}
