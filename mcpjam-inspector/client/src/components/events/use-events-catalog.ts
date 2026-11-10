import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { loadEventsCatalog } from "@/lib/apis/mcp-events-api";
import type { EventsListResponse } from "@/shared/events-api";
import { errorMessage } from "./event-utils";

export type CatalogState = "idle" | "loading" | "ready" | "error";

export interface EventsCatalog {
  catalog: EventsListResponse | null;
  catalogState: CatalogState;
  catalogError: string | null;
  /** Read the catalog again (Retry, Refresh). */
  retry: () => void;
  loadingMore: boolean;
  loadMoreEvents: () => Promise<void>;
  selectedEventName: string | null;
  setSelectedEventName: (eventName: string | null) => void;
}

/**
 * The server's events catalog, read once the server is connected and again on
 * `retry`. The selected event survives a re-read that still lists it.
 */
export function useEventsCatalog({
  hasServer,
  serverName,
  connected,
}: {
  hasServer: boolean;
  serverName?: string;
  connected: boolean;
}): EventsCatalog {
  const [catalog, setCatalog] = useState<EventsListResponse | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedEventName, setSelectedEventName] = useState<string | null>(
    null,
  );

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
        setCatalogError(
          errorMessage(error, "Could not check events support. Try again."),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [hasServer, serverName, connected, catalogAttempt]);

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
      toast.error(
        errorMessage(error, "Could not load more events. Try again."),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [serverName, catalog?.nextCursor]);

  const retry = useCallback(
    () => setCatalogAttempt((attempt) => attempt + 1),
    [],
  );

  return {
    catalog,
    catalogState,
    catalogError,
    retry,
    loadingMore,
    loadMoreEvents,
    selectedEventName,
    setSelectedEventName,
  };
}
