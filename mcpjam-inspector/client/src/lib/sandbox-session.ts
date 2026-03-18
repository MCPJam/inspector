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
  surface?: "internal" | "share_link";
}

export const SANDBOX_SESSION_STORAGE_KEY = "mcpjam_sandbox_session_v1";
export const SANDBOX_OAUTH_PENDING_KEY = "mcp-oauth-sandbox-pending";
export const SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_sandbox_signin_return_path_v1";
export const SANDBOX_PLAYGROUND_KEY_PREFIX =
  "mcpjam_sandbox_playground_session_v1:";

const PLAYGROUND_TTL_MS = 24 * 60 * 60 * 1000;

export interface SandboxPlaygroundSession extends SandboxSession {
  playgroundId: string;
  updatedAt: number;
}

function normalizeSandboxShareMode(mode: unknown): SandboxShareMode {
  if (
    mode === "any_signed_in_with_link" ||
    mode === "workspace_with_link" ||
    mode === "anyone_with_link"
  ) {
    return "any_signed_in_with_link";
  }

  return "invited_only";
}

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

function normalizeSandboxSession(
  parsed: Partial<SandboxSession> | null,
): SandboxSession | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
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
      mode: normalizeSandboxShareMode(payload.mode),
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
    surface: parsed.surface === "internal" ? "internal" : "share_link",
  };
}

function readStoredSandboxSession(storageKey: string): SandboxSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;

    return normalizeSandboxSession(
      JSON.parse(raw) as Partial<SandboxSession> | null,
    );
  } catch {
    return null;
  }
}

export function readSandboxSession(): SandboxSession | null {
  return readStoredSandboxSession(SANDBOX_SESSION_STORAGE_KEY);
}

function writeStoredSandboxSession(
  storageKey: string,
  session: SandboxSession,
): void {
  sessionStorage.setItem(storageKey, JSON.stringify(session));
}

export function writeSandboxSession(session: SandboxSession): void {
  writeStoredSandboxSession(SANDBOX_SESSION_STORAGE_KEY, session);
}

export function readSandboxSurfaceFromUrl(
  search: string,
): "internal" | "share_link" {
  try {
    const surface = new URLSearchParams(search).get("surface");
    return surface === "internal" ? "internal" : "share_link";
  } catch {
    return "share_link";
  }
}

export function clearSandboxSession(): void {
  sessionStorage.removeItem(SANDBOX_SESSION_STORAGE_KEY);
}

function pruneExpiredPlaygroundSessions(): void {
  try {
    const now = Date.now();
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(SANDBOX_PLAYGROUND_KEY_PREFIX)) {
        continue;
      }

      try {
        const raw = localStorage.getItem(key);
        if (!raw) {
          continue;
        }

        const parsed = JSON.parse(raw) as { updatedAt?: number };
        if (
          typeof parsed.updatedAt !== "number" ||
          now - parsed.updatedAt > PLAYGROUND_TTL_MS
        ) {
          localStorage.removeItem(key);
        }
      } catch {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore storage access failures.
  }
}

export function writePlaygroundSession(
  session: SandboxPlaygroundSession,
): void {
  try {
    localStorage.setItem(
      `${SANDBOX_PLAYGROUND_KEY_PREFIX}${session.playgroundId}`,
      JSON.stringify({
        ...session,
        updatedAt: Date.now(),
      }),
    );
    pruneExpiredPlaygroundSessions();
  } catch {
    // Ignore storage failures.
  }
}

export function readPlaygroundSession(
  playgroundId: string,
): SandboxPlaygroundSession | null {
  try {
    const storageKey = `${SANDBOX_PLAYGROUND_KEY_PREFIX}${playgroundId}`;
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<SandboxPlaygroundSession> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.updatedAt !== "number" ||
      Date.now() - parsed.updatedAt > PLAYGROUND_TTL_MS
    ) {
      localStorage.removeItem(storageKey);
      return null;
    }

    const normalized = normalizeSandboxSession(parsed);
    if (!normalized) {
      return null;
    }

    pruneExpiredPlaygroundSessions();

    return {
      ...normalized,
      playgroundId:
        typeof parsed.playgroundId === "string"
          ? parsed.playgroundId
          : playgroundId,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function clearPlaygroundSession(playgroundId: string): void {
  try {
    localStorage.removeItem(`${SANDBOX_PLAYGROUND_KEY_PREFIX}${playgroundId}`);
  } catch {
    // Ignore storage failures.
  }
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

export function buildPlaygroundSandboxLink(
  token: string,
  sandboxName: string,
  playgroundId: string,
): string {
  const url = new URL(buildSandboxLink(token, sandboxName));
  url.searchParams.set("playground", "1");
  url.searchParams.set("surface", "internal");
  url.searchParams.set("playgroundId", playgroundId);
  return url.toString();
}
