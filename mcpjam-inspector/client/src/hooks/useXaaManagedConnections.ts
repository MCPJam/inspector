import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";
import { HOSTED_MODE } from "@/lib/config";
import type {
  XaaManagedAssignment,
  XaaManagedConnection,
  XaaScopeMode,
} from "@/lib/xaa/types";

const SCOPE_MODES: ReadonlySet<XaaScopeMode> = new Set(["all", "selected"]);

function optionalScopeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // Keep an explicit empty array: for scopeMode "selected" it means deny-all,
  // which must never be normalized away into "absent".
  return value.filter((v): v is string => typeof v === "string");
}

export function normalizeAssignment(
  raw: unknown,
): XaaManagedAssignment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r._id !== "string" ||
    typeof r.connectionId !== "string" ||
    typeof r.testIdentityId !== "string"
  ) {
    return null;
  }
  if (!SCOPE_MODES.has(r.scopeMode as XaaScopeMode)) return null;

  return {
    _id: r._id,
    connectionId: r.connectionId,
    testIdentityId: r.testIdentityId,
    scopeMode: r.scopeMode as XaaScopeMode,
    selectedScopes: optionalScopeList(r.selectedScopes),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

// Wire shape: `listWithAssignments` returns connection rows joined with their
// assignment rows. This normalizer coerces the loose `as any` query result
// into the typed shape and drops anything malformed (pattern:
// normalizeResourceApp in useXaaResourceApps).
export function normalizeManagedConnection(
  raw: unknown,
): XaaManagedConnection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r._id !== "string" || typeof r.resourceAppId !== "string") {
    return null;
  }
  if (!SCOPE_MODES.has(r.scopeMode as XaaScopeMode)) return null;

  const assignments = Array.isArray(r.assignments)
    ? r.assignments
        .map(normalizeAssignment)
        .filter((a): a is XaaManagedAssignment => a !== null)
    : [];

  return {
    _id: r._id,
    resourceAppId: r.resourceAppId,
    enabled: r.enabled === true,
    scopeMode: r.scopeMode as XaaScopeMode,
    selectedScopes: optionalScopeList(r.selectedScopes),
    assignments,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

function normalizeConnectionList(raw: unknown): XaaManagedConnection[] {
  // Accept either a wrapped `{ connections: [...] }` or a bare array, so a
  // future shape tweak on the backend doesn't break the consumer.
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { connections?: unknown }).connections
      : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeManagedConnection)
    .filter((c): c is XaaManagedConnection => c !== null);
}

export interface XaaConnectionInput {
  resourceAppId: string;
  enabled: boolean;
  scopeMode: XaaScopeMode;
  /** Required iff scopeMode === "selected" (⊆ the app's scopes). */
  selectedScopes?: string[];
}

export interface UseXaaManagedConnectionsResult {
  connections: XaaManagedConnection[];
  /** Lookup by the owning resource app (one connection per app). */
  connectionByAppId: Map<string, XaaManagedConnection>;
  isLoading: boolean;
  /** Full internal fetch gate: authenticated + org-scoped + hosted mode. */
  isAuthenticated: boolean;
  error: string | null;
  upsertConnection: (input: XaaConnectionInput) => Promise<{ id: string }>;
  removeConnection: (connectionId: string) => Promise<void>;
}

/**
 * Managed-IdP connections: whether the fixed MCPJam Agent is enabled for a
 * registered resource app, and which scopes the connection lets through.
 * Assignments ride along on the list (`listWithAssignments`); their mutations
 * live in `useXaaAssignments`.
 */
export function useXaaManagedConnections(
  organizationId: string | null,
): UseXaaManagedConnectionsResult {
  const { isAuthenticated: hasConvexIdentity, isLoading: isAuthLoading } =
    useConvexAuth();

  const enabled = hasConvexIdentity && !!organizationId && HOSTED_MODE;

  const raw = useQuery(
    "xaaManagedConnections:listWithAssignments" as any,
    enabled ? ({ organizationId } as any) : "skip",
  ) as unknown | undefined;

  const connections = useMemo(() => normalizeConnectionList(raw), [raw]);
  const connectionByAppId = useMemo(() => {
    const map = new Map<string, XaaManagedConnection>();
    for (const connection of connections) {
      map.set(connection.resourceAppId, connection);
    }
    return map;
  }, [connections]);

  // Cast the new function names `as any` until backend `_generated` types
  // regenerate after the managed-IdP data layer deploys.
  const upsertMutation = useMutation(
    "xaaManagedConnections:upsertConnection" as any,
  );
  const removeMutation = useMutation(
    "xaaManagedConnections:removeConnection" as any,
  );

  const [error, setError] = useState<string | null>(null);

  const upsertConnection = useCallback(
    async (input: XaaConnectionInput): Promise<{ id: string }> => {
      if (!organizationId) throw new Error("Organization is required");
      setError(null);
      try {
        const result = await upsertMutation({
          organizationId,
          ...input,
        } as any);
        return result as { id: string };
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Couldn't save this connection",
        );
        throw err;
      }
    },
    [organizationId, upsertMutation],
  );

  const removeConnection = useCallback(
    async (connectionId: string): Promise<void> => {
      if (!organizationId) throw new Error("Organization is required");
      setError(null);
      try {
        await removeMutation({ connectionId } as any);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't remove this connection",
        );
        throw err;
      }
    },
    [organizationId, removeMutation],
  );

  const isLoading = HOSTED_MODE
    ? isAuthLoading || (enabled && raw === undefined)
    : false;

  return {
    connections,
    connectionByAppId,
    isLoading,
    isAuthenticated: enabled,
    error,
    upsertConnection,
    removeConnection,
  };
}
