import { useState } from "react";
import { PanelLeftClose, RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { InspectorPaneHeader } from "@/components/ui/inspector-pane-header";
import { SearchInput } from "@/components/ui/search-input";
import type {
  EventsFeedEntryView,
  EventsListResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { EventsListItem } from "./EventsListItem";
import { formatTime, observedStateLabel, safeJson } from "./event-utils";

export type EventsBrowseTab = "events" | "subscriptions" | "occurrences";

const SEARCH_LABELS: Record<EventsBrowseTab, string> = {
  events: "Search event types...",
  subscriptions: "Search subscriptions...",
  occurrences: "Search occurrences...",
};

export function EventsSidebar({
  catalog,
  loadingMore,
  onLoadMore,
  onRefresh,
  onHide,
  activeTab,
  onTabChange,
  selectedEventName,
  onSelectEvent,
  subscriptions,
  selectedSubscriptionId,
  onSelectSubscription,
  entries,
  selectedOccurrenceSeq,
  onSelectOccurrence,
}: {
  catalog: EventsListResponse;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onRefresh: () => void;
  onHide: () => void;
  activeTab: EventsBrowseTab;
  onTabChange: (tab: EventsBrowseTab) => void;
  selectedEventName: string | null;
  onSelectEvent: (eventName: string) => void;
  subscriptions: EventsSubscriptionView[];
  selectedSubscriptionId: string | null;
  onSelectSubscription: (id: string) => void;
  entries: EventsFeedEntryView[];
  selectedOccurrenceSeq: number | null;
  onSelectOccurrence: (seq: number) => void;
}) {
  const [queries, setQueries] = useState<Record<EventsBrowseTab, string>>({
    events: "",
    subscriptions: "",
    occurrences: "",
  });
  const query = queries[activeTab];
  const needle = query.trim().toLowerCase();
  const visibleEvents = catalog.events.filter((event) =>
    [event.name, event.description].some((value) =>
      value?.toLowerCase().includes(needle),
    ),
  );
  const visibleSubscriptions = subscriptions.filter((subscription) =>
    `${subscription.eventName} ${subscription.mode} ${observedStateLabel(subscription.observedState)} ${safeJson(subscription.arguments)}`
      .toLowerCase()
      .includes(needle),
  );
  const visibleEntries = [...entries]
    .reverse()
    .filter((entry) => safeJson(entry).toLowerCase().includes(needle));
  const visibleCount =
    activeTab === "events"
      ? visibleEvents.length
      : activeTab === "subscriptions"
        ? visibleSubscriptions.length
        : visibleEntries.length;
  const emptyText = needle
    ? `No ${activeTab === "events" ? "event types" : activeTab} match your search.`
    : activeTab === "events"
      ? "This server lists no event types."
      : activeTab === "subscriptions"
        ? "No subscriptions yet. Choose an event to subscribe."
        : "No occurrences yet. They appear here as events arrive.";

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <InspectorPaneHeader<EventsBrowseTab>
        compact
        ariaLabel="Browse events"
        tabs={[
          {
            id: "events",
            label: "Events",
            count: catalog.nextCursor
              ? `${catalog.events.length}+`
              : catalog.events.length,
            countTitle: "Event types loaded from this server",
          },
          {
            id: "subscriptions",
            label: "Subscriptions",
            count: subscriptions.filter(
              (subscription) => subscription.desiredState !== "removed",
            ).length,
          },
          {
            id: "occurrences",
            label: "Occurrences",
            count: entries.filter((entry) => entry.kind === "event").length,
          },
        ]}
        activeTab={activeTab}
        onTabChange={onTabChange}
      />
      <div className="flex items-center gap-1 px-3 py-2">
        <div className="min-w-0 flex-1">
          <SearchInput
            value={query}
            onValueChange={(value) =>
              setQueries((previous) => ({ ...previous, [activeTab]: value }))
            }
            placeholder={SEARCH_LABELS[activeTab]}
          />
        </div>
        {activeTab === "events" ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh event types"
            onClick={onRefresh}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-7 md:inline-flex"
          aria-label="Hide sidebar"
          onClick={onHide}
        >
          <PanelLeftClose className="size-3.5" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {visibleCount === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {emptyText}
            </p>
          ) : activeTab === "events" ? (
            <ul className="space-y-2" data-testid="event-types">
              {visibleEvents.map((event) => {
                const count = subscriptions.filter(
                  (subscription) =>
                    subscription.eventName === event.name &&
                    subscription.desiredState !== "removed",
                ).length;
                return (
                  <li key={event.name}>
                    <EventsListItem
                      title={event.name}
                      description={event.description}
                      meta={
                        <span className="text-[11px] text-muted-foreground">
                          {count
                            ? `${count} subscription${count === 1 ? "" : "s"}`
                            : "Not subscribed"}
                        </span>
                      }
                      selected={event.name === selectedEventName}
                      onClick={() => onSelectEvent(event.name)}
                    />
                  </li>
                );
              })}
            </ul>
          ) : activeTab === "subscriptions" ? (
            <ul className="space-y-2" data-testid="subscription-list">
              {visibleSubscriptions.map((subscription) => (
                <li key={subscription.id}>
                  <EventsListItem
                    title={subscription.eventName}
                    description={safeJson(subscription.arguments)}
                    meta={
                      <span className="text-[11px] text-muted-foreground">
                        {subscription.mode} ·{" "}
                        {observedStateLabel(subscription.observedState)}
                      </span>
                    }
                    selected={subscription.id === selectedSubscriptionId}
                    onClick={() => onSelectSubscription(subscription.id)}
                    testId={`select-subscription-${subscription.id}`}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="space-y-2" data-testid="occurrence-list">
              {visibleEntries.map((entry) => (
                <li key={entry.seq}>
                  <EventsListItem
                    title={entry.name ?? entry.kind}
                    meta={
                      <span className="text-[11px] text-muted-foreground">
                        {formatTime(entry.receivedAt)}
                      </span>
                    }
                    selected={entry.seq === selectedOccurrenceSeq}
                    onClick={() => onSelectOccurrence(entry.seq)}
                    testId={`select-occurrence-${entry.seq}`}
                  />
                </li>
              ))}
            </ul>
          )}
          {activeTab === "events" && catalog.nextCursor ? (
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
        </div>
      </ScrollArea>
    </div>
  );
}
