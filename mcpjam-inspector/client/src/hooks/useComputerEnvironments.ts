import { useMutation, useQuery } from "convex/react";

/**
 * Client hooks for Computer **environments** (mcpjam-backend
 * `convex/computerEnvironments.ts` + the `projectComputers` attach/reset
 * functions). Like `useProjectComputer`, the inspector references Convex
 * functions by string id — it does not import the backend's generated `api`.
 *
 * An environment is a project-owned Dockerfile, built into an immutable image
 * that a member's Computer can boot from. Builds run under the deployment's
 * configured builder (`stub` by default; real images only when an operator sets
 * `COMPUTERS_ENV_BUILDER=e2b`).
 */

export type BuildStatus = "queued" | "building" | "ready" | "failed";

export interface EnvironmentBuildView {
  buildId: string;
  status: BuildStatus;
  provider: "e2b" | "stub";
  e2bBuildId?: string;
  baseImageDigests: string[];
  logPreview?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface EnvironmentView {
  environmentId: string;
  projectId: string;
  name: string;
  dockerfile: string;
  contentHash: string;
  sharing: "user" | "project";
  /** True only for a per-user draft the caller owns. Project-shared envs are
   * admin-managed; the backend (not the client) is the authority on that, so
   * shared-env controls are optimistic — see the drawer. */
  isOwner: boolean;
  currentBuildId?: string;
  currentBuild: EnvironmentBuildView | null;
  createdAt: number;
  updatedAt: number;
}

/** Visible environments for a project: the caller's own drafts + the
 * project-shared ones. `undefined` while loading / when `projectId` is absent. */
export function useEnvironments(
  projectId: string | null
): EnvironmentView[] | undefined {
  return useQuery(
    "computerEnvironments:listEnvironments" as never,
    projectId ? ({ projectId } as never) : "skip"
  ) as EnvironmentView[] | undefined;
}

/** One environment (with its current build), or `null` if not visible. */
export function useEnvironment(
  environmentId: string | null
): EnvironmentView | null | undefined {
  return useQuery(
    "computerEnvironments:getEnvironment" as never,
    environmentId ? ({ environmentId } as never) : "skip"
  ) as EnvironmentView | null | undefined;
}

/** All builds for an environment, newest first. */
export function useEnvironmentBuilds(
  environmentId: string | null
): EnvironmentBuildView[] | undefined {
  return useQuery(
    "computerEnvironments:listEnvironmentBuilds" as never,
    environmentId ? ({ environmentId } as never) : "skip"
  ) as EnvironmentBuildView[] | undefined;
}

export function useCreateEnvironment(): (args: {
  projectId: string;
  name: string;
  dockerfile: string;
}) => Promise<EnvironmentView> {
  return useMutation("computerEnvironments:createEnvironment" as never) as never;
}

export function useUpdateEnvironment(): (args: {
  environmentId: string;
  name?: string;
  dockerfile?: string;
}) => Promise<EnvironmentView> {
  return useMutation("computerEnvironments:updateEnvironment" as never) as never;
}

export function useStartEnvironmentBuild(): (args: {
  environmentId: string;
}) => Promise<{ buildId: string; reused: boolean }> {
  return useMutation(
    "computerEnvironments:startEnvironmentBuild" as never
  ) as never;
}

export function usePromoteEnvironment(): (args: {
  environmentId: string;
}) => Promise<EnvironmentView> {
  return useMutation(
    "computerEnvironments:promoteEnvironmentToProject" as never
  ) as never;
}

export function useDeleteEnvironment(): (args: {
  environmentId: string;
}) => Promise<{ deleted: true }> {
  return useMutation("computerEnvironments:deleteEnvironment" as never) as never;
}

/** Attach an environment to the caller's computer (or detach with `null`),
 * which re-provisions the box from the pinned image. */
export function useSetComputerEnvironment(): (args: {
  projectId: string;
  environmentId: string | null;
}) => Promise<{ computerId: string; status: string; environmentId?: string }> {
  return useMutation(
    "projectComputers:setComputerEnvironment" as never
  ) as never;
}

/** Reset the computer to its image (wipes mutable state). */
export function useResetComputer(): (args: {
  projectId: string;
}) => Promise<{ reset: boolean }> {
  return useMutation("projectComputers:resetComputer" as never) as never;
}
