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
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { AlertCircle, Loader2, Radio, RefreshCw } from "lucide-react";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import { EmptyState } from "./ui/empty-state";
import { track } from "@/lib/analytics";
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
  simulateEvent,
} from "@/lib/apis/mcp-events-api";
import { DRAFT_EVENTS_PROFILE_ID } from "@/lib/events-profiles";
import { logEventsFeedEntries } from "@/lib/events-traffic";
import type {
  EventDescriptorView,
  EventsFeedEntryView,
  EventsProfileIdView,
  EventsRejectionView,
  EventsSimulateRequest,
  EventsSlotStateResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { CapabilityPanel } from "./events/CapabilityPanel";
import { SubscribeForm, type SubscribeFormValue } from "./events/SubscribeForm";
import {
  SubscriptionsPanel,
  type SubscriptionAction,
} from "./events/SubscriptionsPanel";
import { SimulatePanel } from "./events/SimulatePanel";
import { EventsFeedPanel, RejectionsPanel } from "./events/EventsFeedPanel";
import {
  DeliveryChips,
  DraftHeader,
  SchemaViewer,
  Section,
} from "./events/EventsTabSections";
import { EventTypesSidebar } from "./events/EventTypesSidebar";
import { useEventsCatalog } from "./events/use-events-catalog";
import { useEventsFeed } from "./events/use-events-feed";
import { errorMessage, logicalIdOf } from "./events/event-utils";

interface EventsTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  isActive?: boolean;
  /** Refetch the catalog when the connection reaches "connected". */
  connectionStatus?: string;
  /** The Convex project (hosted registry, viewer tokens, simulations). */
  projectId?: string | null;
}

export function EventsTab({
  serverConfig,
  serverName,
  isActive = true,
  connectionStatus,
  projectId = null,
}: EventsTabProps) {
  const hosted = isHostedMode();
  const hasServer = Boolean(serverConfig && serverName);
  const connected =
    connectionStatus === undefined || connectionStatus === "connected";

  useEffect(() => {
    track("events_tab_viewed", { location: "events_tab" });
  }, []);

  const [profileId, setProfileId] = useState<EventsProfileIdView>(
    DRAFT_EVENTS_PROFILE_ID,
  );
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [subscribing, setSubscribing] = useState(false);
  const [busySubscriptionId, setBusySubscriptionId] = useState<string | null>(
    null,
  );
  const [simulating, setSimulating] = useState(false);
  const [slotStates, setSlotStates] = useState<
    Record<string, EventsSlotStateResponse>
  >({});
  const [localSubscriptions, setLocalSubscriptions] = useState<
    Map<string, EventsSubscriptionView>
  >(() => new Map());
  const [registryError, setRegistryError] = useState<string | null>(null);

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

  useEffect(() => {
    if (hosted || !serverName || !declared) return;
    let cancelled = false;
    listLocalEventSubscriptions(serverName)
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
  }, [hosted, serverName, declared, upsertLocal]);

  const allSubscriptions = useMemo<EventsSubscriptionView[]>(
    () =>
      hosted
        ? (hostedRows ?? []).map(hostedSubscriptionRowToView)
        : [...localSubscriptions.values()],
    [hosted, hostedRows, localSubscriptions],
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
    projectId,
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

  // The feed is the inbox's (project- or runtime-wide); show this server's
  // entries, and entries no known subscription claims.
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

  const handleSubscribe = async (value: SubscribeFormValue) => {
    if (!serverName || !selectedEvent) return;
    const event = selectedEvent;
    setSubscribing(true);
    try {
      await runByMode({
        hosted: async () => {
          if (!projectId) {
            throw new Error("Open a project to subscribe on hosted MCPJam.");
          }
          if (!hostedServerId) {
            throw new Error("Add this server to the project to subscribe to its events.");
          }
          const descriptor = await buildHostedEventDescriptor(event);
          await createHostedSubscription({
            projectId,
            serverId: hostedServerId,
            eventName: event.name,
            arguments: value.arguments,
            mode: value.mode,
            profile: profileId,
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
        },
        local: async () => {
          const subscription = await createLocalEventSubscription({
            serverId: serverName,
            eventName: event.name,
            arguments: value.arguments,
            mode: value.mode,
            profile: profileId,
            ...(value.maxAgeMs !== undefined
              ? { maxAgeMs: value.maxAgeMs }
              : {}),
            ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs } : {}),
            ...(value.insecureLocalReceiver
              ? { overrides: ["insecure-local-receiver" as const] }
              : {}),
          });
          upsertLocal([subscription]);
        },
      });
      toast.success(`Subscribed to ${event.name}`);
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
              upsertLocal([
                await setLocalEventSubscriptionState(
                  subscription.id,
                  action.desiredState,
                ),
              ]);
            },
          });
          break;
        case "rotate":
          await runByMode({
            hosted: async () => {
              await requestHostedRotation({ subscriptionId: subscription.id });
            },
            local: async () => {
              upsertLocal([
                await rotateLocalEventSubscriptionSecret(subscription.id),
              ]);
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

  const handleSimulate = async (request: EventsSimulateRequest) => {
    setSimulating(true);
    try {
      const result = await simulateEvent({ projectId, request });
      if (result.entry) feed.ingestEntries([result.entry]);
      toast.success(
        result.entry
          ? "Simulated event added to the feed"
          : "Simulated event accepted; it will appear in the feed",
      );
    } catch (error) {
      toast.error(
        errorMessage(error, "Could not simulate the event. Try again."),
      );
    } finally {
      setSimulating(false);
    }
  };

  // ── render ──────────────────────────────────────────────────────────────
  if (!hasServer) {
    return (
      <EmptyState
        icon={Radio}
        title="No Server Selected"
        description="Connect to an MCP server to inspect the events it declares."
      />
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

  if (!catalog.support.declared) {
    return (
      <div className="flex h-full flex-col overflow-auto">
        <DraftHeader profileId={profileId} onProfileChange={setProfileId} />
        <EmptyState
          icon={Radio}
          className="py-12"
          title="This server does not declare events"
          description="MCPJam sends it no events requests. Ask the server's maintainer to enable events."
        />
        <div className="mx-auto w-full max-w-2xl px-5 pb-8">
          <CapabilityPanel catalog={catalog} />
        </div>
      </div>
    );
  }

  const sidebarContent = (
    <EventTypesSidebar
      catalog={catalog}
      profileId={profileId}
      selectedEventName={selectedEventName}
      loadingMore={loadingMore}
      onSelectEvent={setSelectedEventName}
      onLoadMore={loadMoreEvents}
      onRefresh={retryCatalog}
      onHide={() => setIsSidebarVisible(false)}
    />
  );

  const hostedRegistryNotice =
    hosted && !projectId
      ? "Open a project to manage its subscriptions."
      : hosted && !hostedServerId
        ? "Add this server to the project to subscribe to its events."
        : null;

  const centerContent = (
    <ScrollArea className="h-full">
      <div className="pb-16">
        <DraftHeader profileId={profileId} onProfileChange={setProfileId} />
        {hostedRegistryNotice ? (
          <p className="mx-5 mt-4 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
            {hostedRegistryNotice}
          </p>
        ) : null}

        {selectedEvent ? (
          <Section
            title={selectedEvent.name}
            description={selectedEvent.description}
          >
            <DeliveryChips
              delivery={selectedEvent.delivery}
              profileId={profileId}
            />
            <div className="space-y-1">
              <SchemaViewer
                label="Input schema"
                schema={selectedEvent.inputSchema}
              />
              <SchemaViewer
                label="Payload schema"
                schema={selectedEvent.payloadSchema}
              />
            </div>
            <SubscribeForm
              event={selectedEvent}
              profileId={profileId}
              hosted={hosted}
              busy={subscribing}
              onSubscribe={handleSubscribe}
            />
          </Section>
        ) : null}

        <Section
          title="Subscriptions"
          description={
            hosted
              ? "This server's subscriptions in this project. MCPJam refreshes each one automatically."
              : "This server's subscriptions on this machine."
          }
        >
          {registryError ? (
            <p className="text-xs text-destructive">{registryError}</p>
          ) : null}
          {hosted && projectId && hostedRows === undefined ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <SubscriptionsPanel
              subscriptions={serverSubscriptions}
              hosted={hosted}
              busyId={busySubscriptionId}
              slotStates={slotStates}
              onAction={(subscription, action) =>
                void handleSubscriptionAction(subscription, action)
              }
            />
          )}
        </Section>

        <Section
          title="Simulate an event"
          description={
            <>
              Delivered in the <code className="font-mono">simulation</code>{" "}
              namespace: it runs triggers but can never collide with or suppress
              a live event.
            </>
          }
        >
          <SimulatePanel
            subscriptions={serverSubscriptions.filter(
              (subscription) => subscription.desiredState !== "removed",
            )}
            events={catalog.events}
            busy={simulating}
            onSimulate={handleSimulate}
          />
        </Section>

        <Section
          title="Live feed"
          description="Every delivery the inbox receives, newest first. Treat event data as untrusted."
          actions={
            <Badge variant="outline" className="text-[10px]">
              {hosted ? "Hosted inbox" : "Local inbox"}
            </Badge>
          }
        >
          <EventsFeedPanel
            entries={visibleEntries}
            gaps={feed.gaps}
            status={feed.status}
            error={feed.error}
            labelFor={labelForEntry}
          />
        </Section>

        <Section
          title="Rejected deliveries"
          description={
            hosted
              ? "Recorded per webhook slot (reason, headers, size; never the body or signature). Use Check slot on a subscription to load them."
              : "Deliveries the local receiver refused (reason, headers, size; never the body or signature)."
          }
        >
          <RejectionsPanel rejections={rejections} />
        </Section>
      </div>
    </ScrollArea>
  );

  return (
    <ThreePanelLayout
      id="events"
      sidebar={sidebarContent}
      content={centerContent}
      sidebarVisible={isSidebarVisible}
      onSidebarVisibilityChange={setIsSidebarVisible}
      sidebarTooltip="Show event types"
      serverName={serverName}
    />
  );
}
