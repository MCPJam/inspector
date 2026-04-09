import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { getGuestBearerToken } from "@/lib/guest-session";
import { WebApiError } from "./base";

export interface ChatHistorySession {
  _id: string;
  chatSessionId: string;
  workspaceId?: string;
  customTitle?: string;
  firstMessagePreview: string;
  status: "active" | "archived";
  directVisibility: "private" | "workspace";
  modelId?: string;
  modelSource?: string;
  messageCount: number;
  version: number;
  startedAt: number;
  lastActivityAt: number;
  userId?: string;
  guestExternalId?: string;
  isPinned: boolean;
  pinnedAt?: number;
  lastReadAt?: number;
  manualUnread: boolean;
  isUnread: boolean;
}

export interface ChatHistoryListResponse {
  ok: boolean;
  personal: ChatHistorySession[];
  workspace: ChatHistorySession[];
}

export interface ResumeConfig {
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  selectedServers?: string[];
  draftInput?: string;
}

export interface ChatHistoryDetailSession extends ChatHistorySession {
  messagesBlobUrl: string | null;
  resumeConfig?: ResumeConfig;
}

export interface ChatHistoryWidgetSnapshot {
  _id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  serverId: string;
  uiType: "mcp-apps" | "openai-apps";
  resourceUri?: string;
  widgetCsp: Record<string, unknown> | null;
  widgetPermissions: Record<string, unknown> | null;
  widgetPermissive: boolean;
  prefersBorder: boolean;
  widgetHtmlUrl?: string | null;
}

export interface ChatHistoryDetailResponse {
  ok: boolean;
  session: ChatHistoryDetailSession;
  widgetSnapshots?: ChatHistoryWidgetSnapshot[];
}

export interface UpsertChatHistoryDraftRequest {
  chatSessionId: string;
  workspaceId?: string;
  firstMessagePreview: string;
  modelId?: string;
  modelSource?: string;
  resumeConfig?: ResumeConfig;
}

interface ChatHistoryRequestOptions {
  headers?: HeadersInit;
}

async function buildChatHistoryHeaders(
  initHeaders?: HeadersInit,
): Promise<HeadersInit | undefined> {
  const headers = new Headers(initHeaders);

  if (!HOSTED_MODE && !headers.has("Authorization")) {
    const guestToken = await getGuestBearerToken();
    if (guestToken) {
      headers.set("Authorization", `Bearer ${guestToken}`);
    }
  }

  return Array.from(headers.keys()).length > 0 ? headers : undefined;
}

async function webGet<T>(
  path: string,
  options?: ChatHistoryRequestOptions,
): Promise<T> {
  const response = await authFetch(path, {
    method: "GET",
    headers: await buildChatHistoryHeaders(options?.headers),
  });

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : null;
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : `Request failed (${response.status})`;
    throw new WebApiError(response.status, code, message);
  }

  return body as T;
}

async function webPost<TRequest, TResponse>(
  path: string,
  payload: TRequest,
  options?: ChatHistoryRequestOptions,
): Promise<TResponse> {
  const initHeaders = new Headers(options?.headers);
  initHeaders.set("Content-Type", "application/json");
  const headers = new Headers(await buildChatHistoryHeaders(initHeaders));
  const response = await authFetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : null;
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : `Request failed (${response.status})`;
    throw new WebApiError(response.status, code, message);
  }

  return body as TResponse;
}

export async function listChatHistory(
  params: {
    workspaceId?: string;
    status: "active" | "archived";
    limit?: number;
    before?: number;
  },
  requestOptions?: ChatHistoryRequestOptions,
): Promise<ChatHistoryListResponse> {
  const searchParams = new URLSearchParams();
  if (params.workspaceId) searchParams.set("workspaceId", params.workspaceId);
  searchParams.set("status", params.status);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.before) searchParams.set("before", String(params.before));

  return webGet<ChatHistoryListResponse>(
    `/api/web/chat-history/list?${searchParams.toString()}`,
    requestOptions,
  );
}

export async function getChatHistoryDetail(
  params: {
    sessionId?: string;
    chatSessionId: string;
    workspaceId?: string;
  },
  requestOptions?: ChatHistoryRequestOptions,
): Promise<ChatHistoryDetailResponse> {
  const searchParams = new URLSearchParams();
  if (params.sessionId) searchParams.set("sessionId", params.sessionId);
  searchParams.set("chatSessionId", params.chatSessionId);
  if (params.workspaceId) searchParams.set("workspaceId", params.workspaceId);

  return webGet<ChatHistoryDetailResponse>(
    `/api/web/chat-history/detail?${searchParams.toString()}`,
    requestOptions,
  );
}

export async function chatHistoryAction(
  action: string,
  sessionId: string,
  params?: Record<string, unknown>,
  requestOptions?: ChatHistoryRequestOptions,
): Promise<{ ok: boolean }> {
  return webPost<Record<string, unknown>, { ok: boolean }>(
    "/api/web/chat-history/action",
    { action, sessionId, ...params },
    requestOptions,
  );
}

export async function upsertChatHistoryDraft(
  payload: UpsertChatHistoryDraftRequest,
  requestOptions?: ChatHistoryRequestOptions,
): Promise<ChatHistoryDetailResponse> {
  return webPost<UpsertChatHistoryDraftRequest, ChatHistoryDetailResponse>(
    "/api/web/chat-history/draft",
    payload,
    requestOptions,
  );
}
