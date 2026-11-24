import { useState } from "react";
import { PanelLeftClose, RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { InspectorPaneHeader } from "@/components/ui/inspector-pane-header";
import { SearchInput } from "@/components/ui/search-input";
import type {
  EventsListResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { EventsListItem } from "./EventsListItem";

export function EventsSidebar({
  catalog,
  loadingMore,
  onLoadMore,
  onRefresh,
  onHide,
  selectedEventName,
  onSelectEvent,
  subscriptions,
}: {
  catalog: EventsListResponse;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onRefresh: () => void;
  onHide: () => void;
  selectedEventName: string | null;
  onSelectEvent: (eventName: string | null) => void;
  subscriptions: EventsSubscriptionView[];
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = catalog.events.filter((event) =>
    [event.name, event.description].some((value) =>
      value?.toLowerCase().includes(needle),
    ),
  );

  return (
    <div className="flex h-full flex-col border-r border-border bg-background">
      <InspectorPaneHeader
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
        ]}
        activeTab="events"
        onTabChange={() => onSelectEvent(null)}
        secondaryActions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Refresh event types"
              onClick={onRefresh}
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-7 md:inline-flex"
              aria-label="Hide sidebar"
              onClick={onHide}
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
          </>
        }
      />
      <div className="px-3 py-2">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search event types..."
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          <EventsListItem
            title="All events"
            selected={selectedEventName === null}
            onClick={() => onSelectEvent(null)}
          />
          {catalog.events.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              This server lists no event types.
            </p>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No event types match your search.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="event-types">
              {visible.map((event) => {
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
        </div>
      </ScrollArea>
    </div>
  );
}
