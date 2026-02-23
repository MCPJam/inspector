export type SharedServerShareMode = "any_signed_in_with_link" | "invited_only";

export interface SharedServerBootstrapPayload {
  workspaceId: string;
  serverId: string;
  serverName: string;
  mode: SharedServerShareMode;
  viewerIsWorkspaceMember: boolean;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
}

export interface SharedServerSession {
  token: string;
  payload: SharedServerBootstrapPayload;
}

export const SHARED_SERVER_SESSION_STORAGE_KEY =
  "mcpjam_shared_server_session_v1";

export const SHARED_OAUTH_PENDING_KEY = "mcp-oauth-shared-chat-pending";
export const SHARED_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_shared_signin_return_path_v1";

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "server";
}

export function extractSharedTokenFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/shared\/[^/?#]+\/([^/?#]+)/);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

export function hasActiveSharedSession(): boolean {
  return readSharedServerSession() !== null;
}

export function readSharedServerSession(): SharedServerSession | null {
  try {
    const raw = sessionStorage.getItem(SHARED_SERVER_SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SharedServerSession> | null;
    if (!parsed || typeof parsed !== "object") return null;

    const token =
      typeof parsed.token === "string" ? parsed.token.trim() : undefined;
    const payload = parsed.payload;

    if (
      !token ||
      !payload ||
      typeof payload.workspaceId !== "string" ||
      typeof payload.serverId !== "string" ||
      typeof payload.serverName !== "string" ||
      (payload.mode !== "any_signed_in_with_link" &&
        payload.mode !== "invited_only") ||
      typeof payload.viewerIsWorkspaceMember !== "boolean"
    ) {
      return null;
    }

    return {
      token,
      payload: {
        workspaceId: payload.workspaceId,
        serverId: payload.serverId,
        serverName: payload.serverName,
        mode: payload.mode,
        viewerIsWorkspaceMember: payload.viewerIsWorkspaceMember,
        useOAuth:
          typeof payload.useOAuth === "boolean" ? payload.useOAuth : false,
        serverUrl:
          typeof payload.serverUrl === "string" ? payload.serverUrl : null,
        clientId:
          typeof payload.clientId === "string" ? payload.clientId : null,
        oauthScopes: Array.isArray(payload.oauthScopes)
          ? payload.oauthScopes
          : null,
      },
    };
  } catch {
    return null;
  }
}

export function writeSharedServerSession(session: SharedServerSession): void {
  sessionStorage.setItem(
    SHARED_SERVER_SESSION_STORAGE_KEY,
    JSON.stringify(session),
  );
}

export function clearSharedServerSession(): void {
  sessionStorage.removeItem(SHARED_SERVER_SESSION_STORAGE_KEY);
}

export function writeSharedSignInReturnPath(path: string): void {
  const normalizedPath = path.trim();
  if (!extractSharedTokenFromPath(normalizedPath)) {
    return;
  }

  try {
    localStorage.setItem(
      SHARED_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      normalizedPath,
    );
  } catch {
    // Ignore storage failures (private mode, disabled storage, etc).
  }
}

export function readSharedSignInReturnPath(): string | null {
  try {
    const raw = localStorage.getItem(SHARED_SIGN_IN_RETURN_PATH_STORAGE_KEY);
    if (!raw) return null;

    const normalizedPath = raw.trim();
    if (!normalizedPath) return null;
    if (!extractSharedTokenFromPath(normalizedPath)) return null;

    return normalizedPath;
  } catch {
    return null;
  }
}

export function clearSharedSignInReturnPath(): void {
  localStorage.removeItem(SHARED_SIGN_IN_RETURN_PATH_STORAGE_KEY);
}

// --- Pending server add (localStorage handoff from shared chat → main app) ---

export const PENDING_SERVER_ADD_KEY = "mcpjam_pending_server_add_v1";

const PENDING_SERVER_ADD_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingServerAdd {
  serverName: string;
  serverUrl: string;
  useOAuth: boolean;
  clientId: string | null;
  oauthScopes: string[] | null;
  createdAt: number;
}

export function writePendingServerAdd(
  data: Omit<PendingServerAdd, "createdAt">,
): void {
  try {
    localStorage.setItem(
      PENDING_SERVER_ADD_KEY,
      JSON.stringify({ ...data, createdAt: Date.now() }),
    );
  } catch {
    // Ignore storage failures (private mode, disabled storage, etc).
  }
}

export function readPendingServerAdd(): PendingServerAdd | null {
  try {
    const raw = localStorage.getItem(PENDING_SERVER_ADD_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PendingServerAdd> | null;
    if (!parsed || typeof parsed !== "object") return null;

    if (
      typeof parsed.serverName !== "string" ||
      typeof parsed.serverUrl !== "string" ||
      typeof parsed.useOAuth !== "boolean" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }

    if (Date.now() - parsed.createdAt > PENDING_SERVER_ADD_TTL_MS) {
      localStorage.removeItem(PENDING_SERVER_ADD_KEY);
      return null;
    }

    return {
      serverName: parsed.serverName,
      serverUrl: parsed.serverUrl,
      useOAuth: parsed.useOAuth,
      clientId: typeof parsed.clientId === "string" ? parsed.clientId : null,
      oauthScopes: Array.isArray(parsed.oauthScopes)
        ? parsed.oauthScopes
        : null,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function clearPendingServerAdd(): void {
  localStorage.removeItem(PENDING_SERVER_ADD_KEY);
}
