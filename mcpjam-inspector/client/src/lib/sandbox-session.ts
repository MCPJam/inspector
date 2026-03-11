import { getShareableAppOrigin, slugify } from "@/lib/shared-server-session";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";

export type SandboxShareMode = "any_signed_in_with_link" | "invited_only";

export interface SandboxBootstrapServer {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
}

export interface SandboxBootstrapPayload {
  workspaceId: string;
  sandboxId: string;
  name: string;
  description?: string;
  hostStyle: SandboxHostStyle;
  mode: SandboxShareMode;
  allowGuestAccess: boolean;
  viewerIsWorkspaceMember: boolean;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  servers: SandboxBootstrapServer[];
}

export interface SandboxSession {
  token: string;
  payload: SandboxBootstrapPayload;
}

export const SANDBOX_SESSION_STORAGE_KEY = "mcpjam_sandbox_session_v1";
export const SANDBOX_OAUTH_PENDING_KEY = "mcp-oauth-sandbox-pending";
export const SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_sandbox_signin_return_path_v1";

export function extractSandboxTokenFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/sandbox\/[^/?#]+\/([^/?#]+)/);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

export function hasActiveSandboxSession(): boolean {
  return readSandboxSession() !== null;
}

export function readSandboxSession(): SandboxSession | null {
  try {
    const raw = sessionStorage.getItem(SANDBOX_SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SandboxSession> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const token =
      typeof parsed.token === "string" ? parsed.token.trim() : undefined;
    const payload = parsed.payload;
    const hostStyle =
      payload?.hostStyle === "claude" || payload?.hostStyle === "chatgpt"
        ? payload.hostStyle
        : payload?.hostStyle == null
          ? "claude"
          : null;

    if (
      !token ||
      !payload ||
      typeof payload.workspaceId !== "string" ||
      typeof payload.sandboxId !== "string" ||
      typeof payload.name !== "string" ||
      hostStyle === null ||
      typeof payload.modelId !== "string" ||
      typeof payload.systemPrompt !== "string" ||
      typeof payload.temperature !== "number" ||
      typeof payload.requireToolApproval !== "boolean" ||
      typeof payload.allowGuestAccess !== "boolean" ||
      typeof payload.viewerIsWorkspaceMember !== "boolean" ||
      !Array.isArray(payload.servers)
    ) {
      return null;
    }

    return {
      token,
      payload: {
        workspaceId: payload.workspaceId,
        sandboxId: payload.sandboxId,
        name: payload.name,
        description:
          typeof payload.description === "string"
            ? payload.description
            : undefined,
        hostStyle,
        mode:
          payload.mode === "any_signed_in_with_link"
            ? payload.mode
            : "invited_only",
        allowGuestAccess: payload.allowGuestAccess,
        viewerIsWorkspaceMember: payload.viewerIsWorkspaceMember,
        systemPrompt: payload.systemPrompt,
        modelId: payload.modelId,
        temperature: payload.temperature,
        requireToolApproval: payload.requireToolApproval,
        servers: payload.servers
          .filter(
            (server): server is SandboxBootstrapServer =>
              !!server &&
              typeof server === "object" &&
              typeof server.serverId === "string" &&
              typeof server.serverName === "string",
          )
          .map((server) => ({
            serverId: server.serverId,
            serverName: server.serverName,
            useOAuth: Boolean(server.useOAuth),
            serverUrl:
              typeof server.serverUrl === "string" ? server.serverUrl : null,
            clientId:
              typeof server.clientId === "string" ? server.clientId : null,
            oauthScopes: Array.isArray(server.oauthScopes)
              ? server.oauthScopes
              : null,
          })),
      },
    };
  } catch {
    return null;
  }
}

export function writeSandboxSession(session: SandboxSession): void {
  sessionStorage.setItem(SANDBOX_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSandboxSession(): void {
  sessionStorage.removeItem(SANDBOX_SESSION_STORAGE_KEY);
}

export function writeSandboxSignInReturnPath(path: string): void {
  const normalizedPath = path.trim();
  if (!extractSandboxTokenFromPath(normalizedPath)) {
    return;
  }

  try {
    localStorage.setItem(
      SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      normalizedPath,
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readSandboxSignInReturnPath(): string | null {
  try {
    const raw = localStorage.getItem(SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY);
    if (!raw) return null;
    const normalizedPath = raw.trim();
    if (!normalizedPath || !extractSandboxTokenFromPath(normalizedPath)) {
      return null;
    }
    return normalizedPath;
  } catch {
    return null;
  }
}

export function clearSandboxSignInReturnPath(): void {
  localStorage.removeItem(SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY);
}

export function buildSandboxLink(token: string, sandboxName: string): string {
  const origin = getShareableAppOrigin();
  return `${origin}/sandbox/${slugify(sandboxName)}/${encodeURIComponent(token)}`;
}
