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
import { cn } from "@mcpjam/design-system/cn";
import {
  AlertCircle,
  Loader2,
  PanelLeftClose,
  Radio,
  RefreshCw,
} from "lucide-react";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import { EmptyState } from "./ui/empty-state";
import { JsonEditor } from "@/components/ui/json-editor";
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
  loadEventsCatalog,
  resolveHostedEventsServerId,
  rotateLocalEventSubscriptionSecret,
  setLocalEventSubscriptionState,
  simulateEvent,
} from "@/lib/apis/mcp-events-api";
import {
  DRAFT_EVENTS_PROFILE_ID,
  EVENTS_DRAFT_COMMIT,
  EVENTS_DRAFT_SOURCE_URL,
  EVENTS_PROFILES,
  getEventsProfile,
  usableDeliveryModes,
} from "@/lib/events-profiles";
import { logEventsFeedEntries } from "@/lib/events-traffic";
import type {
  EventDescriptorView,
  EventsFeedEntryView,
  EventsListResponse,
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
import { useEventsFeed } from "./events/use-events-feed";
import { logicalIdOf } from "./events/event-utils";

interface EventsTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  isActive?: boolean;
  /** Refetch the catalog when the connection reaches "connected". */
  connectionStatus?: string;
  /** The Convex project (hosted registry, viewer tokens, simulations). */
  projectId?: string | null;
}

type CatalogState = "idle" | "loading" | "ready" | "error";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-border px-5 py-5 last:border-b-0">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/**
 * "Draft" is a label, not a gate (per the events plan): the extension is a
 * working-group draft pinned at one commit, and every result is judged by a
 * named profile.
 */
function DraftHeader({
  profileId,
  onProfileChange,
}: {
  profileId: EventsProfileIdView;
  onProfileChange: (profileId: EventsProfileIdView) => void;
}) {
  const profile = getEventsProfile(profileId);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <Radio className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold text-foreground">Events</h2>
      <a
        href={EVENTS_DRAFT_SOURCE_URL}
        target="_blank"
        rel="noreferrer"
        className="rounded-sm border border-pending/40 bg-pending/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:underline"
        title="MCP Events is a working-group draft; MCPJam implements the commit it is pinned to."
        data-testid="events-draft-badge"
      >
        Draft · {EVENTS_DRAFT_COMMIT}
      </a>
      <div className="ml-auto flex items-center gap-2">
        <label
          htmlFor="events-profile"
          className="text-[11px] text-muted-foreground"
        >
          Profile
        </label>
        <select
          id="events-profile"
          aria-label="Events profile"
          value={profileId}
          onChange={(e) =>
            onProfileChange(e.target.value as EventsProfileIdView)
          }
          className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          title={profile.description}
        >
          {EVENTS_PROFILES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DeliveryChips({
  delivery,
  profileId,
}: {
  delivery: string[];
  profileId: EventsProfileIdView;
}) {
  const usable = new Set<string>(usableDeliveryModes(delivery, profileId));
  return (
    <div className="flex flex-wrap gap-1">
      {delivery.map((mode) => (
        <span
          key={mode}
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
            usable.has(mode)
              ? "border-border bg-secondary text-secondary-foreground"
              : "border-border text-muted-foreground line-through",
          )}
          title={
            usable.has(mode)
              ? undefined
              : `Not used by the ${getEventsProfile(profileId).label} profile`
          }
        >
          {mode}
        </span>
      ))}
    </div>
  );
}

function SchemaViewer({
  label,
  schema,
}: {
  label: string;
  schema?: Record<string, unknown>;
}) {
  if (!schema) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {label}: none declared
      </p>
    );
  }
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">
        {label}
      </summary>
      <div className="mt-1 max-h-72 overflow-auto rounded-md border border-border">
        <JsonEditor
          value={schema}
          viewOnly
          collapsible
          defaultExpandDepth={3}
        />
      </div>
    </details>
  );
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
  const [catalog, setCatalog] = useState<EventsListResponse | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedEventName, setSelectedEventName] = useState<string | null>(
    null,
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
  useEffect(() => {
    if (!hasServer || !serverName || !connected) return;
    let cancelled = false;
    setCatalogState("loading");
    setCatalogError(null);
    loadEventsCatalog(serverName)
      .then((result) => {
        if (cancelled) return;
        setCatalog(result);
        setCatalogState("ready");
        setSelectedEventName((previous) =>
          result.events.some((event) => event.name === previous)
            ? previous
            : (result.events[0]?.name ?? null),
        );
      })
      .catch((error) => {
        if (cancelled) return;
        setCatalog(null);
        setCatalogState("error");
        setCatalogError(errorMessage(error, "Could not read events support."));
      });
    return () => {
      cancelled = true;
    };
  }, [hasServer, serverName, connected, catalogAttempt]);

  const declared =
    catalogState === "ready" && catalog?.support.declared === true;

  const loadMoreEvents = useCallback(async () => {
    if (!serverName || !catalog?.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await loadEventsCatalog(serverName, catalog.nextCursor);
      setCatalog((previous) =>
        previous
          ? {
              ...previous,
              events: [...previous.events, ...page.events],
              nextCursor: page.nextCursor,
            }
          : page,
      );
    } catch (error) {
      toast.error(errorMessage(error, "Could not load more events."));
    } finally {
      setLoadingMore(false);
    }
  }, [serverName, catalog?.nextCursor]);

  // ── registry ────────────────────────────────────────────────────────────
  // The hosted server id comes from the API context, which fills in after
  // bootstrap; re-read it whenever that context changes.
  const apiContextRevision = useSyncExternalStore(
    subscribeApiContext,
    getApiContextRevision,
    getApiContextRevision,
  );
  const hostedServerId = useMemo(
    () =>
      hosted && serverName ? resolveHostedEventsServerId(serverName) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hosted, serverName, apiContextRevision],
  );
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
            errorMessage(error, "Could not list subscriptions."),
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
            throw new Error("This server is not in the hosted project yet.");
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
      toast.error(errorMessage(error, "Subscribing failed."));
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
      toast.error(errorMessage(error, "The subscription update failed."));
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
          ? "Simulated event journalled"
          : "Simulated event accepted; it will appear in the feed",
      );
    } catch (error) {
      toast.error(errorMessage(error, "Simulating the event failed."));
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
        description="Events support is read from the handshake, so the server has to finish connecting first."
      />
    );
  }

  if (catalogState === "error") {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Couldn't read events support"
        description={catalogError ?? "The events check failed."}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCatalogAttempt((attempt) => attempt + 1)}
        >
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
          description="The handshake carried no capabilities.events, so MCPJam sends no events requests to it. A server opts in by declaring capabilities.events in its initialize (or server/discover) result."
        />
        <div className="mx-auto w-full max-w-2xl px-5 pb-8">
          <CapabilityPanel catalog={catalog} />
        </div>
      </div>
    );
  }

  const sidebarContent = (
    <div className="flex h-full flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-foreground">
          Event types
        </span>
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title="Refresh events"
            aria-label="Refresh events"
            onClick={() => setCatalogAttempt((attempt) => attempt + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title="Hide sidebar"
            onClick={() => setIsSidebarVisible(false)}
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3 pb-16">
          <CapabilityPanel catalog={catalog} />
          {catalog.events.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              The server declares events but lists no event types.
            </p>
          ) : (
            <ul className="space-y-1" data-testid="event-types">
              {catalog.events.map((event) => (
                <li key={event.name}>
                  <button
                    type="button"
                    onClick={() => setSelectedEventName(event.name)}
                    aria-pressed={event.name === selectedEventName}
                    className={cn(
                      "w-full space-y-1 rounded-md border px-2.5 py-2 text-left",
                      event.name === selectedEventName
                        ? "border-primary/50 bg-primary/5"
                        : "border-transparent hover:bg-accent",
                    )}
                  >
                    <span className="block font-mono text-xs font-medium text-foreground">
                      {event.name}
                    </span>
                    {event.description ? (
                      <span className="line-clamp-2 block text-[11px] text-muted-foreground">
                        {event.description}
                      </span>
                    ) : null}
                    <DeliveryChips
                      delivery={event.delivery}
                      profileId={profileId}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {catalog.nextCursor ? (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              disabled={loadingMore}
              onClick={() => void loadMoreEvents()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );

  const hostedRegistryNotice =
    hosted && !projectId
      ? "Open a project to manage subscriptions: the hosted registry is per project."
      : hosted && !hostedServerId
        ? "This server is not in the hosted project yet, so it cannot be subscribed to."
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
              ? "This server's subscriptions in the project registry. MCPJam's keeper keeps each one refreshed."
              : "This server's subscriptions in the local events runtime."
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
          description="Every delivery the inbox journals, newest first. Event data is shown as untrusted data."
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
