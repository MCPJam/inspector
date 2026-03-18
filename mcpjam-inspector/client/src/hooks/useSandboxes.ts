import { useMutation, useQuery } from "convex/react";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";

export type SandboxMode = "any_signed_in_with_link" | "invited_only";

export interface SandboxMember {
  _id: string;
  sandboxId: string;
  workspaceId: string;
  email: string;
  userId?: string;
  role: "chat";
  invitedBy: string;
  invitedAt: number;
  revokedAt?: number;
  acceptedAt?: number;
  user: {
    _id: string;
    name: string;
    email: string;
    imageUrl: string;
  } | null;
}

export interface SandboxServerSettings {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
}

export interface SandboxSettings {
  sandboxId: string;
  workspaceId: string;
  name: string;
  description?: string;
  hostStyle: SandboxHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  allowGuestAccess: boolean;
  mode: SandboxMode;
  servers: SandboxServerSettings[];
  link: {
    token: string;
    path: string;
    url: string;
    rotatedAt: number;
    updatedAt: number;
  } | null;
  members: SandboxMember[];
}

export interface SandboxListItem {
  sandboxId: string;
  workspaceId: string;
  name: string;
  description?: string;
  hostStyle: SandboxHostStyle;
  mode: SandboxMode;
  allowGuestAccess: boolean;
  serverCount: number;
  serverNames: string[];
  createdAt: number;
  updatedAt: number;
}

export function useSandboxList({
  isAuthenticated,
  workspaceId,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
}) {
  const sandboxes = useQuery(
    "sandboxes:listSandboxes" as any,
    isAuthenticated && workspaceId ? ({ workspaceId } as any) : "skip",
  ) as SandboxListItem[] | undefined;

  return {
    sandboxes,
    isLoading: isAuthenticated && !!workspaceId && sandboxes === undefined,
  };
}

export function useSandbox({
  isAuthenticated,
  sandboxId,
}: {
  isAuthenticated: boolean;
  sandboxId: string | null;
}) {
  const sandbox = useQuery(
    "sandboxes:getSandbox" as any,
    isAuthenticated && sandboxId ? ({ sandboxId } as any) : "skip",
  ) as SandboxSettings | null | undefined;

  return {
    sandbox,
    isLoading: isAuthenticated && !!sandboxId && sandbox === undefined,
  };
}

export function useSandboxMutations() {
  const createSandbox = useMutation("sandboxes:createSandbox" as any);
  const duplicateSandbox = useMutation("sandboxes:duplicateSandbox" as any);
  const updateSandbox = useMutation("sandboxes:updateSandbox" as any);
  const deleteSandbox = useMutation("sandboxes:deleteSandbox" as any);
  const setSandboxMode = useMutation("sandboxes:setSandboxMode" as any);
  const rotateSandboxLink = useMutation("sandboxes:rotateSandboxLink" as any);
  const upsertSandboxMember = useMutation(
    "sandboxes:upsertSandboxMember" as any,
  );
  const removeSandboxMember = useMutation(
    "sandboxes:removeSandboxMember" as any,
  );

  return {
    createSandbox,
    duplicateSandbox,
    updateSandbox,
    deleteSandbox,
    setSandboxMode,
    rotateSandboxLink,
    upsertSandboxMember,
    removeSandboxMember,
  };
}
