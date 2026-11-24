import { useMemo, type ReactNode } from "react";
import { InspectorPaneHeader } from "@/components/ui/inspector-pane-header";
import { EventTriggerSheet } from "./EventTriggerSheet";
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
import { EventsHeader } from "./EventsTabSections";
import {
  EventsFeedPanel,
  FeedStatusBadge,
  RejectionsPanel,
} from "./EventsFeedPanel";
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
  | { kind: "eventType"; name: string };

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
  onSimulate: (request: EventsSimulateRequest) => Promise<boolean>;
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

  const scopedSubscriptions = subscriptions.filter(
    (subscription) =>
      scope.kind === "server" || subscription.eventName === scope.name,
  );
  const scopedEntries = entries.filter(
    (entry) =>
      scope.kind === "server" ||
      entry.name === scope.name ||
      subscriptionsByLogicalId.get(entry.logicalSubscriptionId)?.eventName ===
        scope.name,
  );
  const availableSubscriptions = scopedSubscriptions.filter(
    (subscription) => subscription.desiredState !== "removed",
  );
  const hasUncheckedInboxes =
    hosted &&
    subscriptions.some(
      (subscription) =>
        subscription.mode === "webhook" &&
        subscription.desiredState !== "removed" &&
        !slotStates[subscription.id],
    );
  const activeView = view === "definition" && !event ? "received" : view;
  const scopeLabel = scope.kind === "eventType" ? scope.name : "All events";
  const emptySubscriptions =
    scope.kind === "eventType"
      ? "No subscriptions yet. Subscribe to start receiving this event."
      : "No subscriptions on this server yet. Choose an event from the catalog to subscribe.";

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden"
      data-testid="events-activity"
    >
      <EventsHeader
        title={scopeLabel}
        description={event?.description}
        monospaceTitle={scope.kind === "eventType"}
        action={
          <>
            <EventTriggerSheet
              key={scopeLabel}
              subscriptions={availableSubscriptions}
              events={events}
              busy={simulating}
              onSimulate={onSimulate}
            />
            {subscribeAction}
          </>
        }
      />
      <InspectorPaneHeader<EventsWorkspaceView>
        ariaLabel="Event workspace"
        tabs={[
          {
            id: "received",
            label: "Received",
            count: scopedEntries.filter((entry) => entry.kind === "event")
              .length,
          },
          {
            id: "subscriptions",
            label: "Subscriptions",
            count: availableSubscriptions.length,
          },
          ...(event
            ? [{ id: "definition" as const, label: "Definition" }]
            : []),
        ]}
        activeTab={activeView}
        onTabChange={onViewChange}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {notice ? (
            <p className="text-xs text-muted-foreground">{notice}</p>
          ) : null}
          {registryError ? (
            <p role="alert" className="text-xs text-destructive">
              {registryError}
            </p>
          ) : null}
          {feedStatus === "error" ||
          feedStatus === "reconnecting" ||
          feedError ? (
            <div
              role="status"
              className="flex items-center gap-2 text-xs text-destructive"
            >
              <FeedStatusBadge status={feedStatus} />
              {feedError}
            </div>
          ) : null}
          <div
            role="tabpanel"
            aria-label={
              activeView === "received"
                ? "Received"
                : activeView === "subscriptions"
                  ? "Subscriptions"
                  : "Definition"
            }
          >
            {activeView === "received" ? (
              <EventsFeedPanel
                entries={scopedEntries}
                gaps={gaps}
                status={feedStatus}
                error={null}
                labelFor={labelForEntry}
                showStatus={false}
              />
            ) : activeView === "subscriptions" ? (
              subscriptionsLoading ? (
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
              )
            ) : event ? (
              <EventDefinition key={event.name} event={event} />
            ) : null}
          </div>
          <Accordion type="multiple">
            <AccordionItem value="rejections">
              <AccordionTrigger className="text-xs">
                Rejected deliveries
                {rejections.length > 0 ? ` (${rejections.length})` : ""}
              </AccordionTrigger>
              <AccordionContent>
                {hasUncheckedInboxes ? (
                  <p className="mb-2 text-xs text-muted-foreground">
                    Open a subscription and choose Check inbox to load rejected
                    deliveries.
                  </p>
                ) : null}
                {!hasUncheckedInboxes || rejections.length > 0 ? (
                  <RejectionsPanel rejections={rejections} />
                ) : null}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="capability">
              <AccordionTrigger className="text-xs">
                Server details
              </AccordionTrigger>
              <AccordionContent className="space-y-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px]">
                  <dt className="text-muted-foreground">Client</dt>
                  <dd data-testid="events-host-label">{hostName}</dd>
                  <dt className="text-muted-foreground">Inbox</dt>
                  <dd>{hosted ? "Hosted" : "Local"}</dd>
                  <dt className="text-muted-foreground">Feed connection</dt>
                  <dd>
                    <FeedStatusBadge status={feedStatus} />
                  </dd>
                </dl>
                <CapabilityPanel catalog={catalog} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </ScrollArea>
    </div>
  );
}
