import { useMutation, useQuery } from "convex/react";
import type { HostConfigDtoV2, HostConfigInputV2 } from "@/lib/client-config-v2";
import { shouldQueryProjectId } from "./useProjects";

/**
 * Product ownership of a host, mirrored from the backend `hosts.ownerScope`
 * (see mcpjam-backend convex/schema.ts). `null` = untagged/legacy (visible to
 * both products). `journeys` = standalone, Swarm-owned, NO publish surface.
 * NOT an auth signal — it drives product filtering, badges, and whether the
 * Chatbox surface offers a publish surface at all.
 */
export type HostOwnerScope =
  | { type: "suite"; testSuiteId: string }
  | { type: "chatbox"; chatboxId: string }
  | { type: "journeys" }
  | null;

export interface HostListItem {
  hostId: string;
  name: string;
  hostConfigId: string;
  modelId: string;
  serverCount: number;
  // Additive (PR: standalone hosts). Older backends omit these; readers must
  // treat absent as null/false rather than assume presence.
  ownerScope?: HostOwnerScope;
  hasComputer?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HostDetail {
  hostId: string;
  name: string;
  config: HostConfigDtoV2;
  // Additive: the Chatbox surface reads this to decide whether to render the
  // "managed by Swarms, no publish surface" notice instead of back-minting.
  ownerScope?: HostOwnerScope;
}

export function useHostList({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}): {
  hosts: HostListItem[];
  isLoading: boolean;
} {
  // Skip until `projectId` is a real Convex id. A transient LOCAL project id
  // (UUID, or a `local_`/`project_` placeholder) flows in while the shared
  // Convex id is still resolving — passing it to a `v.id("projects")` query
  // throws an ArgumentValidationError. `shouldQueryProjectId` is the same guard
  // every other project-scoped Convex query uses.
  const result = useQuery(
    "hosts:listHosts" as any,
    isAuthenticated && shouldQueryProjectId(projectId)
      ? ({ projectId } as any)
      : "skip",
  ) as HostListItem[] | null | undefined;

  return {
    hosts: result ?? [],
    isLoading: result === undefined,
  };
}

export function useHost({
  isAuthenticated,
  hostId,
}: {
  isAuthenticated: boolean;
  hostId: string | null;
}): {
  host: HostDetail | null;
  isLoading: boolean;
} {
  const result = useQuery(
    "hosts:getHost" as any,
    isAuthenticated && hostId ? ({ hostId } as any) : "skip",
  ) as HostDetail | null | undefined;

  return {
    host: result ?? null,
    isLoading: result === undefined,
  };
}

export function useHostMutations() {
  const createHost = useMutation("hosts:createHost" as any) as unknown as (args: {
    projectId: string;
    name: string;
    input: HostConfigInputV2;
    // `'journeys'` → mint a standalone (chatbox-less) host owned by the Swarm
    // surface. Absent → legacy behavior (a chatbox is minted).
    owner?: "journeys";
  }) => Promise<{ hostId: string; hostConfigId: string; chatboxId: string | null }>;

  const updateHost = useMutation("hosts:updateHost" as any) as unknown as (args: {
    hostId: string;
    name?: string;
    input?: HostConfigInputV2;
  }) => Promise<{ hostId: string; hostConfigId: string }>;

  const deleteHost = useMutation("hosts:deleteHost" as any) as unknown as (args: {
    hostId: string;
    force?: boolean;
  }) => Promise<void>;

  const duplicateHost = useMutation("hosts:duplicateHost" as any) as unknown as (args: {
    hostId: string;
    name?: string;
  }) => Promise<{ hostId: string; hostConfigId: string }>;

  return { createHost, updateHost, deleteHost, duplicateHost };
}
