import type { ReactNode } from "react";
import { Radio } from "lucide-react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { EmptyState } from "@/components/ui/empty-state";
import type {
  EventDescriptorView,
  EventsFeedEntryView,
  EventsRejectionView,
  EventsSlotStateResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { EventDefinition } from "./EventDefinition";
import { EventsHeader } from "./EventsTabSections";
import {
  EventOccurrenceDetails,
  FeedStatusBadge,
  RejectionsPanel,
} from "./EventsFeedPanel";
import {
  SubscriptionsPanel,
  type SubscriptionAction,
} from "./SubscriptionsPanel";
import type { EventsFeedGap, EventsFeedStatus } from "./use-events-feed";
import type { EventsBrowseTab } from "./EventsSidebar";
import {
  describeTermination,
  logicalIdOf,
  type TerminationReason,
} from "./event-utils";

export function EventsActivity({
  activeTab,
  event,
  subscription,
  occurrence,
  subscribeAction,
  subscribeContent,
  hosted,
  notice,
  registryError,
  subscriptionsLoading,
  busySubscriptionId,
  slotStates,
  onSubscriptionAction,
  entries,
  gaps,
  feedStatus,
  feedError,
  labelForEntry,
  rejections,
}: {
  activeTab: EventsBrowseTab;
  event?: EventDescriptorView;
  subscription?: EventsSubscriptionView;
  occurrence?: EventsFeedEntryView;
  subscribeAction?: ReactNode;
  subscribeContent?: ReactNode;
  hosted: boolean;
  notice: string | null;
  registryError: string | null;
  subscriptionsLoading: boolean;
  busySubscriptionId: string | null;
  slotStates: Record<string, EventsSlotStateResponse>;
  onSubscriptionAction: (
    subscription: EventsSubscriptionView,
    action: SubscriptionAction,
  ) => void;
  entries: EventsFeedEntryView[];
  gaps: EventsFeedGap[];
  feedStatus: EventsFeedStatus;
  feedError: string | null;
  labelForEntry: (entry: EventsFeedEntryView) => string | undefined;
  rejections: EventsRejectionView[];
}) {
  const terminationFor = (
    selected: EventsSubscriptionView,
  ): TerminationReason | null => {
    if (selected.observedState !== "terminated") return null;
    const termination = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.kind === "terminated" &&
          entry.logicalSubscriptionId === logicalIdOf(selected),
      );
    return termination
      ? describeTermination(termination.error)
      : { label: "Terminated", hint: selected.lastError?.message };
  };
  const emptyTitle =
    activeTab === "events"
      ? "Select an event"
      : activeTab === "subscriptions"
        ? "Select a subscription"
        : "Select an occurrence";
  const emptyDescription =
    activeTab === "events"
      ? "Choose an event to inspect its details and subscribe."
      : activeTab === "subscriptions"
        ? "Choose a subscription to inspect its status and manage delivery."
        : "Choose an occurrence to inspect its payload.";
  const empty = (
    <EmptyState
      icon={Radio}
      title={emptyTitle}
      description={emptyDescription}
      className="min-h-64"
    />
  );

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-hidden"
      data-testid="events-activity"
    >
      {activeTab === "events" && event ? (
        <EventsHeader
          title={event.name}
          description={event.description}
          monospaceTitle
          action={subscribeAction}
        />
      ) : null}
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
              activeTab === "events"
                ? "Subscribe"
                : activeTab === "subscriptions"
                  ? "Subscriptions"
                  : "Occurrences"
            }
          >
            {activeTab === "events" ? (
              event ? (
                <>
                  {subscribeContent}
                  <Accordion type="single" collapsible className="mt-4">
                    <AccordionItem value="definition">
                      <AccordionTrigger>Event type details</AccordionTrigger>
                      <AccordionContent>
                        <EventDefinition key={event.name} event={event} />
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </>
              ) : (
                empty
              )
            ) : activeTab === "subscriptions" ? (
              subscriptionsLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : subscription ? (
                <SubscriptionsPanel
                  subscriptions={[subscription]}
                  hosted={hosted}
                  busyId={busySubscriptionId}
                  slotStates={slotStates}
                  emptyText=""
                  terminationFor={terminationFor}
                  onAction={onSubscriptionAction}
                  defaultOpen
                />
              ) : (
                empty
              )
            ) : occurrence ? (
              <ul>
                <EventOccurrenceDetails
                  key={occurrence.seq}
                  entry={occurrence}
                  subscriptionLabel={labelForEntry(occurrence)}
                />
              </ul>
            ) : (
              empty
            )}
          </div>
          {activeTab === "occurrences" ? (
            <>
              {gaps.map((gap) => (
                <p
                  key={`${gap.fromSeq}-${gap.toSeq}`}
                  className="text-xs text-muted-foreground"
                >
                  Entries #{gap.fromSeq} to #{gap.toSeq} are no longer in the
                  inbox's history.
                </p>
              ))}
              {rejections.length > 0 ? (
                <Accordion type="single" collapsible>
                  <AccordionItem value="rejections">
                    <AccordionTrigger className="text-xs">
                      Rejected deliveries ({rejections.length})
                    </AccordionTrigger>
                    <AccordionContent>
                      <RejectionsPanel rejections={rejections} />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : null}
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
