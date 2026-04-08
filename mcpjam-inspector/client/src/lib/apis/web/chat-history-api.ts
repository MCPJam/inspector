import { authFetch } from "@/lib/session-token";
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
}

export interface ChatHistoryDetailSession extends ChatHistorySession {
  messagesBlobUrl: string | null;
  resumeConfig?: ResumeConfig;
}

export interface ChatHistoryDetailResponse {
  ok: boolean;
  session: ChatHistoryDetailSession;
}

async function webGet<T>(path: string): Promise<T> {
  const response = await authFetch(path, { method: "GET" });

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
): Promise<TResponse> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export async function listChatHistory(params: {
  workspaceId?: string;
  status: "active" | "archived";
  limit?: number;
  before?: number;
}): Promise<ChatHistoryListResponse> {
  const searchParams = new URLSearchParams();
  if (params.workspaceId) searchParams.set("workspaceId", params.workspaceId);
  searchParams.set("status", params.status);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.before) searchParams.set("before", String(params.before));

  return webGet<ChatHistoryListResponse>(
    `/web/chat-history/list?${searchParams.toString()}`,
  );
}

export async function getChatHistoryDetail(params: {
  chatSessionId: string;
  workspaceId?: string;
}): Promise<ChatHistoryDetailResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set("chatSessionId", params.chatSessionId);
  if (params.workspaceId) searchParams.set("workspaceId", params.workspaceId);

  return webGet<ChatHistoryDetailResponse>(
    `/web/chat-history/detail?${searchParams.toString()}`,
  );
}

export async function chatHistoryAction(
  action: string,
  sessionId: string,
  params?: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  return webPost<Record<string, unknown>, { ok: boolean }>(
    "/web/chat-history/action",
    { action, sessionId, ...params },
  );
}
