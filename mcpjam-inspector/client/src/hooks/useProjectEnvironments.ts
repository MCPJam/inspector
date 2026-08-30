import { useMemo } from "react";
import { useMutation, useQuery, useConvexAuth } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import {
  isNamedEnvironment,
  type ProjectEnvironmentOrigin,
} from "@/lib/environment-label";
// NOTE the import direction: `environment-label` imports ONLY a type from this
// module (`import type`, erased at build), so this value import does not create
// a runtime cycle. Keep it that way — a value import back this way would.

/**
 * Client hooks for **Project environments** (mcpjam-backend
 * `convex/projectEnvironments.ts`) — named, project-scoped, live-editable
 * bundles of one host + optional standalone server group + optional pinned
 * skill selection. Suites and journeys reference environments by id and the
 * backend resolves/pins them at run start.
 *
 * NOT the same thing as Computer environments (`useComputerEnvironments.ts`,
 * the e2b/Docker sandbox images — relabeled "Sandbox images" in UI). Like
 * every backend surface here, Convex functions are referenced by string id;
 * the types below are hand-mirrored (no codegen).
 */

/** One skill held at an EXACT revision, rather than tracking Latest. */
export type ProjectEnvironmentSkillVersionPin = {
  skillId: string;
  versionId: string;
};

export type ProjectEnvironmentSkillSelection = {
  mode: "explicit";
  skillIds: string[];
  /**
   * Exact-version overlay on top of `skillIds`. At most one entry per selected
   * skill; a selected skill with NO entry runs "Latest" — its current revision,
   * resolved when the run starts, which is what every environment did before
   * pins existed and what omitting this field still means.
   *
   * Absent rather than `[]` when nothing is pinned, matching how the backend
   * stores it: an unpinned environment must serialize (and fingerprint)
   * identically to one written before this feature.
   */
  versionPins?: ProjectEnvironmentSkillVersionPin[];
};

/**
 * THE client mirror of a Project environment row. Every client surface
 * (management route, suite picker, swarms) imports this one — do not add a
 * second per-surface copy.
 *
 * This mirrors the CONVEX view shape (`environmentId`, `archivedAt`), which is
 * what the reactive queries below return. It is deliberately NOT the SDK's
 * `PlatformEnvironment`: that is the public `/api/v1` wire shape (`id`,
 * `archived: boolean`) and the browser never speaks that API.
 */
export interface ProjectEnvironmentView {
  environmentId: string;
  projectId: string;
  /**
   * ABSENT on ad-hoc rows, which have no name by construction.
   *
   * Never render this directly — call `environmentLabel()` from
   * `@/lib/environment-label`, which derives a label from row data when the
   * name is missing. Rendering it raw is how a nameless row becomes a blank
   * cell or an `Archive "undefined"?` confirmation.
   */
  name?: string;
  /**
   * Which KIND of row this is — see `@/lib/environment-label`.
   *
   * OPTIONAL for deploy skew: a backend that predates the split omits it, and
   * every row it returns is named. Read it through `environmentOrigin()`, which
   * falls back to name-presence, rather than testing this field directly.
   */
  origin?: ProjectEnvironmentOrigin;
  /** Backend content fingerprint; the ad-hoc dedupe key. Ad-hoc rows only. */
  fingerprint?: string;
  /**
   * Denormalized usage counters, bumped by `ensureAdhocEnvironment`. ABSENT is
   * NOT zero — an older backend omits them, and a surface must render nothing
   * rather than "0 runs" when it cannot tell the difference.
   */
  lastUsedAt?: number;
  runCount?: number;
  description?: string;
  /** Exactly one host per environment. */
  hostId: string;
  /** Standalone server group scope; absent ⇒ the host's own server picks. */
  serverAttachmentId?: string | null;
  /**
   * Stored model override. Absent ⇒ this environment inherits its client's
   * model. Deliberately NOT the effective model: a list row that conflated
   * the two could not tell "pinned to X" from "inheriting X".
   */
  modelId?: string;
  /** Additive standalone skill channel; absent ⇒ no env-channel skills. */
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  /**
   * Pinned plugin VERSION ids. Read-only from the client today — the editor
   * has no plugin-version picker yet, so edits must leave this field ABSENT
   * (undefined = unchanged) rather than sending it and clearing the pins.
   */
  pluginVersionIds?: string[];
  /**
   * Sandbox-image pin: the `computerEnvironments` image (see
   * `useSandboxImages.ts` — NOT another project environment, despite the
   * backend field name) that reproducibility runs boot a fresh ephemeral
   * sandbox from. Backend accepts project-shared images only. Absent ⇒
   * provider default base image.
   */
  computerEnvironmentId?: string | null;
  /** Bumped on every effective edit; optimistic-concurrency token. */
  revision: number;
  /** Present ⇒ archived (hidden from pickers; launches fail fast). */
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Environments for a project. The management route passes
 * `includeArchived: true`; suite/journey pickers use the live-only default.
 * `undefined` while loading or when the query is skipped.
 *
 * ## Ad-hoc rows are excluded by default
 *
 * Most surfaces — every picker, the Connect strip, the schedule editor — offer
 * environments a human chose to name. Ad-hoc rows are machine-minted and would
 * flood them, so `includeAdhoc` is opt-in and this hook filters them out
 * otherwise.
 *
 * That filter is deliberately REDUNDANT with the backend's own default (which
 * also returns named-only). Belt and braces, because the two protect different
 * failure modes: the backend default is what keeps already-deployed clients and
 * the public `/v1` list correct during rollout, and this filter is what keeps
 * THIS client correct against a backend that ignores the argument.
 *
 * Note the argument is only SENT when opting in. A backend that predates the
 * split rejects unknown args with a validation error, so passing the default
 * explicitly would turn a harmless skew into a hard failure.
 */
export function useProjectEnvironments(
  projectId: string | null,
  options?: { includeArchived?: boolean; includeAdhoc?: boolean },
): ProjectEnvironmentView[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  // Send the SAME normalized id `shouldQueryProjectId` validated — a
  // whitespace-padded id passes the guard but would target a different/invalid
  // project if forwarded raw.
  const normalizedProjectId = projectId?.trim() || null;
  const enableQuery =
    isAuthenticated && isUserReady && shouldQueryProjectId(normalizedProjectId);
  const includeAdhoc = options?.includeAdhoc ?? false;
  const rows = useQuery(
    "projectEnvironments:listEnvironments" as any,
    enableQuery
      ? ({
          projectId: normalizedProjectId,
          ...(options?.includeArchived ? { includeArchived: true } : {}),
          ...(includeAdhoc ? { origin: "all" } : {}),
        } as any)
      : "skip",
  ) as ProjectEnvironmentView[] | undefined;
  return useMemo(() => {
    if (rows === undefined) return undefined;
    if (includeAdhoc) return rows;
    return rows.filter(isNamedEnvironment);
  }, [rows, includeAdhoc]);
}

/**
 * One environment, or `null` when not visible.
 *
 * `projectId` is REQUIRED by the backend query: it scopes the lookup, so an id
 * from another of the caller's projects reads as not-found instead of leaking
 * across projects. Passing only the environment id fails validation.
 */
export function useProjectEnvironment(
  projectId: string | null,
  environmentId: string | null,
): ProjectEnvironmentView | null | undefined {
  // Same gate as the list hook: without the auth/db-ready checks the query can
  // fire before the backend identity exists and fail rather than skip.
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  // Normalize BOTH ids for the same reason: a whitespace-padded value passes a
  // bare truthiness check but would target a different (invalid) row.
  const normalizedProjectId = projectId?.trim() || null;
  const normalizedEnvironmentId = environmentId?.trim() || null;
  const enableQuery =
    isAuthenticated &&
    isUserReady &&
    shouldQueryProjectId(normalizedProjectId) &&
    Boolean(normalizedEnvironmentId);
  return useQuery(
    "projectEnvironments:getEnvironment" as any,
    enableQuery
      ? ({
          projectId: normalizedProjectId,
          environmentId: normalizedEnvironmentId,
        } as any)
      : "skip",
  ) as ProjectEnvironmentView | null | undefined;
}

export function useCreateProjectEnvironment(): (args: {
  projectId: string;
  name: string;
  description?: string;
  hostId: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  /**
   * Pinned plugin versions. No editor control ships this yet; the argument
   * exists so the client mirror matches the backend contract. An empty array
   * is REJECTED by the backend — omit the field to mean "no pins".
   */
  pluginVersionIds?: string[];
  /** Sandbox-image pin; omit for the default base image (create never clears). */
  computerEnvironmentId?: string;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:createEnvironment" as any) as never;
}

/**
 * Get-or-create the AD-HOC environment for a composition, in one transaction.
 *
 * `name` is absent from the argument list on purpose: an ad-hoc row cannot
 * carry one, and accepting-then-ignoring a name would let a caller believe it
 * had named something. Naming is {@link usePromoteProjectEnvironment}.
 *
 * The backend fingerprints the composition and returns an existing row when one
 * matches, so this is idempotent — running the same stack fifty times yields one
 * row. The fingerprint is computed server-side and never crosses the wire,
 * which is what makes a client/server canonicalizer drift impossible.
 *
 * MEMBER-gated, unlike `createEnvironment`'s admin escalation for plugin pins —
 * except that pinning plugins escalates here too, for the same reason it does
 * there: pinning a version is plugin-lifecycle authority, and this must not
 * become a side door into it.
 *
 * `created` distinguishes a mint from a match. A backend that omits it reads as
 * a reuse, which only costs a word in a toast.
 */
export function useEnsureAdhocEnvironment(): (args: {
  projectId: string;
  hostId: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId?: string;
  /** Explicit model override. Omit to inherit the client's model. */
  modelId?: string;
}) => Promise<{ environment: ProjectEnvironmentView; created?: boolean }> {
  return useMutation(
    "projectEnvironments:ensureAdhocEnvironment" as any,
  ) as never;
}

/**
 * Batch form: get-or-create one ad-hoc environment per composition, atomically.
 *
 * Preferred over N sequential {@link useEnsureAdhocEnvironment} calls on the
 * launch path. A swarm fans out to up to `MAX_ENVIRONMENTS_PER_JOURNEY` clients,
 * and the per-call loop it replaces could fail midway and leave orphan rows
 * behind. One transaction makes materialization all-or-nothing, and two
 * identical stacks in one batch resolve to one row naturally (the second lookup
 * sees the first insert).
 *
 * Results are returned in input order.
 */
export function useEnsureAdhocEnvironments(): (args: {
  projectId: string;
  stacks: Array<{
    hostId: string;
    serverAttachmentId?: string | null;
    skillSelection?: ProjectEnvironmentSkillSelection | null;
    computerEnvironmentId?: string;
    /** Explicit model override. Omit to inherit the client's model. */
    modelId?: string;
  }>;
}) => Promise<
  Array<{ environment: ProjectEnvironmentView; created?: boolean }>
> {
  return useMutation(
    "projectEnvironments:ensureAdhocEnvironments" as any,
  ) as never;
}

/**
 * Promote an ad-hoc row to a named environment, IN PLACE.
 *
 * The returned row keeps the SAME `environmentId`. That is not an
 * implementation detail — synthetic swarm session ids are derived from it
 * (`shared/swarm-session-id.ts`: `synth_<runId>_env_<environmentId>_<idx>`), so
 * an implementation that inserted a new row and archived the old one would make
 * every historical run's session cells unresolvable. Any change here must keep
 * the id stable.
 *
 * MEMBER-gated, matching `createEnvironment`. Promotion touches only the name,
 * description, and kind — by construction it cannot change what any existing
 * suite or journey resolves to, which is what the admin gate on the MUTATING
 * operations actually protects. Note the direction of travel: it moves a row
 * from member-writable to admin-only, so it REDUCES the promoter's own power
 * over it.
 *
 * Takes `expectedRevision` like every other environment write. Ad-hoc rows are
 * immutable so the revision is always 1, which makes it look like ceremony — it
 * is not: it closes the race where two people promote the same row from the same
 * screen and the second silently clobbers the first's name.
 */
export function usePromoteProjectEnvironment(): (args: {
  projectId: string;
  environmentId: string;
  expectedRevision: number;
  name: string;
  description?: string;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:nameEnvironment" as any) as never;
}

/**
 * Update takes `expectedRevision` — the repo's expectedRevision pattern:
 * capture the row's revision when the editor DRAFT is initialized/reset and
 * send THAT captured value, never the newest reactive revision at submit
 * time (substituting the fresh revision would let a stale draft silently
 * overwrite a concurrent edit). On {@link isRevisionConflictError}, surface
 * the conflict and reinitialize only after user confirmation — never
 * auto-retry a stale patch.
 *
 * `projectId` is REQUIRED, like every other mutation here: the backend scopes
 * the admin check and the row lookup by it, so it is not derivable from the
 * environment id. Omitting it fails the Convex validator at RUNTIME (the
 * mutation is referenced by string id, so nothing type-checks the payload).
 */
export function useUpdateProjectEnvironment(): (args: {
  projectId: string;
  environmentId: string;
  expectedRevision: number;
  name?: string;
  description?: string | null;
  hostId?: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  /**
   * Tri-state, like the other clearable fields: OMIT to leave the pins
   * untouched, `null` to clear them. Since no editor can author pins yet,
   * every current caller must omit it — sending `null` from a form that simply
   * doesn't render the control would silently drop pins the user set through
   * the API or CLI. An empty array is rejected by the backend.
   */
  pluginVersionIds?: string[] | null;
  /**
   * Sandbox-image pin. Tri-state like the fields above: OMIT to leave the pin
   * untouched, `null` to clear it, a value to set it. A form that does not
   * RENDER the picker (e.g. the `computers-enabled` flag is off) must omit the
   * field — sending `null` would silently drop a pin set through the API/CLI.
   */
  computerEnvironmentId?: string | null;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:updateEnvironment" as any) as never;
}

/** `projectId` is required — see {@link useUpdateProjectEnvironment}. */
export function useArchiveProjectEnvironment(): (args: {
  projectId: string;
  environmentId: string;
  expectedRevision: number;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:archiveEnvironment" as any) as never;
}

/** `projectId` is required — see {@link useUpdateProjectEnvironment}. */
export function useRestoreProjectEnvironment(): (args: {
  projectId: string;
  environmentId: string;
  expectedRevision: number;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:restoreEnvironment" as any) as never;
}

/**
 * True when a mutation rejection is the backend's stale-`expectedRevision`
 * conflict. Wire-tolerant: matches the structured ConvexError code first and
 * falls back to a message probe so a backend code rename degrades to a
 * still-correct conflict toast rather than a generic failure.
 */
export function isRevisionConflictError(err: unknown): boolean {
  const data = (err as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (
      code === "CONFLICT" ||
      code === "REVISION_CONFLICT" ||
      code === "ENV_REVISION_CONFLICT"
    ) {
      return true;
    }
  }
  const message =
    typeof data === "string" ? data : err instanceof Error ? err.message : "";
  return /revision/i.test(message) && /conflict|stale|changed/i.test(message);
}

export { useModelMatrixCapability } from "@/hooks/use-model-matrix-capability";
