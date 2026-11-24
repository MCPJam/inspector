import { useMemo, type ReactNode } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import type {
  EventDescriptorView,
  EventsFeedEntryView,
  EventsListResponse,
  EventsRejectionView,
  EventsSimulateRequest,
  EventsSlotStateResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { CapabilityPanel } from "./CapabilityPanel";
import { EventDefinition } from "./EventDefinition";
import { EventsHeader, Section } from "./EventsTabSections";
import {
  EventsFeedPanel,
  FeedStatusBadge,
  RejectionsPanel,
} from "./EventsFeedPanel";
import { SimulatePanel } from "./SimulatePanel";
import {
  SubscriptionsPanel,
  type SubscriptionAction,
} from "./SubscriptionsPanel";
import type { EventsFeedGap, EventsFeedStatus } from "./use-events-feed";
import {
  describeTermination,
  logicalIdOf,
  type TerminationReason,
} from "./event-utils";

export type EventsWorkspaceView = "received" | "subscriptions" | "definition";

/** Which records the workspace shows. */
export type ActivityScope =
  | { kind: "server" }
  | { kind: "eventType"; name: string }
  | { kind: "subscription"; id: string }
  | { kind: "entry"; seq: number };

export function EventsActivity({
  scope,
  view,
  onViewChange,
  event,
  subscribeAction,
  hostName,
  hosted,
  notice,
  registryError,
  subscriptionsLoading,
  subscriptions,
  busySubscriptionId,
  slotStates,
  onSubscriptionAction,
  entries,
  gaps,
  feedStatus,
  feedError,
  labelForEntry,
  events,
  simulating,
  onSimulate,
  rejections,
  catalog,
}: {
  scope: ActivityScope;
  view: EventsWorkspaceView;
  onViewChange: (view: EventsWorkspaceView) => void;
  event?: EventDescriptorView;
  subscribeAction?: ReactNode;
  hostName: string;
  hosted: boolean;
  notice: string | null;
  registryError: string | null;
  subscriptionsLoading: boolean;
  /** This server's subscriptions. */
  subscriptions: EventsSubscriptionView[];
  busySubscriptionId: string | null;
  slotStates: Record<string, EventsSlotStateResponse>;
  onSubscriptionAction: (
    subscription: EventsSubscriptionView,
    action: SubscriptionAction,
  ) => void;
  /** This server's feed entries, oldest first. */
  entries: EventsFeedEntryView[];
  gaps: EventsFeedGap[];
  feedStatus: EventsFeedStatus;
  feedError: string | null;
  labelForEntry: (entry: EventsFeedEntryView) => string | undefined;
  events: EventDescriptorView[];
  simulating: boolean;
  onSimulate: (request: EventsSimulateRequest) => void | Promise<void>;
  rejections: EventsRejectionView[];
  catalog: EventsListResponse;
}) {
  const subscriptionsByLogicalId = useMemo(
    () =>
      new Map(
        subscriptions.map((subscription) => [
          logicalIdOf(subscription),
          subscription,
        ]),
      ),
    [subscriptions],
  );

  // The latest `terminated` signal per subscription says why it ended.
  const terminations = useMemo(() => {
    const byLogicalId = new Map<string, TerminationReason>();
    for (const entry of entries) {
      if (entry.kind === "terminated") {
        byLogicalId.set(
          entry.logicalSubscriptionId,
          describeTermination(entry.error),
        );
      }
    }
    return byLogicalId;
  }, [entries]);
  const terminationFor = (subscription: EventsSubscriptionView) =>
    subscription.observedState === "terminated"
      ? (terminations.get(logicalIdOf(subscription)) ?? {
          label: "Terminated",
          hint: subscription.lastError?.message,
        })
      : null;

  const selectedEntry =
    scope.kind === "entry"
      ? entries.find((entry) => entry.seq === scope.seq)
      : undefined;
  const scopedSubscriptions = subscriptions.filter((subscription) => {
    switch (scope.kind) {
      case "eventType":
        return subscription.eventName === scope.name;
      case "subscription":
        return subscription.id === scope.id;
      case "entry":
        return (
          selectedEntry !== undefined &&
          logicalIdOf(subscription) === selectedEntry.logicalSubscriptionId
        );
      default:
        return true;
    }
  });
  const scopedLogicalIds = new Set(scopedSubscriptions.map(logicalIdOf));
  const scopedEntries = entries.filter((entry) => {
    switch (scope.kind) {
      case "eventType":
        return (
          entry.name === scope.name ||
          subscriptionsByLogicalId.get(entry.logicalSubscriptionId)
            ?.eventName === scope.name
        );
      case "subscription":
        return scopedLogicalIds.has(entry.logicalSubscriptionId);
      case "entry":
        return entry.seq === scope.seq;
      default:
        return true;
    }
  });

  const scopeLabel =
    scope.kind === "eventType"
      ? scope.name
      : scope.kind === "subscription"
        ? (scopedSubscriptions[0]?.eventName ?? "subscription")
        : scope.kind === "entry"
          ? (selectedEntry?.name ?? `#${scope.seq}`)
          : null;
  const emptySubscriptions =
    scope.kind === "eventType"
      ? "No subscriptions to this event type yet."
      : scope.kind === "entry"
        ? "No known subscription received this event."
        : "No subscriptions on this server yet. Pick an event type to subscribe.";

  return (
    <Tabs
      value={view === "definition" && !event ? "received" : view}
      onValueChange={(value) => {
        if (
          value === "received" ||
          value === "subscriptions" ||
          value === "definition"
        ) {
          onViewChange(value);
        }
      }}
      className="h-full min-w-0 gap-0 overflow-hidden"
      data-testid="events-activity"
    >
      <div className="shrink-0">
        <EventsHeader
          title={scopeLabel ?? "Activity"}
          monospaceTitle={scopeLabel !== null}
          profile={catalog.support.beta ? "beta" : "legacy"}
          action={subscribeAction}
        >
          <span
            className="text-[11px] text-muted-foreground"
            title="The client MCPJam subscribes as"
            data-testid="events-host-label"
          >
            Client: {hostName}
          </span>
          <FeedStatusBadge status={feedStatus} />
          <Badge variant="outline" className="text-[10px]">
            {hosted ? "Hosted inbox" : "Local inbox"}
          </Badge>
        </EventsHeader>
        <div className="overflow-x-auto border-b border-border px-4 py-2">
          <TabsList aria-label="Event workspace">
            <TabsTrigger value="received">Received</TabsTrigger>
            <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
            <TabsTrigger value="definition" disabled={!event}>
              Definition
            </TabsTrigger>
          </TabsList>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-16">
          {notice ? (
            <p className="mx-5 mt-4 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
              {notice}
            </p>
          ) : null}

          <TabsContent value="received">
            <Section
              title="Received"
              description="Newest first. Event data comes from the server's upstream; treat it as untrusted."
            >
              <EventsFeedPanel
                entries={scopedEntries}
                gaps={gaps}
                status={feedStatus}
                error={feedError}
                labelFor={labelForEntry}
                showStatus={false}
              />
            </Section>
          </TabsContent>
          <TabsContent value="subscriptions">
            <Section title="Subscriptions">
              {registryError ? (
                <p className="text-xs text-destructive">{registryError}</p>
              ) : null}
              {subscriptionsLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (
                <SubscriptionsPanel
                  subscriptions={scopedSubscriptions}
                  hosted={hosted}
                  busyId={busySubscriptionId}
                  slotStates={slotStates}
                  emptyText={emptySubscriptions}
                  terminationFor={terminationFor}
                  onAction={onSubscriptionAction}
                />
              )}
            </Section>
          </TabsContent>
          <TabsContent value="definition">
            {event ? <EventDefinition key={event.name} event={event} /> : null}
          </TabsContent>

          <Accordion type="multiple" className="px-5">
            <AccordionItem value="simulate">
              <AccordionTrigger className="text-xs">
                Simulate an event
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <p
                  className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-foreground"
                  data-testid="simulate-warning"
                >
                  Simulated events stay in MCPJam&apos;s{" "}
                  <code className="font-mono">simulation</code> namespace and
                  never reach the server. Matching triggers still run; live events
                  are never affected.
                </p>
                <SimulatePanel
                  subscriptions={subscriptions.filter(
                    (subscription) => subscription.desiredState !== "removed",
                  )}
                  events={events}
                  busy={simulating}
                  onSimulate={onSimulate}
                />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="rejections">
              <AccordionTrigger className="text-xs">
                Rejected deliveries
                {rejections.length > 0 ? ` (${rejections.length})` : ""}
              </AccordionTrigger>
              <AccordionContent className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  {hosted
                    ? "Recorded per webhook slot (reason, headers, size; never the body or signature). Use Check inbox on a subscription to load them."
                    : "Deliveries the local receiver refused (reason, headers, size; never the body or signature)."}
                </p>
                <RejectionsPanel rejections={rejections} />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="capability">
              <AccordionTrigger className="text-xs">
                Server capability
              </AccordionTrigger>
              <AccordionContent>
                <CapabilityPanel catalog={catalog} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </ScrollArea>
    </Tabs>
  );
}
