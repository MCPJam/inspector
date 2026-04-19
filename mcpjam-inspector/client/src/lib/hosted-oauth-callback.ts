import type { HostedOAuthSurface } from "@/lib/hosted-oauth-resume";
import {
  readChatboxSession,
  CHATBOX_OAUTH_PENDING_KEY,
} from "@/lib/chatbox-session";
import {
  readSharedServerSession,
  SHARED_OAUTH_PENDING_KEY,
  slugify,
} from "@/lib/shared-server-session";

export interface HostedOAuthPendingMarker {
  surface: HostedOAuthSurface;
  workspaceId?: string | null;
  serverId?: string | null;
  serverName: string;
  serverUrl: string | null;
  accessScope?: "workspace_member" | "chat_v2";
  shareToken?: string | null;
  chatboxToken?: string | null;
  returnHash: string | null;
  startedAt: number;
}

export interface HostedOAuthCallbackContext extends HostedOAuthPendingMarker {}

export const HOSTED_OAUTH_PENDING_STORAGE_KEY = "mcp-hosted-oauth-pending";

const HOSTED_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export function normalizeHostedOAuthServerName(
  serverName?: string | null,
): string {
  return serverName?.trim().toLowerCase() ?? "";
}

function normalizeHostedOAuthReturnHash(
  hashValue?: string | null,
): string | null {
  const trimmed = hashValue?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith("#") ? trimmed : `#${trimmed.replace(/^\/+/, "")}`;
}

export function matchesHostedOAuthServerIdentity(
  left: {
    serverName?: string | null;
    serverUrl?: string | null;
  },
  right: {
    serverName?: string | null;
    serverUrl?: string | null;
  },
): boolean {
  if (left.serverUrl && right.serverUrl && left.serverUrl === right.serverUrl) {
    return true;
  }

  const leftName = normalizeHostedOAuthServerName(left.serverName);
  const rightName = normalizeHostedOAuthServerName(right.serverName);
  return !!leftName && !!rightName && leftName === rightName;
}

export function writeHostedOAuthPendingMarker(
  marker: Omit<HostedOAuthPendingMarker, "startedAt">,
): void {
  try {
    localStorage.setItem(
      HOSTED_OAUTH_PENDING_STORAGE_KEY,
      JSON.stringify({
        ...marker,
        workspaceId: marker.workspaceId ?? null,
        serverId: marker.serverId ?? null,
        serverUrl: marker.serverUrl ?? null,
        accessScope: marker.accessScope ?? null,
        shareToken: marker.shareToken ?? null,
        chatboxToken: marker.chatboxToken ?? null,
        returnHash: normalizeHostedOAuthReturnHash(marker.returnHash),
        startedAt: Date.now(),
      }),
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readHostedOAuthPendingMarker(): HostedOAuthPendingMarker | null {
  try {
    const raw = localStorage.getItem(HOSTED_OAUTH_PENDING_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<HostedOAuthPendingMarker> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed.surface !== "chatbox" &&
        parsed.surface !== "shared" &&
        parsed.surface !== "workspace") ||
      typeof parsed.serverName !== "string" ||
      typeof parsed.startedAt !== "number"
    ) {
      clearHostedOAuthPendingMarker();
      return null;
    }

    if (Date.now() - parsed.startedAt > HOSTED_OAUTH_PENDING_TTL_MS) {
      clearHostedOAuthPendingMarker();
      return null;
    }

    return {
      surface: parsed.surface,
      workspaceId:
        typeof parsed.workspaceId === "string" ? parsed.workspaceId : null,
      serverId: typeof parsed.serverId === "string" ? parsed.serverId : null,
      serverName: parsed.serverName,
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : null,
      accessScope:
        parsed.accessScope === "workspace_member" ||
        parsed.accessScope === "chat_v2"
          ? parsed.accessScope
          : undefined,
      shareToken:
        typeof parsed.shareToken === "string" ? parsed.shareToken : null,
      chatboxToken:
        typeof parsed.chatboxToken === "string" ? parsed.chatboxToken : null,
      returnHash: normalizeHostedOAuthReturnHash(parsed.returnHash),
      startedAt: parsed.startedAt,
    };
  } catch {
    clearHostedOAuthPendingMarker();
    return null;
  }
}

export function clearHostedOAuthPendingMarker(): void {
  localStorage.removeItem(HOSTED_OAUTH_PENDING_STORAGE_KEY);
}

export function clearHostedOAuthLegacyPendingKeys(): void {
  localStorage.removeItem(SHARED_OAUTH_PENDING_KEY);
  localStorage.removeItem(CHATBOX_OAUTH_PENDING_KEY);
}

export function clearHostedOAuthPendingState(): void {
  clearHostedOAuthPendingMarker();
  clearHostedOAuthLegacyPendingKeys();
}

function inferHostedOAuthSurfaceFromSessions(
  serverName: string,
  serverUrl: string | null,
): HostedOAuthSurface | null {
  const hasChatboxLegacyPending = !!localStorage.getItem(
    CHATBOX_OAUTH_PENDING_KEY,
  );
  const hasSharedLegacyPending = !!localStorage.getItem(
    SHARED_OAUTH_PENDING_KEY,
  );

  if (hasChatboxLegacyPending !== hasSharedLegacyPending) {
    return hasChatboxLegacyPending ? "chatbox" : "shared";
  }

  const chatboxSession = readChatboxSession();
  const sharedSession = readSharedServerSession();

  const chatboxMatch =
    chatboxSession?.payload.servers.some((server) =>
      matchesHostedOAuthServerIdentity(
        {
          serverName: server.serverName,
          serverUrl: server.serverUrl,
        },
        { serverName, serverUrl },
      ),
    ) ?? false;
  const sharedMatch =
    sharedSession != null
      ? matchesHostedOAuthServerIdentity(
          {
            serverName: sharedSession.payload.serverName,
            serverUrl: sharedSession.payload.serverUrl,
          },
          { serverName, serverUrl },
        )
      : false;

  if (chatboxMatch && !sharedMatch) {
    return "chatbox";
  }
  if (sharedMatch && !chatboxMatch) {
    return "shared";
  }

  if (chatboxSession && !sharedSession) {
    return "chatbox";
  }
  if (sharedSession && !chatboxSession) {
    return "shared";
  }

  return null;
}

export function getHostedOAuthCallbackContext(): HostedOAuthCallbackContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  const urlParams = new URLSearchParams(window.location.search);
  if (!urlParams.get("code") && !urlParams.get("error")) {
    return null;
  }

  const pendingMarker = readHostedOAuthPendingMarker();
  if (pendingMarker) {
    return pendingMarker;
  }

  const serverName = localStorage.getItem("mcp-oauth-pending")?.trim() ?? "";
  if (!serverName) {
    return null;
  }

  const serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
  const surface = inferHostedOAuthSurfaceFromSessions(serverName, serverUrl);
  if (!surface) {
    return null;
  }

  return {
    surface,
    workspaceId: null,
    serverId: null,
    serverName,
    serverUrl,
    accessScope: undefined,
    shareToken: null,
    chatboxToken: null,
    returnHash: normalizeHostedOAuthReturnHash(
      localStorage.getItem("mcp-oauth-return-hash"),
    ),
    startedAt: Date.now(),
  };
}

export function resolveHostedOAuthReturnHash(
  context: Pick<HostedOAuthCallbackContext, "surface" | "returnHash">,
): string {
  if (context.returnHash) {
    return context.returnHash;
  }

  if (context.surface === "chatbox") {
    const chatboxSession = readChatboxSession();
    return chatboxSession
      ? `#${slugify(chatboxSession.payload.name)}`
      : "#chatbox";
  }

  if (context.surface === "workspace") {
    return "#servers";
  }

  const sharedSession = readSharedServerSession();
  return sharedSession
    ? `#${slugify(sharedSession.payload.serverName)}`
    : "#shared";
}
