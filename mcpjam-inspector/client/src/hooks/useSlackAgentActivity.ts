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
    if (!organizationId || !isAuthenticated) {
      setEvents([]);
      setCursor(null);
      setHasMore(false);
      setError(null);
      return;
    }
    const requestId = ++requestSequenceRef.current;
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
    if (!organizationId || !isAuthenticated || !hasMore || cursor === null) {
      return;
    }
    const requestId = requestSequenceRef.current;
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
      setError(toError(nextError));
    } finally {
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
