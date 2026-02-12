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
  error: Error | null;
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
  const [error, setError] = useState<Error | null>(null);

  const requestSequenceRef = useRef(0);
  const limit = Math.max(1, initialLimit);

  useEffect(() => {
    convexRef.current = convex;
  }, [convex]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    setEvents([]);
    setError(null);
    setIsLoading(false);
  }, [organizationId, isAuthenticated]);

  const fetchPage = useCallback(async (): Promise<AuditEvent[]> => {
    if (!organizationId || !isAuthenticated) return [];

    return (await convexRef.current.query(
      "auditEvents:listByOrganization" as any,
      {
        organizationId,
        limit,
      } as any,
    )) as AuditEvent[];
  }, [isAuthenticated, limit, organizationId]);

  const refresh = useCallback(async () => {
    if (!organizationId || !isAuthenticated) {
      setEvents([]);
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
    } catch (nextError) {
      if (requestSequenceRef.current !== requestId) return;
      setError(toError(nextError));
      setEvents([]);
    } finally {
      if (requestSequenceRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [fetchPage, isAuthenticated, organizationId]);

  return useMemo(
    () => ({
      events,
      isLoading,
      error,
      refresh,
    }),
    [error, events, isLoading, refresh],
  );
}
