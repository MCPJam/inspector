import { useMutation, useQuery } from "convex/react";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import type {
  ChatUiSettings,
  ChatboxFeedbackDialogSettings,
  ChatboxWelcomeDialogSettings,
} from "@/types/chatUi";

export type {
  ChatUiSettings,
  ChatboxFeedbackDialogSettings,
  ChatboxWelcomeDialogSettings,
};

export type ChatboxMode =
  | "anyone_with_link"
  | "invited_only"
  | "project_members";

export interface ChatboxMember {
  _id: string;
  chatboxId: string;
  projectId: string;
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

export interface ChatboxSettings {
  chatboxId: string;
  projectId: string;
  name: string;
  description?: string;
  hostStyle: ChatboxHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  allowGuestAccess: boolean;
  mode: ChatboxMode;
  /** Chat UI config envelope: welcome / feedback dialog surfaces (and future surfaces / branding). */
  chatUi?: ChatUiSettings | null;
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
  projectId: string;
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
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}) {
  const chatboxes = useQuery(
    "chatboxes:listChatboxes" as any,
    isAuthenticated && projectId ? ({ projectId } as any) : "skip",
  ) as ChatboxListItem[] | undefined;

  return {
    chatboxes,
    isLoading: isAuthenticated && !!projectId && chatboxes === undefined,
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
