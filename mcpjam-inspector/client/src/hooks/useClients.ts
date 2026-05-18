import { useMutation, useQuery } from "convex/react";
import type { HostConfigDtoV2, HostConfigInputV2 } from "@/lib/host-config-v2";

export interface HostListItem {
  hostId: string;
  name: string;
  hostConfigId: string;
  modelId: string;
  serverCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface HostDetail {
  hostId: string;
  name: string;
  config: HostConfigDtoV2;
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
  const result = useQuery(
    "hosts:listHosts" as any,
    isAuthenticated && projectId
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
  }) => Promise<{ hostId: string; hostConfigId: string }>;

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
