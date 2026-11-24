import { useMemo, useState } from "react";
import { PanelLeftClose, RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import type { SubscribableModes } from "@mcpjam/sdk/browser";
import { InspectorPaneHeader } from "@/components/ui/inspector-pane-header";
import { SearchInput } from "@/components/ui/search-input";
import type {
  EventDescriptorView,
  EventsFeedEntryView,
  EventsListResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { EventsListItem } from "./EventsListItem";
import { DeliveryChips } from "./EventsTabSections";
import { formatTime, observedStateLabel } from "./event-utils";

export type EventsPaneTab = "events" | "subscriptions" | "received";

const SEARCH_PLACEHOLDERS: Record<EventsPaneTab, string> = {
  events: "Search event types...",
  subscriptions: "Search subscriptions...",
  received: "Search received events...",
};

function matches(query: string, ...values: Array<string | undefined>) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => value?.toLowerCase().includes(needle));
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
  );
}

export function EventsSidebar({
  tab,
  onTabChange,
  catalog,
  loadingMore,
  onLoadMore,
  onRefresh,
  onHide,
  selectedEventName,
  onSelectEvent,
  availabilityFor,
  hostName,
  subscriptions,
  activeSubscriptionCount,
  selectedSubscriptionId,
  onSelectSubscription,
  entries,
  selectedEntrySeq,
  onSelectEntry,
  labelForEntry,
}: {
  tab: EventsPaneTab;
  onTabChange: (tab: EventsPaneTab) => void;
  catalog: EventsListResponse;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onRefresh: () => void;
  onHide: () => void;
  selectedEventName: string | null;
  onSelectEvent: (eventName: string | null) => void;
  availabilityFor: (
    event: EventDescriptorView,
  ) => SubscribableModes | undefined;
  hostName: string;
  subscriptions: EventsSubscriptionView[];
  activeSubscriptionCount: number;
  selectedSubscriptionId: string | null;
  onSelectSubscription: (id: string | null) => void;
  /** This server's feed entries, oldest first. */
  entries: EventsFeedEntryView[];
  selectedEntrySeq: number | null;
  onSelectEntry: (seq: number | null) => void;
  labelForEntry: (entry: EventsFeedEntryView) => string | undefined;
}) {
  const [query, setQuery] = useState("");
  const receivedCount = entries.filter(
    (entry) => entry.kind === "event",
  ).length;

  return (
    <div className="flex h-full flex-col border-r border-border bg-background">
      <InspectorPaneHeader<EventsPaneTab>
        ariaLabel="Browse events"
        tabs={[
          {
            id: "events",
            label: "Events",
            count: catalog.nextCursor
              ? `${catalog.events.length}+`
              : catalog.events.length,
            countTitle: catalog.nextCursor
              ? "Event types loaded so far; the server has more"
              : "Event types this server lists",
          },
          {
            id: "subscriptions",
            label: "Subscriptions",
            count: activeSubscriptionCount,
            countTitle: "Active subscriptions on this server",
          },
          {
            id: "received",
            label: "Received",
            count: receivedCount,
            countTitle: "Received events loaded in this view",
          },
        ]}
        activeTab={tab}
        onTabChange={onTabChange}
        secondaryActions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Refresh event types"
              aria-label="Refresh event types"
              onClick={onRefresh}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden h-7 w-7 p-0 md:inline-flex"
              title="Hide sidebar"
              onClick={onHide}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-shrink-0 px-3 py-2">
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder={SEARCH_PLACEHOLDERS[tab]}
          />
        </div>
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="space-y-2 p-3 pb-16">
              {tab === "events" ? (
                <EventTypeList
                  catalog={catalog}
                  query={query}
                  loadingMore={loadingMore}
                  onLoadMore={onLoadMore}
                  onSelect={onSelectEvent}
                  availabilityFor={availabilityFor}
                  hostName={hostName}
                  selectedEventName={selectedEventName}
                />
              ) : tab === "subscriptions" ? (
                <SubscriptionList
                  subscriptions={subscriptions}
                  query={query}
                  selectedId={selectedSubscriptionId}
                  onSelect={onSelectSubscription}
                />
              ) : (
                <ReceivedList
                  entries={entries}
                  query={query}
                  selectedSeq={selectedEntrySeq}
                  onSelect={onSelectEntry}
                  labelFor={labelForEntry}
                />
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function EventTypeList({
  catalog,
  query,
  loadingMore,
  onLoadMore,
  onSelect,
  availabilityFor,
  hostName,
  selectedEventName,
}: {
  catalog: EventsListResponse;
  query: string;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onSelect: (eventName: string | null) => void;
  availabilityFor: (
    event: EventDescriptorView,
  ) => SubscribableModes | undefined;
  hostName: string;
  selectedEventName: string | null;
}) {
  const visible = useMemo(
    () =>
      catalog.events.filter((event) =>
        matches(query, event.name, event.description),
      ),
    [catalog.events, query],
  );

  if (catalog.events.length === 0) {
    return <EmptyText>This server lists no event types.</EmptyText>;
  }
  return (
    <>
      {visible.length === 0 ? (
        <EmptyText>No event types match your search.</EmptyText>
      ) : (
        <ul className="space-y-2" data-testid="event-types">
          {visible.map((event) => (
            <li key={event.name}>
              <EventsListItem
                title={event.name}
                description={event.description}
                meta={
                  <DeliveryChips
                    delivery={event.delivery}
                    availability={availabilityFor(event)}
                    hostName={hostName}
                  />
                }
                selected={event.name === selectedEventName}
                onClick={() =>
                  onSelect(event.name === selectedEventName ? null : event.name)
                }
              />
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
          onClick={() => void onLoadMore()}
        >
          {loadingMore ? "Loading…" : "Load more event types"}
        </Button>
      ) : null}
    </>
  );
}

function SubscriptionList({
  subscriptions,
  query,
  selectedId,
  onSelect,
}: {
  subscriptions: EventsSubscriptionView[];
  query: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (subscriptions.length === 0) {
    return (
      <EmptyText>
        No subscriptions on this server yet. Pick an event type to subscribe.
      </EmptyText>
    );
  }
  const visible = subscriptions.filter((subscription) =>
    matches(query, subscription.eventName, subscription.mode),
  );
  if (visible.length === 0) {
    return <EmptyText>No subscriptions match your search.</EmptyText>;
  }
  return (
    <ul className="space-y-2" data-testid="subscription-list">
      {visible.map((subscription) => (
        <li key={subscription.id}>
          <EventsListItem
            title={subscription.eventName}
            description={`${subscription.mode} · ${observedStateLabel(subscription.observedState)}`}
            selected={subscription.id === selectedId}
            onClick={() =>
              onSelect(subscription.id === selectedId ? null : subscription.id)
            }
          />
        </li>
      ))}
    </ul>
  );
}

function ReceivedList({
  entries,
  query,
  selectedSeq,
  onSelect,
  labelFor,
}: {
  entries: EventsFeedEntryView[];
  query: string;
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
  labelFor: (entry: EventsFeedEntryView) => string | undefined;
}) {
  if (entries.length === 0) {
    return (
      <EmptyText>No events received yet. They appear as they arrive.</EmptyText>
    );
  }
  const visible = [...entries]
    .reverse()
    .filter((entry) => matches(query, entry.name, entry.eventId, entry.kind));
  if (visible.length === 0) {
    return <EmptyText>No received events match your search.</EmptyText>;
  }
  return (
    <ul className="space-y-2" data-testid="received-list">
      {visible.map((entry) => (
        <li key={entry.seq}>
          <EventsListItem
            title={entry.name ?? entry.kind}
            description={[
              entry.kind === "event" ? undefined : entry.kind,
              formatTime(entry.receivedAt),
              labelFor(entry),
            ]
              .filter(Boolean)
              .join(" · ")}
            selected={entry.seq === selectedSeq}
            onClick={() =>
              onSelect(entry.seq === selectedSeq ? null : entry.seq)
            }
          />
        </li>
      ))}
    </ul>
  );
}
