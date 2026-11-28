import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  describeNoSubscribableMode,
  subscribableModes,
  type EventsSupportHost,
  type MCPServerConfig,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { AlertCircle, BellPlus, Loader2, Radio, RefreshCw } from "lucide-react";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import { EmptyState } from "./ui/empty-state";
import { track } from "@/lib/analytics";
import { buildHostsPath, routePaths, useAppNavigate } from "@/lib/app-navigation";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";
import {
  getApiContextRevision,
  subscribeApiContext,
} from "@/lib/apis/web/context";
import {
  EVENT_SUBSCRIPTIONS_API,
  buildHostedEventDescriptor,
  createLocalEventSubscription,
  fetchEventsSlotState,
  hostedSubscriptionRowToView,
  listLocalEventSubscriptions,
  resolveHostedEventsServerId,
  rotateLocalEventSubscriptionSecret,
  setLocalEventSubscriptionState,
} from "@/lib/apis/mcp-events-api";
import { logEventsFeedEntries } from "@/lib/events-traffic";
import type {
  EventDescriptorView,
  EventsFeedEntryView,
  EventsRejectionView,
  EventsSlotStateResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { EventsEmptyHero } from "./events/EventsEmptyHero";
import type { SubscriptionAction } from "./events/SubscriptionsPanel";
import { EventsHeader } from "./events/EventsTabSections";
import { EventsSidebar, type EventsBrowseTab } from "./events/EventsSidebar";
import { EventsActivity } from "./events/EventsActivity";
import { EventSubscribePanel } from "./events/EventSubscribePanel";
import { useEventsHost } from "./events/use-events-host";
import { useEventsCatalog } from "./events/use-events-catalog";
import { useEventsFeed } from "./events/use-events-feed";
import { useEventsListChanged } from "./events/use-events-list-changed";
import {
  useSubscribeForm,
  type SubscribeFormValue,
} from "./events/use-subscribe-form";
import {
  errorMessage,
  logicalIdOf,
  replayUnsupported,
} from "./events/event-utils";

interface EventsTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  isActive?: boolean;
  /** Refetch the catalog when the connection reaches "connected". */
  connectionStatus?: string;
  /** The Convex project (hosted registry and viewer tokens). */
  projectId?: string | null;
  /** The app's own project id, for a local project without a Convex one. */
  localProjectId?: string | null;
  /** The playground's active client; the default client to subscribe as. */
  activeHostId?: string | null;
  /** Its saved config, which decides the delivery modes it receives. */
  activeHost?: EventsSupportHost | null;
  /** The server signs MCPJam in (`serverHasSignIn`), so it may accept webhook. */
  serverSignedIn?: boolean;
}

export function EventsTab({
  serverConfig,
  serverName,
  isActive = true,
  connectionStatus,
  projectId = null,
  localProjectId = null,
  activeHostId = null,
  activeHost = null,
  serverSignedIn = false,
}: EventsTabProps) {
  const hosted = isHostedMode();
  // The local runtime scopes subscriptions and the feed by project, keyed
  // like the Playground's: the Convex project, else the local one.
  const localScope = projectId ?? localProjectId;
  const hasServer = Boolean(serverConfig && serverName);
  const connected =
    connectionStatus === undefined || connectionStatus === "connected";

  useEffect(() => {
    track("events_tab_viewed", { location: "events_tab" });
  }, []);

  // The client subscriptions are made as: built-in when hosted, the active
  // client when local. It decides the delivery modes on offer; the catalog
  // stays visible whatever it accepts.
  const eventsHost = useEventsHost({
    hosted,
    projectId,
    activeHostId,
    activeHost,
  });
  const hostChoice = eventsHost.choice;
  const hostName = hostChoice?.name ?? "This client";
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [workspaceSelected, setWorkspaceSelected] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [busySubscriptionId, setBusySubscriptionId] = useState<string | null>(
    null,
  );
  const [slotStates, setSlotStates] = useState<
    Record<string, EventsSlotStateResponse>
  >({});
  const [localSubscriptions, setLocalSubscriptions] = useState<
    Map<string, EventsSubscriptionView>
  >(() => new Map());
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<EventsBrowseTab>("events");
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<
    string | null
  >(null);
  const [selectedOccurrenceSeq, setSelectedOccurrenceSeq] = useState<
    number | null
  >(null);
  const navigate = useAppNavigate();

  // ── catalog ─────────────────────────────────────────────────────────────
  const {
    catalog,
    catalogState,
    catalogError,
    retry: retryCatalog,
    loadingMore,
    loadMoreEvents,
    selectedEventName,
    setSelectedEventName,
  } = useEventsCatalog({ hasServer, serverName, connected });
  const declared =
    catalogState === "ready" && catalog?.support.declared === true;
  const support = catalog?.support;
  const watchCatalog =
    connected && support?.declared && (!support.beta || support.listChanged);
  useEventsListChanged(
    watchCatalog ? serverName : undefined,
    retryCatalog,
    support?.beta,
  );

  // A different server starts from its own lists.
  useEffect(() => {
    setActiveTab("events");
    setSelectedSubscriptionId(null);
    setSelectedOccurrenceSeq(null);
    setWorkspaceSelected(false);
  }, [serverName]);

  // ── registry ────────────────────────────────────────────────────────────
  // The hosted server id comes from the API context, which fills in after
  // bootstrap; subscribing re-renders on every change, and the id is read
  // fresh each render (a map lookup).
  useSyncExternalStore(
    subscribeApiContext,
    getApiContextRevision,
    getApiContextRevision,
  );
  const hostedServerId =
    hosted && serverName ? resolveHostedEventsServerId(serverName) : null;
  const hostedRows = useQuery(
    EVENT_SUBSCRIPTIONS_API.list,
    hosted && projectId && declared ? { projectId } : "skip",
  );
  const createHostedSubscription = useMutation(EVENT_SUBSCRIPTIONS_API.create);
  const setHostedDesiredState = useMutation(
    EVENT_SUBSCRIPTIONS_API.setDesiredState,
  );
  const requestHostedRotation = useMutation(
    EVENT_SUBSCRIPTIONS_API.requestRotation,
  );
  const reauthorizeHosted = useMutation(EVENT_SUBSCRIPTIONS_API.reauthorize);

  const upsertLocal = useCallback((subscriptions: EventsSubscriptionView[]) => {
    setLocalSubscriptions((previous) => {
      const next = new Map(previous);
      for (const subscription of subscriptions) {
        next.set(subscription.id, subscription);
      }
      return next;
    });
  }, []);

  // An action's response is the subscription as it was when the request was
  // handled. The stream has often delivered a newer state for the same
  // generation by then, so a response only lands when it is newer.
  const upsertFromResponse = useCallback(
    (subscription: EventsSubscriptionView) => {
      setLocalSubscriptions((previous) => {
        const current = previous.get(subscription.id);
        if (current && current.generation >= subscription.generation) {
          return previous;
        }
        const next = new Map(previous);
        next.set(subscription.id, subscription);
        return next;
      });
    },
    [],
  );

  // Another project's subscriptions are not this one's.
  useEffect(() => {
    setLocalSubscriptions(new Map());
  }, [localScope]);

  useEffect(() => {
    if (hosted || !serverName || !declared) return;
    let cancelled = false;
    listLocalEventSubscriptions(serverName, localScope)
      .then((subscriptions) => {
        if (cancelled) return;
        upsertLocal(subscriptions);
        setRegistryError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setRegistryError(
            errorMessage(error, "Could not load subscriptions. Try again."),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hosted, serverName, declared, localScope, upsertLocal]);

  const hostNames = useMemo(
    () =>
      new Map(
        eventsHost.hosts.map((host) => [host.hostId, host.name] as const),
      ),
    [eventsHost.hosts],
  );
  const allSubscriptions = useMemo<EventsSubscriptionView[]>(
    () =>
      hosted
        ? (hostedRows ?? []).map((row) =>
            hostedSubscriptionRowToView(row, hostNames),
          )
        : [...localSubscriptions.values()],
    [hosted, hostedRows, localSubscriptions, hostNames],
  );
  const serverKey = hosted ? hostedServerId : (serverName ?? null);
  const serverSubscriptions = useMemo(
    () =>
      allSubscriptions.filter(
        (subscription) =>
          serverKey !== null &&
          subscription.serverId === serverKey &&
          subscription.observedState !== "removed",
      ),
    [allSubscriptions, serverKey],
  );
  const subscriptionsByLogicalId = useMemo(
    () =>
      new Map(
        allSubscriptions.map((subscription) => [
          logicalIdOf(subscription),
          subscription,
        ]),
      ),
    [allSubscriptions],
  );

  // ── feed ────────────────────────────────────────────────────────────────
  const tracingContextRef = useRef({
    subscriptionsByLogicalId,
    serverKey,
    serverName,
  });
  tracingContextRef.current = {
    subscriptionsByLogicalId,
    serverKey,
    serverName,
  };

  const feed = useEventsFeed({
    hosted,
    projectId: hosted ? projectId : localScope,
    enabled:
      isActive &&
      declared &&
      (hosted ? Boolean(projectId) : Boolean(serverName)),
    onNewEntries: (entries) =>
      logEventsFeedEntries(entries, {
        feed: hosted ? "hosted" : "local",
        resolveServer: (entry) => {
          const context = tracingContextRef.current;
          const owner = context.subscriptionsByLogicalId.get(
            entry.logicalSubscriptionId,
          );
          if (
            owner &&
            owner.serverId === context.serverKey &&
            context.serverName
          ) {
            return {
              serverId: context.serverName,
              serverName: context.serverName,
            };
          }
          return { serverId: owner?.serverId || "events" };
        },
      }),
    onSubscriptionsSnapshot: (subscriptions) =>
      setLocalSubscriptions(
        new Map(
          subscriptions.map((subscription) => [subscription.id, subscription]),
        ),
      ),
    onSubscription: (subscription) => upsertLocal([subscription]),
  });

  // The feed is the project's; show this server's entries, and entries no
  // known subscription claims.
  const visibleEntries = useMemo(
    () =>
      feed.entries.filter((entry) => {
        const owner = subscriptionsByLogicalId.get(entry.logicalSubscriptionId);
        return !owner || owner.serverId === serverKey;
      }),
    [feed.entries, subscriptionsByLogicalId, serverKey],
  );
  const labelForEntry = useCallback(
    (entry: EventsFeedEntryView) => {
      const owner = subscriptionsByLogicalId.get(entry.logicalSubscriptionId);
      return owner
        ? `${owner.eventName} (${owner.mode})`
        : entry.logicalSubscriptionId || undefined;
    },
    [subscriptionsByLogicalId],
  );

  const rejections = useMemo<EventsRejectionView[]>(() => {
    if (!hosted) return feed.rejections;
    return Object.values(slotStates)
      .flatMap((state) => state.rejections ?? [])
      .sort((a, b) => b.at - a.at);
  }, [hosted, feed.rejections, slotStates]);

  // ── actions ─────────────────────────────────────────────────────────────
  const selectedEvent = useMemo<EventDescriptorView | undefined>(
    () => catalog?.events.find((event) => event.name === selectedEventName),
    [catalog, selectedEventName],
  );

  // Where the client, the event and this runtime all agree. Undefined while
  // the client list loads.
  const availabilityFor = useCallback(
    (event: EventDescriptorView) =>
      hostChoice
        ? subscribableModes({
            host: null,
            hostModes: hostChoice.modes,
            eventModes: event.delivery,
            runtime: hosted ? "hosted" : "local",
          })
        : undefined,
    [hostChoice, hosted],
  );
  const selectedAvailability = selectedEvent
    ? availabilityFor(selectedEvent)
    : undefined;
  const blockedReason = !hostChoice
    ? "Loading clients…"
    : hostChoice.missing
      ? "This client no longer exists. Make another client active to subscribe."
      : selectedAvailability
        ? describeNoSubscribableMode(
            selectedAvailability,
            hostChoice.name,
            hostChoice.harnessName,
          )
        : null;

  const handleSubscribe = async (value: SubscribeFormValue) => {
    if (!serverName || !selectedEvent || !hostChoice || hostChoice.missing) {
      return;
    }
    const event = selectedEvent;
    const host = hostChoice;
    setSubscribing(true);
    try {
      await runByMode({
        hosted: async () => {
          if (!projectId) {
            throw new Error("Open a project to subscribe on hosted MCPJam.");
          }
          if (!hostedServerId) {
            throw new Error(
              "Add this server to the project to subscribe to its events.",
            );
          }
          const descriptor = await buildHostedEventDescriptor(event);
          const subscription = await createHostedSubscription({
            projectId,
            serverId: hostedServerId,
            eventName: event.name,
            arguments: value.arguments,
            mode: value.mode,
            hostId: host.id,
            locality: "hosted",
            ...(descriptor ? { descriptor } : {}),
            ...(catalog?.protocolVersion
              ? { protocolVersion: catalog.protocolVersion }
              : {}),
            ...(value.maxAgeMs !== undefined
              ? { maxAgeMs: value.maxAgeMs }
              : {}),
            ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs } : {}),
          });
          setSelectedSubscriptionId(String(subscription._id));
        },
        local: async () => {
          const subscription = await createLocalEventSubscription({
            ...(localScope ? { projectId: localScope } : {}),
            serverId: serverName,
            eventName: event.name,
            arguments: value.arguments,
            mode: value.mode,
            host:
              host.id === null
                ? null
                : {
                    id: host.id,
                    name: host.name,
                    eventDeliveryModes: host.modes,
                  },
            ...(value.maxAgeMs !== undefined
              ? { maxAgeMs: value.maxAgeMs }
              : {}),
            ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs } : {}),
            ...(value.receiver ? { receiver: value.receiver } : {}),
            ...(value.insecureLocalReceiver
              ? { overrides: ["insecure-local-receiver" as const] }
              : {}),
          });
          upsertFromResponse(subscription);
          setSelectedSubscriptionId(subscription.id);
        },
      });
      setActiveTab("subscriptions");
      setWorkspaceSelected(true);
      if (hosted || value.mode !== "webhook") toast.success(`Subscribed to ${event.name}`);
    } catch (error) {
      toast.error(errorMessage(error, "Could not subscribe. Try again."));
    } finally {
      setSubscribing(false);
    }
  };

  const handleSubscriptionAction = async (
    subscription: EventsSubscriptionView,
    action: SubscriptionAction,
  ) => {
    setBusySubscriptionId(subscription.id);
    try {
      switch (action.kind) {
        case "state":
          await runByMode({
            hosted: async () => {
              await setHostedDesiredState({
                subscriptionId: subscription.id,
                desiredState: action.desiredState,
              });
            },
            local: async () => {
              upsertFromResponse(
                await setLocalEventSubscriptionState(
                  subscription.id,
                  action.desiredState,
                ),
              );
            },
          });
          break;
        case "rotate":
          await runByMode({
            hosted: async () => {
              await requestHostedRotation({ subscriptionId: subscription.id });
            },
            local: async () => {
              upsertFromResponse(
                await rotateLocalEventSubscriptionSecret(subscription.id),
              );
            },
          });
          toast.success("Secret rotation requested");
          break;
        case "reauthorize":
          await reauthorizeHosted({ subscriptionId: subscription.id });
          break;
        case "slot-state": {
          if (!projectId) break;
          const state = await fetchEventsSlotState({
            projectId,
            subscriptionId: subscription.id,
          });
          setSlotStates((previous) => ({
            ...previous,
            [subscription.id]: state,
          }));
          break;
        }
      }
    } catch (error) {
      toast.error(
        errorMessage(error, "Could not update the subscription. Try again."),
      );
    } finally {
      setBusySubscriptionId(null);
    }
  };

  // ── workspace selection ────────────────────────────────────────────────
  const form = useSubscribeForm({
    event: selectedEvent,
    modes: selectedAvailability?.modes ?? [],
    blockedReason,
    hosted,
    serverSignedIn,
    projectId,
    serverId: serverName,
    busy: subscribing,
    onSubscribe: handleSubscribe,
  });

  // A local client that receives no events is fixed in Clients, not here.
  const blockedAction =
    !hosted &&
    hostChoice &&
    !hostChoice.missing &&
    hostChoice.id !== null &&
    hostChoice.modes.length === 0
      ? {
          label: "Open Clients",
          onClick: () => navigate(buildHostsPath(hostChoice.id)),
        }
      : undefined;

  const workspaceEvent = selectedEvent;
  const selectedSubscription = serverSubscriptions.find(
    (subscription) => subscription.id === selectedSubscriptionId,
  );
  const selectedOccurrence = visibleEntries.find(
    (entry) => entry.seq === selectedOccurrenceSeq,
  );

  // ── render ──────────────────────────────────────────────────────────────
  const unsupportedCatalog =
    connected && catalogState === "ready" && catalog && !catalog.support.declared
      ? catalog
      : undefined;
  if (!hasServer || unsupportedCatalog) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EventsHeader />
        <EventsEmptyHero
          serverName={serverName}
          catalog={unsupportedCatalog}
          onOpenServers={() => navigate(routePaths.servers)}
        />
      </div>
    );
  }

  if (!connected) {
    return (
      <EmptyState
        icon={Radio}
        title="Waiting for the server"
        description="Wait for the server to finish connecting."
      />
    );
  }

  if (catalogState === "error") {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Could not read events support. Reconnect the server and try again."
        description={
          catalogError ?? "Could not check events support. Try again."
        }
      >
        <Button variant="outline" size="sm" onClick={retryCatalog}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
      </EmptyState>
    );
  }

  if (catalogState !== "ready" || !catalog) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading events support…
      </div>
    );
  }

  const hostedRegistryNotice =
    hosted && !projectId
      ? "Open a project to manage its subscriptions."
      : hosted && !hostedServerId
        ? "Add this server to the project to subscribe to its events."
        : null;

  const sidebarContent = (
    <EventsSidebar
      catalog={catalog}
      loadingMore={loadingMore}
      onLoadMore={loadMoreEvents}
      onRefresh={retryCatalog}
      onHide={() => setIsSidebarVisible(false)}
      activeTab={activeTab}
      onTabChange={(tab) => {
        setActiveTab(tab);
        setWorkspaceSelected(false);
      }}
      selectedEventName={selectedEventName}
      onSelectEvent={(name) => {
        setSelectedEventName(name);
        setWorkspaceSelected(true);
      }}
      subscriptions={serverSubscriptions}
      selectedSubscriptionId={selectedSubscriptionId}
      onSelectSubscription={(id) => {
        setSelectedSubscriptionId(id);
        setWorkspaceSelected(true);
      }}
      entries={visibleEntries}
      selectedOccurrenceSeq={selectedOccurrenceSeq}
      onSelectOccurrence={(seq) => {
        setSelectedOccurrenceSeq(seq);
        setWorkspaceSelected(true);
      }}
    />
  );

  const centerContent = (
    <EventsActivity
      activeTab={activeTab}
      subscription={selectedSubscription}
      occurrence={selectedOccurrence}
      event={workspaceEvent}
      subscribeAction={
        <Button
          size="sm"
          disabled={!workspaceEvent || subscribing || !form.canSubmit}
          onClick={() => void form.submit()}
        >
          {subscribing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <BellPlus className="size-4" />
          )}
          {subscribing ? "Subscribing…" : "Subscribe"}
        </Button>
      }
      subscribeContent={
        workspaceEvent ? (
          <EventSubscribePanel
            event={workspaceEvent}
            form={form}
            localCallbackBase={catalog?.localCallbackBase}
            availability={selectedAvailability}
            hostName={hostName}
            hosted={hosted}
            blockedReason={blockedReason}
            blockedAction={blockedAction}
            replayUnsupported={serverSubscriptions.some(
              (subscription) =>
                subscription.eventName === workspaceEvent.name &&
                replayUnsupported(subscription),
            )}
          />
        ) : null
      }
      hosted={hosted}
      notice={hostedRegistryNotice}
      registryError={registryError}
      subscriptionsLoading={Boolean(
        hosted && projectId && hostedRows === undefined,
      )}
      busySubscriptionId={busySubscriptionId}
      slotStates={slotStates}
      onSubscriptionAction={(subscription, action) =>
        void handleSubscriptionAction(subscription, action)
      }
      entries={visibleEntries}
      gaps={feed.gaps}
      feedStatus={feed.status}
      feedError={feed.error}
      labelForEntry={labelForEntry}
      rejections={rejections}
    />
  );

  const mobileNavigation = {
    selectionKey: workspaceSelected
      ? activeTab === "events"
        ? (selectedEventName ?? "")
        : activeTab === "subscriptions"
          ? (selectedSubscription?.id ?? "")
          : selectedOccurrence
            ? String(selectedOccurrence.seq)
            : ""
      : "",
    selectionPanel: "content" as const,
    contentLabel: "Workspace",
    onBack: () => {
      setWorkspaceSelected(false);
      setSelectedEventName(null);
    },
  };

  return (
    <ThreePanelLayout
      id="events"
      defaultSizes={{ left: 34, right: 25 }}
      mobileNavigation={mobileNavigation}
      sidebar={sidebarContent}
      content={centerContent}
      sidebarVisible={isSidebarVisible}
      onSidebarVisibilityChange={setIsSidebarVisible}
      sidebarTooltip="Show events sidebar"
      serverName={serverName}
    />
  );
}
