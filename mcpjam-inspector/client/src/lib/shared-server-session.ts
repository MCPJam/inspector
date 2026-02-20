export type SharedServerShareMode =
  | "any_signed_in_with_link"
  | "invited_only";

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
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
        useOAuth: typeof payload.useOAuth === "boolean" ? payload.useOAuth : false,
        serverUrl: typeof payload.serverUrl === "string" ? payload.serverUrl : null,
        clientId: typeof payload.clientId === "string" ? payload.clientId : null,
        oauthScopes: Array.isArray(payload.oauthScopes) ? payload.oauthScopes : null,
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
