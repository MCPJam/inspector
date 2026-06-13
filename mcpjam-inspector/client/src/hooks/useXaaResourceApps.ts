import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";
import { HOSTED_MODE } from "@/lib/config";
import type {
  XaaAuthServerMode,
  XaaResourceApp,
  XaaResourceAppInput,
  XaaResourceType,
} from "@/lib/xaa/types";

const RESOURCE_TYPES: ReadonlySet<XaaResourceType> = new Set(["rest", "mcp"]);
const AUTH_SERVER_MODES: ReadonlySet<XaaAuthServerMode> = new Set([
  "mcpjam",
  "own",
]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : undefined;
}

// The backend already sanitizes (no vaultObjectId/secret ever leaves the
// wire); this normalizer just coerces the loose `as any` query result into the
// typed shape and drops anything malformed.
function normalizeResourceApp(raw: unknown): XaaResourceApp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  if (!RESOURCE_TYPES.has(r.resourceType as XaaResourceType)) return null;
  if (!AUTH_SERVER_MODES.has(r.authServerMode as XaaAuthServerMode))
    return null;

  return {
    id: r.id,
    name: r.name,
    resourceType: r.resourceType as XaaResourceType,
    resourceUrl: typeof r.resourceUrl === "string" ? r.resourceUrl : "",
    authServerMode: r.authServerMode as XaaAuthServerMode,
    tokenEndpoint: optionalString(r.tokenEndpoint),
    issuer: optionalString(r.issuer),
    targetClientId: optionalString(r.targetClientId),
    scopes: optionalStringArray(r.scopes),
    healthCheckUrl: optionalString(r.healthCheckUrl),
    hasSecret: r.hasSecret === true,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

function normalizeList(raw: unknown): XaaResourceApp[] {
  // Accept either a wrapped `{ resourceApps: [...] }` or a bare array, so a
  // future shape tweak on the backend doesn't break the consumer.
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { resourceApps?: unknown }).resourceApps
      : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeResourceApp)
    .filter((app): app is XaaResourceApp => app !== null);
}

export interface UseXaaResourceAppsResult {
  resourceApps: XaaResourceApp[];
  isLoading: boolean;
  /**
   * The full gate the hook uses internally to fetch — registration is a hosted
   * feature, so consumers get `true` only when authenticated, scoped to an
   * org, AND in hosted mode. Never a half-gate.
   */
  isAuthenticated: boolean;
  error: string | null;
  upsert: (input: XaaResourceAppInput) => Promise<{ id: string }>;
  remove: (id: string) => Promise<void>;
}

export function useXaaResourceApps(
  organizationId: string | null,
): UseXaaResourceAppsResult {
  const { isAuthenticated: hasConvexIdentity, isLoading: isAuthLoading } =
    useConvexAuth();

  const enabled = hasConvexIdentity && !!organizationId && HOSTED_MODE;

  const raw = useQuery(
    "xaaResourceApps:list" as any,
    enabled ? ({ organizationId } as any) : "skip",
  ) as unknown | undefined;

  const resourceApps = useMemo(() => normalizeList(raw), [raw]);

  // Cast the new function names `as any` until backend `_generated` types
  // regenerate after the CRUD layer deploys.
  const upsertAction = useAction("xaaResourceApps:upsert" as any);
  const removeAction = useAction("xaaResourceApps:remove" as any);

  const [error, setError] = useState<string | null>(null);

  const upsert = useCallback(
    async (input: XaaResourceAppInput): Promise<{ id: string }> => {
      if (!organizationId) throw new Error("Organization is required");
      setError(null);
      try {
        const result = await upsertAction({
          organizationId,
          ...input,
        } as any);
        return result as { id: string };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to save resource app";
        setError(message);
        throw err;
      }
    },
    [organizationId, upsertAction],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!organizationId) throw new Error("Organization is required");
      setError(null);
      try {
        await removeAction({ id, organizationId } as any);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to delete resource app";
        setError(message);
        throw err;
      }
    },
    [organizationId, removeAction],
  );

  // Registration is hosted-only, so non-hosted renders never report loading.
  // Inside hosted mode, treat the auth-bootstrap window as loading so the list
  // shows a skeleton instead of flashing an empty state.
  const isLoading = HOSTED_MODE
    ? isAuthLoading || (enabled && raw === undefined)
    : false;

  return {
    resourceApps,
    isLoading,
    isAuthenticated: enabled,
    error,
    upsert,
    remove,
  };
}
