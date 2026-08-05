import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";

/**
 * The org's Slack-agent activity feed.
 *
 * Follows `useOrganizationAudit`'s imperative `convex.query` shape rather than
 * `useQuery`: this is a PAGED read with a "load more" button, and a
 * subscription that re-ran on every new audit row would reset the page the
 * admin is reading.
 *
 * The backing query is `slackAgentActivity:listByOrganization` — NOT
 * `auditEvents:listByOrganization`. The audit-log query is the compliance
 * product (admin-only, entitlement-gated); this is operational visibility for
 * a feature the org actively uses, so it is member-readable and ungated. Same
 * rows underneath, different question.
 */

const DEFAULT_LIMIT = 50;

export interface SlackAgentActivityEvent {
  _id: string;
  action: string;
  actorType: "user" | "system";
  actorId: string | null;
  actorEmail: string | null;
  organizationId: string | null;
  projectId: string | null;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown> | null;
  timestamp: number;
}

interface ActivityPage {
  events: SlackAgentActivityEvent[];
  nextBefore: number | null;
  hasMore: boolean;
}

export interface UseSlackAgentActivityResult {
  events: SlackAgentActivityEvent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function useSlackAgentActivity({
  organizationId,
  isAuthenticated,
  limit = DEFAULT_LIMIT,
}: {
  organizationId: string | null;
  isAuthenticated: boolean;
  limit?: number;
}): UseSlackAgentActivityResult {
  const convex = useConvex();
  const convexRef = useRef(convex);
  const [events, setEvents] = useState<SlackAgentActivityEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /**
   * Guards against a late response from a previous org overwriting the current
   * one's list — switching orgs mid-flight is the case that produces it.
   */
  const requestSequenceRef = useRef(0);

  /**
   * Synchronous latch for `loadMore`.
   *
   * `isLoadingMore` is state, so it is not visible to a second call in the
   * same tick: both would read the same cursor, both would pass the guard, and
   * both would append the identical page — duplicating rows while the cursor
   * advanced only once. The disabled button narrows that window; it does not
   * close it, and this hook is callable by anyone.
   */
  const loadMoreInFlightRef = useRef(false);

  useEffect(() => {
    convexRef.current = convex;
  }, [convex]);

  const fetchPage = useCallback(
    async (before: number | null): Promise<ActivityPage> => {
      return (await convexRef.current.query(
        "slackAgentActivity:listByOrganization" as any,
        {
          organizationId,
          limit,
          ...(before === null ? {} : { before }),
        } as any
      )) as ActivityPage;
    },
    [limit, organizationId]
  );

  const refresh = useCallback(async () => {
    // Bumped BEFORE the early return: leaving the org/auth scope has to
    // invalidate an in-flight page too, or its response would repopulate the
    // list we just cleared and leave the spinner on forever.
    const requestId = ++requestSequenceRef.current;
    if (!organizationId || !isAuthenticated) {
      setEvents([]);
      setCursor(null);
      setHasMore(false);
      setError(null);
      setIsLoading(false);
      setIsLoadingMore(false);
      loadMoreInFlightRef.current = false;
      return;
    }
    // Pagination belongs to the org being left. Without this reset, switching
    // orgs keeps the previous org's rows on screen during the new fetch, and a
    // page that was in flight can leave "Load more" permanently disabled.
    setEvents([]);
    setCursor(null);
    setHasMore(false);
    setIsLoadingMore(false);
    loadMoreInFlightRef.current = false;
    setIsLoading(true);
    setError(null);
    try {
      const page = await fetchPage(null);
      if (requestSequenceRef.current !== requestId) return;
      setEvents(page.events ?? []);
      setCursor(page.nextBefore ?? null);
      setHasMore(Boolean(page.hasMore));
    } catch (nextError) {
      if (requestSequenceRef.current !== requestId) return;
      setError(toError(nextError));
      setEvents([]);
      setHasMore(false);
    } finally {
      if (requestSequenceRef.current === requestId) setIsLoading(false);
    }
  }, [fetchPage, isAuthenticated, organizationId]);

  const loadMore = useCallback(async () => {
    if (
      !organizationId ||
      !isAuthenticated ||
      !hasMore ||
      cursor === null ||
      loadMoreInFlightRef.current
    ) {
      return;
    }
    const requestId = requestSequenceRef.current;
    loadMoreInFlightRef.current = true;
    setIsLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      if (requestSequenceRef.current !== requestId) return;
      // Appended, not replaced: the admin is reading a list and a page load
      // must not move what is already on screen.
      setEvents((previous) => [...previous, ...(page.events ?? [])]);
      setCursor(page.nextBefore ?? null);
      setHasMore(Boolean(page.hasMore));
    } catch (nextError) {
      if (requestSequenceRef.current !== requestId) return;
      // The rows already on screen are kept: a failed page must not discard
      // what the admin was reading. `SlackActivityTab` renders this error
      // beside the button rather than in place of the table.
      setError(toError(nextError));
    } finally {
      loadMoreInFlightRef.current = false;
      if (requestSequenceRef.current === requestId) setIsLoadingMore(false);
    }
  }, [cursor, fetchPage, hasMore, isAuthenticated, organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      events,
      isLoading,
      isLoadingMore,
      hasMore,
      error,
      refresh,
      loadMore,
    }),
    [error, events, hasMore, isLoading, isLoadingMore, loadMore, refresh]
  );
}
