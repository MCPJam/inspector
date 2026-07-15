import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";
import { HOSTED_MODE } from "@/lib/config";
import type {
  RemoteOrgXaaPerson,
  XaaImportFromProjectResult,
  XaaOrgPersonStatus,
} from "@/lib/xaa/types";

const PERSON_STATUSES: ReadonlySet<XaaOrgPersonStatus> = new Set([
  "active",
  "suspended",
]);

// The backend serializer whitelists {_id,name,subject,email,color,status,
// createdAt,updatedAt} and never returns archived rows; this normalizer
// coerces the loose `as any` query result into the typed shape and drops
// anything malformed (pattern: normalizeResourceApp in useXaaResourceApps).
function normalizeOrgPerson(raw: unknown): RemoteOrgXaaPerson | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r._id !== "string" ||
    typeof r.name !== "string" ||
    typeof r.subject !== "string" ||
    typeof r.email !== "string"
  ) {
    return null;
  }
  if (!PERSON_STATUSES.has(r.status as XaaOrgPersonStatus)) return null;

  return {
    _id: r._id,
    name: r.name,
    subject: r.subject,
    email: r.email,
    color: typeof r.color === "string" && r.color ? r.color : undefined,
    status: r.status as XaaOrgPersonStatus,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

function normalizePeopleList(raw: unknown): RemoteOrgXaaPerson[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeOrgPerson)
    .filter((person): person is RemoteOrgXaaPerson => person !== null);
}

export interface OrgXaaPersonInput {
  name: string;
  subject: string;
  email: string;
  color?: string;
}

export interface UseOrgXaaPeopleResult {
  people: RemoteOrgXaaPerson[];
  isLoading: boolean;
  /**
   * The full gate the hook uses internally to fetch — the org roster is a
   * hosted feature, so consumers get `true` only when authenticated, scoped
   * to an org, AND in hosted mode. Never a half-gate (mirrors
   * useXaaResourceApps).
   */
  isAuthenticated: boolean;
  error: string | null;
  /** Resolves with the backend's serialized row (normalized); null if the
   * response shape is unrecognized. The wire field is `_id`, not `id`. */
  create: (input: OrgXaaPersonInput) => Promise<RemoteOrgXaaPerson | null>;
  /** Subject is immutable by validator surface — it is not an update arg. */
  update: (args: {
    testIdentityId: string;
    name: string;
    email: string;
    color?: string;
  }) => Promise<void>;
  setStatus: (args: {
    testIdentityId: string;
    status: XaaOrgPersonStatus;
  }) => Promise<void>;
  /** Terminal; archive replaces delete (assignments/audit reference rows). */
  archive: (args: { testIdentityId: string }) => Promise<void>;
  importFromProject: (args: {
    projectId: string;
  }) => Promise<XaaImportFromProjectResult>;
}

/**
 * Org-scoped synthetic People for the managed test IdP (setup center roster).
 * Distinct from `useXaaPeople` (project fixtures): these rows live in the
 * backend's `xaaTestIdentities` table, are shared across the org's projects,
 * and carry a status the policy evaluator enforces at mint time.
 */
export function useOrgXaaPeople(
  organizationId: string | null,
): UseOrgXaaPeopleResult {
  const { isAuthenticated: hasConvexIdentity, isLoading: isAuthLoading } =
    useConvexAuth();

  const enabled = hasConvexIdentity && !!organizationId && HOSTED_MODE;

  const raw = useQuery(
    "xaaTestIdentities:list" as any,
    enabled ? ({ organizationId } as any) : "skip",
  ) as unknown | undefined;

  const people = useMemo(() => normalizePeopleList(raw), [raw]);

  // Cast the new function names `as any` until backend `_generated` types
  // regenerate after the managed-IdP data layer deploys.
  const createMutation = useMutation("xaaTestIdentities:create" as any);
  const updateMutation = useMutation("xaaTestIdentities:update" as any);
  const setStatusMutation = useMutation("xaaTestIdentities:setStatus" as any);
  const archiveMutation = useMutation("xaaTestIdentities:archive" as any);
  const importMutation = useMutation(
    "xaaTestIdentities:importFromProject" as any,
  );

  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(fallbackMessage: string, fn: () => Promise<T>): Promise<T> => {
      if (!organizationId) throw new Error("Organization is required");
      setError(null);
      try {
        return await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : fallbackMessage);
        throw err;
      }
    },
    [organizationId],
  );

  const create = useCallback(
    (input: OrgXaaPersonInput) =>
      run("Couldn't add this person", async () => {
        const result = await createMutation({
          organizationId,
          ...input,
        } as any);
        return normalizeOrgPerson(result);
      }),
    [createMutation, organizationId, run],
  );

  const update = useCallback(
    (args: {
      testIdentityId: string;
      name: string;
      email: string;
      color?: string;
    }) =>
      run("Couldn't save this person", async () => {
        await updateMutation(args as any);
      }),
    [run, updateMutation],
  );

  const setStatus = useCallback(
    (args: { testIdentityId: string; status: XaaOrgPersonStatus }) =>
      run("Couldn't change this person's status", async () => {
        await setStatusMutation(args as any);
      }),
    [run, setStatusMutation],
  );

  const archive = useCallback(
    (args: { testIdentityId: string }) =>
      run("Couldn't archive this person", async () => {
        await archiveMutation(args as any);
      }),
    [archiveMutation, run],
  );

  const importFromProject = useCallback(
    (args: { projectId: string }) =>
      run("Couldn't import people from this project", async () => {
        const result = await importMutation({
          organizationId,
          projectId: args.projectId,
        } as any);
        const r = (result ?? {}) as Record<string, unknown>;
        return {
          imported: typeof r.imported === "number" ? r.imported : 0,
          skippedExisting:
            typeof r.skippedExisting === "number" ? r.skippedExisting : 0,
          skippedOverCap:
            typeof r.skippedOverCap === "number" ? r.skippedOverCap : 0,
        } satisfies XaaImportFromProjectResult;
      }),
    [importMutation, organizationId, run],
  );

  // Hosted-only feature: non-hosted renders never report loading. Inside
  // hosted mode, treat the auth-bootstrap window as loading so the roster
  // shows a skeleton instead of flashing an empty state.
  const isLoading = HOSTED_MODE
    ? isAuthLoading || (enabled && raw === undefined)
    : false;

  return {
    people,
    isLoading,
    isAuthenticated: enabled,
    error,
    create,
    update,
    setStatus,
    archive,
    importFromProject,
  };
}
