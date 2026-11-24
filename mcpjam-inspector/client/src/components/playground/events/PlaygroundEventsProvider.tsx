import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import type { EventsSupportHost } from "@mcpjam/sdk/browser";
import { usePlaygroundStateContext } from "@/components/ui-playground/hooks/use-playground-state";
import { useEventsEnabledState } from "@/hooks/useEventsEnabled";
import { isHostedMode } from "@/lib/apis/mode-client";
import {
  EVENT_SUBSCRIPTIONS_API,
  buildHostedEventDescriptor,
  createLocalEventSubscription,
  hostedSubscriptionRowToView,
  loadEventsCatalog,
  resolveHostedEventsServerId,
  fetchLocalEventsFeed,
  fetchEventsViewerToken,
  fetchHostedEventsFeed,
} from "@/lib/apis/mcp-events-api";
import { logEventsFeedEntries } from "@/lib/events-traffic";
import type {
  EventDescriptorView,
  EventsListResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { useEventsFeed } from "@/components/events/use-events-feed";
import { useEventsHost } from "@/components/events/use-events-host";
import type { SubscribeFormValue } from "@/components/events/use-subscribe-form";
import { logicalIdOf } from "@/components/events/event-utils";
import { createEventDispatcher, type EventBinding } from "./event-dispatch";
import { useEventAgentBridge } from "./event-agent-bridge";

export interface PlaygroundEventBinding extends EventBinding {
  event: EventDescriptorView;
  subscription?: EventsSubscriptionView;
  lastResult?: string;
  ownerScope: string;
}
export interface ServerEventCatalog {
  serverName: string;
  catalog?: EventsListResponse;
  error?: string;
}

function useRuntime(
  projectId: string | null,
  activeHostId: string | null,
  activeHost: EventsSupportHost | null,
  enabled: boolean,
) {
  const state = usePlaygroundStateContext();
  const hosted = isHostedMode();
  const host = useEventsHost({
    hosted,
    projectId,
    activeHostId,
    activeHost,
  }).choice;
  const scope = `${projectId}:${activeHostId}:${enabled}`;
  const [storedBindings, setBindings] = useState<PlaygroundEventBinding[]>([]);
  const bindings = storedBindings.filter(
    (binding) => binding.ownerScope === scope && enabled,
  );
  const agent = useEventAgentBridge((state) => state.agent);
  const agentScope = agent?.scope;
  useEffect(() => {
    setBindings([]);
    setCatalogs([]);
  }, [scope]);
  useEffect(() => {
    if (agentScope === undefined) return;
    setBindings((previous) =>
      previous.map((binding) =>
        binding.enabled && binding.agentScope !== agentScope
          ? {
              ...binding,
              enabled: false,
              lastResult:
                "Agent or conversation changed. Resume to connect this event here.",
            }
          : binding,
      ),
    );
  }, [agentScope]);
  const [catalogs, setCatalogs] = useState<ServerEventCatalog[]>([]);
  const [loading, setLoading] = useState(false);
  const rows = useQuery(
    EVENT_SUBSCRIPTIONS_API.list,
    enabled && hosted && projectId ? { projectId } : "skip",
  );
  const createHosted = useMutation(EVENT_SUBSCRIPTIONS_API.create);
  const current = useRef({ bindings, servers: state.servers, scope });
  current.current = { bindings, servers: state.servers, scope };
  const alive = useRef(true);
  const lifecycle = useRef(0);
  const catalogRevision = useRef(0);
  const editRevisions = useRef(new Map<string, number>());
  const dispatcher = useRef<ReturnType<typeof createEventDispatcher> | null>(
    null,
  );
  if (!dispatcher.current)
    dispatcher.current = createEventDispatcher({
      binding: (id) =>
        current.current.bindings.find((binding) => binding.id === id),
      agent: () => useEventAgentBridge.getState().agent,
      connected: (binding) =>
        current.current.servers[binding.serverName]?.connectionStatus ===
        "connected",
      result: (id, lastResult) =>
        setBindings((previous) =>
          previous.map((binding) =>
            binding.id === id ? { ...binding, lastResult } : binding,
          ),
        ),
    });
  const updateSubscriptions = (subscriptions: EventsSubscriptionView[]) => {
    const update = (previous: PlaygroundEventBinding[]) =>
      previous.map((binding) => {
        const subscription = subscriptions.find(
          (row) => row.id === binding.subscriptionId,
        );
        return subscription
          ? { ...binding, subscription, logicalId: logicalIdOf(subscription) }
          : binding;
      });
    // A following feed frame can arrive before React renders this snapshot.
    current.current.bindings = update(current.current.bindings);
    setBindings(update);
  };
  useEffect(() => {
    if (rows)
      updateSubscriptions(rows.map((row) => hostedSubscriptionRowToView(row)));
  }, [rows]);

  const feed = useEventsFeed({
    hosted,
    projectId,
    enabled: bindings.some((binding) => !!binding.subscription),
    onSubscriptionsSnapshot: updateSubscriptions,
    onSubscription: (subscription) => updateSubscriptions([subscription]),
    onNewEntries: (entries) => {
      const own = entries.filter((entry) =>
        current.current.bindings.some(
          (binding) => binding.logicalId === entry.logicalSubscriptionId,
        ),
      );
      logEventsFeedEntries(own, {
        feed: hosted ? "hosted" : "local",
        resolveServer: (entry) => ({
          serverId:
            current.current.bindings.find(
              (binding) => binding.logicalId === entry.logicalSubscriptionId,
            )?.serverName ?? "events",
        }),
      });
      for (const entry of own)
        for (const binding of current.current.bindings) {
          void dispatcher.current?.dispatch(binding.id, entry);
        }
    },
  });

  useEffect(() => {
    alive.current = true;
    dispatcher.current?.activate();
    // Bindings are foreground state only. The idempotent registry can return
    // shared subscriptions, so never remove them or create hosted trigger jobs.
    const stop = () => {
      alive.current = false;
      lifecycle.current += 1;
      dispatcher.current?.dispose();
    };
    const restore = () => {
      alive.current = true;
      dispatcher.current?.activate();
      setBindings((previous) =>
        previous.map((binding) => ({
          ...binding,
          enabled: false,
          lastResult: "Page restored. Resume to listen for new events.",
        })),
      );
    };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", restore);
    return () => {
      stop();
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", restore);
    };
  }, []);

  const refresh = async () => {
    const revision = ++catalogRevision.current;
    const ownerScope = current.current.scope;
    const generation = lifecycle.current;
    setLoading(true);
    const names = Object.keys(current.current.servers).filter(
      (name) => current.current.servers[name].connectionStatus === "connected",
    );
    const result = await Promise.all(
      names.map(async (serverName): Promise<ServerEventCatalog> => {
        try {
          const catalog = await loadEventsCatalog(serverName);
          let cursor = catalog.nextCursor;
          const seen = new Set<string>();
          while (cursor && !seen.has(cursor)) {
            seen.add(cursor);
            const page = await loadEventsCatalog(serverName, cursor);
            catalog.events.push(...page.events);
            cursor = page.nextCursor;
          }
          return { serverName, catalog };
        } catch (error) {
          return {
            serverName,
            error:
              error instanceof Error
                ? error.message
                : "Could not load events. Reconnect this server and retry.",
          };
        }
      }),
    );
    if (
      alive.current &&
      generation === lifecycle.current &&
      current.current.scope === ownerScope &&
      catalogRevision.current === revision
    ) {
      setCatalogs(result);
      setLoading(false);
    }
  };

  const watermark = async () => {
    const token =
      hosted && projectId ? await fetchEventsViewerToken(projectId) : null;
    let after = 0;
    for (let page = 0; page < 100; page += 1) {
      const result = token
        ? await fetchHostedEventsFeed({ ...token, after })
        : await fetchLocalEventsFeed(after);
      if (result.nextAfter <= after) return after;
      after = result.nextAfter;
      if (result.entries.length === 0) return after;
    }
    throw new Error("The event feed is busy. Wait a moment and try again.");
  };

  const add = async (
    server: ServerEventCatalog,
    event: EventDescriptorView,
    value: SubscribeFormValue,
    instructions: string,
  ) => {
    if (
      !host ||
      host.missing ||
      current.current.servers[server.serverName]?.connectionStatus !==
        "connected"
    )
      throw new Error("Reconnect the server before connecting an event.");
    const ownerScope = scope;
    const generation = lifecycle.current;
    const targetAgent = useEventAgentBridge.getState().agent;
    if (!targetAgent)
      throw new Error("Open an agent conversation before connecting an event.");
    if (targetAgent.blockedReason) throw new Error(targetAgent.blockedReason);
    const isCurrent = () =>
      alive.current &&
      generation === lifecycle.current &&
      current.current.scope === ownerScope &&
      useEventAgentBridge.getState().agent?.scope === targetAgent.scope;
    const afterSeq = await watermark();
    if (!isCurrent())
      throw new Error(
        "The client changed. Connect the event again for the selected client.",
      );
    let subscription: EventsSubscriptionView;
    if (hosted) {
      const serverId = resolveHostedEventsServerId(server.serverName);
      if (!projectId || !serverId)
        throw new Error(
          "Save the server in this project before connecting an event.",
        );
      const descriptor = await buildHostedEventDescriptor(event);
      if (!isCurrent())
        throw new Error(
          "The client changed. Connect the event again for the selected client.",
        );
      const row = await createHosted({
        projectId,
        serverId,
        eventName: event.name,
        arguments: value.arguments,
        mode: value.mode,
        hostId: host.id,
        locality: "hosted",
        protocolVersion: server.catalog?.protocolVersion,
        descriptor,
      });
      subscription = hostedSubscriptionRowToView(row);
    } else {
      subscription = await createLocalEventSubscription({
        serverId: server.serverName,
        eventName: event.name,
        arguments: value.arguments,
        mode: value.mode,
        host:
          host.id === null
            ? null
            : { id: host.id, name: host.name, eventDeliveryModes: host.modes },
        ...(value.receiver ? { receiver: value.receiver } : {}),
        ...(value.maxAgeMs !== undefined ? { maxAgeMs: value.maxAgeMs } : {}),
        ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs } : {}),
        ...(value.insecureLocalReceiver
          ? { overrides: ["insecure-local-receiver"] }
          : {}),
      });
    }
    if (!isCurrent())
      throw new Error(
        "The client changed. Connect the event again for the selected client.",
      );
    if (
      current.current.bindings.some(
        (binding) => binding.subscriptionId === subscription.id,
      )
    )
      throw new Error(
        "This event is already connected. Use Edit instructions to change what the agent should do.",
      );
    setBindings((previous) => {
      return [
        ...previous,
        {
          id: crypto.randomUUID(),
          subscriptionId: subscription.id,
          logicalId: logicalIdOf(subscription),
          serverName: server.serverName,
          eventName: event.name,
          instructions,
          event,
          subscription,
          enabled: true,
          afterSeq,
          agentScope: targetAgent.scope,
          ownerScope,
        },
      ];
    });
  };
  const addTest = (
    server: ServerEventCatalog,
    event: EventDescriptorView,
    instructions: string,
  ) => {
    const target = useEventAgentBridge.getState().agent;
    if (
      !target ||
      current.current.servers[server.serverName]?.connectionStatus !==
        "connected"
    )
      throw new Error(
        "Select an agent and reconnect the server before connecting a test event.",
      );
    if (target.blockedReason) throw new Error(target.blockedReason);
    const id = crypto.randomUUID();
    setBindings((previous) => [
      ...previous,
      {
        id,
        subscriptionId: id,
        logicalId: id,
        serverName: server.serverName,
        eventName: event.name,
        event,
        instructions,
        enabled: true,
        afterSeq: 0,
        agentScope: target.scope,
        ownerScope: scope,
      },
    ]);
  };

  const edit = async (
    id: string,
    fields: Partial<Pick<PlaygroundEventBinding, "enabled" | "instructions">>,
  ) => {
    dispatcher.current?.invalidate(id);
    const target = useEventAgentBridge.getState().agent?.scope;
    const ownerScope = current.current.scope;
    const generation = lifecycle.current;
    const revision = (editRevisions.current.get(id) ?? 0) + 1;
    editRevisions.current.set(id, revision);
    const afterSeq =
      fields.enabled === true &&
      current.current.bindings.find((binding) => binding.id === id)
        ?.subscription
        ? await watermark()
        : fields.enabled === true
          ? 0
          : undefined;
    if (
      !alive.current ||
      generation !== lifecycle.current ||
      current.current.scope !== ownerScope ||
      useEventAgentBridge.getState().agent?.scope !== target ||
      editRevisions.current.get(id) !== revision
    )
      return;
    setBindings((previous) =>
      previous.map((binding) =>
        binding.id === id
          ? {
              ...binding,
              ...fields,
              ...(afterSeq !== undefined
                ? {
                    afterSeq,
                    agentScope:
                      useEventAgentBridge.getState().agent?.scope ??
                      binding.agentScope,
                  }
                : {}),
            }
          : binding,
      ),
    );
  };
  const remove = (id: string) => {
    dispatcher.current?.invalidate(id);
    setBindings((previous) => previous.filter((binding) => binding.id !== id));
  };
  const trigger = async (
    binding: PlaygroundEventBinding,
    data: Record<string, unknown>,
  ) => {
    const entry = {
      seq: Date.now(),
      kind: "event",
      origin: "simulation" as const,
      namespace: "playground-test",
      logicalSubscriptionId: binding.logicalId,
      eventId: crypto.randomUUID(),
      name: binding.eventName,
      timestamp: new Date().toISOString(),
      data,
      receivedAt: Date.now(),
    };
    // A local test never enters a shared inbox or fires a saved background rule.
    return dispatcher.current?.dispatch(binding.id, entry, true) ?? false;
  };
  return {
    projectId,
    host,
    hosted,
    bindings,
    catalogs,
    loading,
    refresh,
    add,
    addTest,
    edit,
    remove,
    trigger,
    feed,
    servers: state.servers,
    agentBlockedReason:
      agent?.blockedReason ??
      (!agent ? "Select an agent to connect this event." : null),
  };
}

const Context = createContext<ReturnType<typeof useRuntime> | null>(null);
export function PlaygroundEventsProvider({
  children,
  projectId,
  hostId,
  host,
}: {
  children: ReactNode;
  projectId: string | null;
  hostId: string | null;
  host: EventsSupportHost | null;
}) {
  const enabled = useEventsEnabledState() === true;
  const runtime = useRuntime(projectId, hostId, host, enabled);
  return (
    <Context.Provider value={enabled ? runtime : null}>
      {children}
    </Context.Provider>
  );
}
export function usePlaygroundEvents() {
  return useContext(Context);
}
