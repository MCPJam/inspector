import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";

const DEFAULT_LIMIT = 100;

export interface AuditEvent {
  _id: string;
  actorType: "user" | "system";
  actorId?: string;
  actorEmail?: string;
  action: string;
  organizationId?: string;
  workspaceId?: string;
  targetType: string;
  targetId: string;
  metadata?: unknown;
  timestamp: number;
}

export interface UseOrganizationAuditOptions {
  organizationId: string | null;
  isAuthenticated: boolean;
  initialLimit?: number;
}

export interface UseOrganizationAuditResult {
  events: AuditEvent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function dedupeAndSort(events: AuditEvent[]): AuditEvent[] {
  const byId = new Map<string, AuditEvent>();
  for (const event of events) {
    if (!byId.has(event._id)) {
      byId.set(event._id, event);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export function useOrganizationAudit({
  organizationId,
  isAuthenticated,
  initialLimit = DEFAULT_LIMIT,
}: UseOrganizationAuditOptions): UseOrganizationAuditResult {
  const convex = useConvex();
  const convexRef = useRef(convex);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const requestSequenceRef = useRef(0);
  const limit = Math.max(1, initialLimit);

  useEffect(() => {
    convexRef.current = convex;
  }, [convex]);

  const fetchPage = useCallback(
    async (before?: number): Promise<AuditEvent[]> => {
      if (!organizationId || !isAuthenticated) return [];

      const args: {
        organizationId: string;
        limit: number;
        before?: number;
      } = {
        organizationId,
        limit,
      };

      if (before !== undefined) {
        args.before = before;
      }

      return (await convexRef.current.query(
        "auditEvents:listByOrganization" as any,
        args as any,
      )) as AuditEvent[];
    },
    [isAuthenticated, limit, organizationId],
  );

  const refresh = useCallback(async () => {
    if (!organizationId || !isAuthenticated) {
      setEvents([]);
      setHasMore(false);
      setError(null);
      return;
    }

    const requestId = ++requestSequenceRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const page = await fetchPage();
      if (requestSequenceRef.current !== requestId) return;

      setEvents(dedupeAndSort(page));
      setHasMore(page.length >= limit);
    } catch (nextError) {
      if (requestSequenceRef.current !== requestId) return;
      setError(toError(nextError));
      setEvents([]);
      setHasMore(false);
    } finally {
      if (requestSequenceRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [fetchPage, isAuthenticated, limit, organizationId]);

  const loadMore = useCallback(async () => {
    if (
      !organizationId ||
      !isAuthenticated ||
      isLoading ||
      isLoadingMore ||
      !hasMore
    ) {
      return;
    }

    const oldestTimestamp = events[events.length - 1]?.timestamp;
    if (!oldestTimestamp) {
      setHasMore(false);
      return;
    }

    const requestId = ++requestSequenceRef.current;
    setIsLoadingMore(true);
    setError(null);

    try {
      const page = await fetchPage(oldestTimestamp);
      if (requestSequenceRef.current !== requestId) return;

      setEvents((current) => dedupeAndSort([...current, ...page]));
      setHasMore(page.length >= limit);
    } catch (nextError) {
      if (requestSequenceRef.current !== requestId) return;
      setError(toError(nextError));
    } finally {
      if (requestSequenceRef.current === requestId) {
        setIsLoadingMore(false);
      }
    }
  }, [
    events,
    fetchPage,
    hasMore,
    isAuthenticated,
    isLoading,
    isLoadingMore,
    limit,
    organizationId,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      events,
      isLoading,
      isLoadingMore,
      error,
      hasMore,
      loadMore,
      refresh,
    }),
    [error, events, hasMore, isLoading, isLoadingMore, loadMore, refresh],
  );
}
