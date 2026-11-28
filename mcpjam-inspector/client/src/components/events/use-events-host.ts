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
import { harnessDisplayName } from "@/shared/client-events";
import { effectiveHarnessId } from "@/shared/harness-descriptors";

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
  /** The vendor harness that runs it, which receives no MCP Events. */
  harnessName?: string;
}

function harnessOf(
  config: { agentLoop?: string | null; harness?: string | null } | null,
): { harnessName: string } | Record<string, never> {
  const id = effectiveHarnessId(config);
  return id ? { harnessName: harnessDisplayName(id) } : {};
}

/**
 * The chosen client, resolved against the project's client list (`undefined`
 * while it loads). A chosen client that is gone is `missing`, never swapped
 * for built-in. The active client's own config decides its modes; others come
 * from the list, and receive none when the list doesn't say.
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
      ...harnessOf(args.activeHost),
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
    modes: listed.eventDeliveryModes ?? [],
    missing: false,
    ...harnessOf(listed),
  };
}

/**
 * The client a subscription is made as. The Events tab, project-wide, uses
 * MCPJam (built-in) when hosted, so it never borrows a saved client's
 * identity, and the active client locally, because the local runtime reuses
 * the connection that client opened. The Playground passes
 * `subscribeAsActiveClient`: a chat's subscriptions are made as the chat's
 * client in both runtimes, the way ChatGPT subscribes as the client the user
 * is chatting with. Neither is a choice: client policy lives in Clients.
 */
export function useEventsHost(args: {
  hosted: boolean;
  projectId: string | null;
  activeHostId?: string | null;
  activeHost?: EventsSupportHost | null;
  subscribeAsActiveClient?: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({
    isAuthenticated,
    projectId: args.projectId,
  });
  const activeHostId = args.activeHostId ?? null;
  const hostId =
    args.hosted && !args.subscribeAsActiveClient ? null : activeHostId;

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
