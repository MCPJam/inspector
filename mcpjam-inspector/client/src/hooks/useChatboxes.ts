import { useMutation, useQuery } from "convex/react";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";

export type ChatboxMode = "any_signed_in_with_link" | "invited_only";

export interface ChatboxMember {
  _id: string;
  chatboxId: string;
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

export interface ChatboxServerSettings {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
  /** When true, server is not connected until the tester enables it (off by default). */
  optional?: boolean;
}

export interface ChatboxWelcomeDialogSettings {
  enabled: boolean;
  body?: string;
}

export interface ChatboxFeedbackDialogSettings {
  enabled: boolean;
  /** Completed tool calls between feedback prompts in hosted sessions (not user message count). */
  everyNToolCalls?: number;
  promptHint?: string;
}

export interface ChatboxSettings {
  chatboxId: string;
  workspaceId: string;
  name: string;
  description?: string;
  hostStyle: ChatboxHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  allowGuestAccess: boolean;
  mode: ChatboxMode;
  /** When present, drives welcome dialog in hosted chatbox (Convex may add fields incrementally). */
  welcomeDialog?: ChatboxWelcomeDialogSettings | null;
  /** When present, drives tester feedback cadence and copy. */
  feedbackDialog?: ChatboxFeedbackDialogSettings | null;
  servers: ChatboxServerSettings[];
  link: {
    token: string;
    path: string;
    url: string;
    rotatedAt: number;
    updatedAt: number;
  } | null;
  members: ChatboxMember[];
}

export interface ChatboxListItem {
  chatboxId: string;
  workspaceId: string;
  name: string;
  description?: string;
  hostStyle: ChatboxHostStyle;
  mode: ChatboxMode;
  allowGuestAccess: boolean;
  serverCount: number;
  serverNames: string[];
  createdAt: number;
  updatedAt: number;
}

export function useChatboxList({
  isAuthenticated,
  workspaceId,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
}) {
  const chatboxes = useQuery(
    "chatboxes:listChatboxes" as any,
    isAuthenticated && workspaceId ? ({ workspaceId } as any) : "skip",
  ) as ChatboxListItem[] | undefined;

  return {
    chatboxes,
    isLoading: isAuthenticated && !!workspaceId && chatboxes === undefined,
  };
}

export function useChatbox({
  isAuthenticated,
  chatboxId,
}: {
  isAuthenticated: boolean;
  chatboxId: string | null;
}) {
  const chatbox = useQuery(
    "chatboxes:getChatbox" as any,
    isAuthenticated && chatboxId ? ({ chatboxId } as any) : "skip",
  ) as ChatboxSettings | null | undefined;

  return {
    chatbox,
    isLoading: isAuthenticated && !!chatboxId && chatbox === undefined,
  };
}

export function useChatboxMutations() {
  const createChatbox = useMutation("chatboxes:createChatbox" as any);
  const duplicateChatbox = useMutation("chatboxes:duplicateChatbox" as any);
  const updateChatbox = useMutation("chatboxes:updateChatbox" as any);
  const deleteChatbox = useMutation("chatboxes:deleteChatbox" as any);
  const setChatboxMode = useMutation("chatboxes:setChatboxMode" as any);
  const rotateChatboxLink = useMutation("chatboxes:rotateChatboxLink" as any);
  const upsertChatboxMember = useMutation(
    "chatboxes:upsertChatboxMember" as any,
  );
  const removeChatboxMember = useMutation(
    "chatboxes:removeChatboxMember" as any,
  );

  return {
    createChatbox,
    duplicateChatbox,
    updateChatbox,
    deleteChatbox,
    setChatboxMode,
    rotateChatboxLink,
    upsertChatboxMember,
    removeChatboxMember,
  };
}
