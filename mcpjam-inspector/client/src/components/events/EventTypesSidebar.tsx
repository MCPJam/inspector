import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { cn } from "@mcpjam/design-system/cn";
import { PanelLeftClose, RefreshCw } from "lucide-react";
import type {
  EventsListResponse,
  EventsProfileIdView,
} from "@/shared/events-api";
import { CapabilityPanel } from "./CapabilityPanel";
import { DeliveryChips } from "./EventsTabSections";

/** The Events tab sidebar: the server's capability and its event types. */
export function EventTypesSidebar({
  catalog,
  profileId,
  selectedEventName,
  loadingMore,
  onSelectEvent,
  onLoadMore,
  onRefresh,
  onHide,
}: {
  catalog: EventsListResponse;
  profileId: EventsProfileIdView;
  selectedEventName: string | null;
  loadingMore: boolean;
  onSelectEvent: (eventName: string) => void;
  onLoadMore: () => Promise<void>;
  onRefresh: () => void;
  onHide: () => void;
}) {
  return (
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
            onClick={onRefresh}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title="Hide sidebar"
            onClick={onHide}
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
                    onClick={() => onSelectEvent(event.name)}
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
              onClick={() => void onLoadMore()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
