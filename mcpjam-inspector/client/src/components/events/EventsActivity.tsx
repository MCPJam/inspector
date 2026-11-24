import { useMemo, type ReactNode } from "react";
import { Badge } from "@mcpjam/design-system/badge";
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
import { DraftHeader, Section } from "./EventsTabSections";
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

/** What the middle pane is showing, from the left pane's selection. */
export type ActivityScope =
  | { kind: "server" }
  | { kind: "eventType"; name: string }
  | { kind: "subscription"; id: string }
  | { kind: "entry"; seq: number };

function ScopeLabel({ children }: { children: ReactNode }) {
  return (
    <code className="truncate font-mono text-[11px] text-muted-foreground">
      {children}
    </code>
  );
}

/**
 * The Events middle pane: the subscriptions and received events for what is
 * selected on the left (an event type, a subscription, one received event,
 * or the whole server), then simulation, rejected deliveries and the
 * server's declared capability on demand.
 */
export function EventsActivity({
  scope,
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
      ? "No subscriptions to this event type yet. Configure it in the left pane, then subscribe."
      : scope.kind === "entry"
        ? "No known subscription received this event."
        : "No subscriptions on this server yet. Pick an event type to subscribe.";

  return (
    <ScrollArea className="h-full">
      <div className="pb-16" data-testid="events-activity">
        <DraftHeader title="Activity">
          {scopeLabel ? <ScopeLabel>{scopeLabel}</ScopeLabel> : null}
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
        </DraftHeader>
        {notice ? (
          <p className="mx-5 mt-4 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
            {notice}
          </p>
        ) : null}

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
  );
}
