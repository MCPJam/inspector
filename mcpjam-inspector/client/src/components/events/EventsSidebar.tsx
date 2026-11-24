import { useEffect, useMemo, useRef, useState } from "react";
import { BellPlus, Loader2, PanelLeftClose, RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import type { SubscribableModes } from "@mcpjam/sdk/browser";
import { InspectorPaneHeader } from "@/components/ui/inspector-pane-header";
import { SearchInput } from "@/components/ui/search-input";
import type {
  EventDescriptorView,
  EventsListResponse,
} from "@/shared/events-api";
import { EventsListItem } from "./EventsListItem";
import { EventTypeDetail, type BlockedAction } from "./EventTypeDetail";
import { DeliveryChips } from "./EventsTabSections";
import type { SubscribeForm } from "./use-subscribe-form";

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

/**
 * The Events left pane: the Tools header over the server's event types.
 * Selecting an event type replaces the list with its detail and subscribe
 * form, as selecting a tool does.
 */
export function EventsSidebar({
  catalog,
  loadingMore,
  onLoadMore,
  onRefresh,
  onHide,
  selectedEvent,
  onSelectEvent,
  availabilityFor,
  hostName,
  hosted,
  form,
  subscribing,
  blockedReason,
  blockedAction,
  replayUnsupportedFor,
}: {
  catalog: EventsListResponse;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onRefresh: () => void;
  onHide: () => void;
  selectedEvent: EventDescriptorView | undefined;
  onSelectEvent: (eventName: string | null) => void;
  availabilityFor: (
    event: EventDescriptorView,
  ) => SubscribableModes | undefined;
  hostName: string;
  hosted: boolean;
  form: SubscribeForm;
  subscribing: boolean;
  blockedReason: string | null;
  blockedAction?: BlockedAction;
  replayUnsupportedFor: (eventName: string) => boolean;
}) {
  const [query, setQuery] = useState("");
  // Back returns focus to the row that was opened.
  const [returnFocusTo, setReturnFocusTo] = useState<string | null>(null);

  const showDetail = selectedEvent !== undefined;

  return (
    <div className="flex h-full flex-col border-r border-border bg-background">
      <InspectorPaneHeader
        ariaLabel="Events views"
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
        ]}
        activeTab="events"
        onTabChange={() => undefined}
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
        primaryAction={
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={!showDetail || !form.canSubmit}
            onClick={form.submit}
            title={
              !selectedEvent
                ? "Pick an event type to subscribe"
                : (blockedReason ?? undefined)
            }
          >
            {subscribing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <BellPlus className="h-3 w-3" />
            )}
            <span className="ml-1">
              {subscribing ? "Subscribing" : "Subscribe"}
            </span>
          </Button>
        }
      />

      {showDetail && selectedEvent ? (
        <EventTypeDetail
          event={selectedEvent}
          events={catalog.events}
          onBack={() => {
            setReturnFocusTo(selectedEvent.name);
            onSelectEvent(null);
          }}
          onSwitch={onSelectEvent}
          form={form}
          availability={availabilityFor(selectedEvent)}
          hostName={hostName}
          hosted={hosted}
          blockedReason={blockedReason}
          blockedAction={blockedAction}
          replayUnsupported={replayUnsupportedFor(selectedEvent.name)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-shrink-0 px-3 py-2">
            <SearchInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search event types..."
            />
          </div>
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="space-y-2 p-3 pb-16">
                <EventTypeList
                  catalog={catalog}
                  query={query}
                  loadingMore={loadingMore}
                  onLoadMore={onLoadMore}
                  onSelect={onSelectEvent}
                  availabilityFor={availabilityFor}
                  hostName={hostName}
                  returnFocusTo={returnFocusTo}
                  onFocusReturned={() => setReturnFocusTo(null)}
                />
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
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
  returnFocusTo,
  onFocusReturned,
}: {
  catalog: EventsListResponse;
  query: string;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onSelect: (eventName: string) => void;
  availabilityFor: (
    event: EventDescriptorView,
  ) => SubscribableModes | undefined;
  hostName: string;
  returnFocusTo: string | null;
  onFocusReturned: () => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const visible = useMemo(
    () =>
      catalog.events.filter((event) =>
        matches(query, event.name, event.description),
      ),
    [catalog.events, query],
  );

  useEffect(() => {
    if (!returnFocusTo) return;
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-item-key]") ?? [],
    ).find((element) => element.dataset.itemKey === returnFocusTo);
    row?.focus();
    onFocusReturned();
  }, [returnFocusTo, onFocusReturned]);

  if (catalog.events.length === 0) {
    return <EmptyText>This server lists no event types.</EmptyText>;
  }
  return (
    <>
      {visible.length === 0 ? (
        <EmptyText>No event types match your search.</EmptyText>
      ) : (
        <ul ref={listRef} className="space-y-2" data-testid="event-types">
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
                selected={false}
                itemKey={event.name}
                onClick={() => onSelect(event.name)}
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
