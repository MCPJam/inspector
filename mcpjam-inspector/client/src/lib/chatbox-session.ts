import { getShareableAppOrigin, slugify } from "@/lib/shared-server-session";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";

export type ChatboxShareMode = "any_signed_in_with_link" | "invited_only";

export interface ChatboxBootstrapServer {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
  /** When true, excluded from initial OAuth and chat until enabled by the tester. */
  optional?: boolean;
}

export interface ChatboxWelcomeDialogPayload {
  enabled: boolean;
  body?: string;
}

export interface ChatboxBootstrapPayload {
  workspaceId: string;
  chatboxId: string;
  name: string;
  description?: string;
  hostStyle: ChatboxHostStyle;
  mode: ChatboxShareMode;
  allowGuestAccess: boolean;
  viewerIsWorkspaceMember: boolean;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  servers: ChatboxBootstrapServer[];
  /** When set by bootstrap or playground snapshot, drives hosted welcome copy. */
  welcomeDialog?: ChatboxWelcomeDialogPayload | null;
}

export interface ChatboxSession {
  token: string;
  payload: ChatboxBootstrapPayload;
  surface?: "preview" | "share_link";
}

export const CHATBOX_SESSION_STORAGE_KEY = "mcpjam_chatbox_session_v1";
export const CHATBOX_OAUTH_PENDING_KEY = "mcp-oauth-chatbox-pending";
export const CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_chatbox_signin_return_path_v1";
export const CHATBOX_PLAYGROUND_KEY_PREFIX =
  "mcpjam_chatbox_playground_session_v1:";

/** sessionStorage: optional servers the tester enabled for this share-link session. */
export function chatboxEnabledOptionalStorageKey(chatboxToken: string): string {
  return `chatbox-enabled-optional:${chatboxToken}`;
}

/** sessionStorage: optional servers enabled in builder preview for a chatbox id. */
export function chatboxPreviewEnabledOptionalStorageKey(
  chatboxId: string,
): string {
  return `chatbox-preview-opt-in:${chatboxId}`;
}

const PLAYGROUND_TTL_MS = 24 * 60 * 60 * 1000;

export interface ChatboxPlaygroundSession extends ChatboxSession {
  playgroundId: string;
  updatedAt: number;
}

function normalizeChatboxShareMode(mode: unknown): ChatboxShareMode {
  if (
    mode === "any_signed_in_with_link" ||
    mode === "workspace_with_link" ||
    mode === "anyone_with_link"
  ) {
    return "any_signed_in_with_link";
  }

  return "invited_only";
}

export function extractChatboxTokenFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/chatbox\/[^/?#]+\/([^/?#]+)/);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

export function hasActiveChatboxSession(): boolean {
  return readChatboxSession() !== null;
}

function normalizeChatboxSession(
  parsed: Partial<ChatboxSession> | null,
): ChatboxSession | null {
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
    typeof payload.chatboxId !== "string" ||
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
      chatboxId: payload.chatboxId,
      name: payload.name,
      description:
        typeof payload.description === "string"
          ? payload.description
          : undefined,
      hostStyle,
      mode: normalizeChatboxShareMode(payload.mode),
      allowGuestAccess: payload.allowGuestAccess,
      viewerIsWorkspaceMember: payload.viewerIsWorkspaceMember,
      systemPrompt: payload.systemPrompt,
      modelId: payload.modelId,
      temperature: payload.temperature,
      requireToolApproval: payload.requireToolApproval,
      servers: payload.servers
        .filter(
          (server): server is ChatboxBootstrapServer =>
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
          optional: Boolean(server.optional),
        })),
      welcomeDialog:
        payload.welcomeDialog &&
        typeof payload.welcomeDialog === "object" &&
        typeof payload.welcomeDialog.enabled === "boolean"
          ? {
              enabled: payload.welcomeDialog.enabled,
              body:
                typeof payload.welcomeDialog.body === "string"
                  ? payload.welcomeDialog.body
                  : "",
            }
          : undefined,
    },
    surface: parsed.surface === "preview" ? "preview" : "share_link",
  };
}

function readStoredChatboxSession(storageKey: string): ChatboxSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;

    return normalizeChatboxSession(
      JSON.parse(raw) as Partial<ChatboxSession> | null,
    );
  } catch {
    return null;
  }
}

export function readChatboxSession(): ChatboxSession | null {
  return readStoredChatboxSession(CHATBOX_SESSION_STORAGE_KEY);
}

function writeStoredChatboxSession(
  storageKey: string,
  session: ChatboxSession,
): void {
  sessionStorage.setItem(storageKey, JSON.stringify(session));
}

export function writeChatboxSession(session: ChatboxSession): void {
  writeStoredChatboxSession(CHATBOX_SESSION_STORAGE_KEY, session);
}

export function readChatboxSurfaceFromUrl(
  search: string,
): "preview" | "share_link" {
  try {
    const surface = new URLSearchParams(search).get("surface");
    return surface === "preview" ? "preview" : "share_link";
  } catch {
    return "share_link";
  }
}

export function clearChatboxSession(): void {
  sessionStorage.removeItem(CHATBOX_SESSION_STORAGE_KEY);
}

function pruneExpiredPlaygroundSessions(): void {
  try {
    const now = Date.now();
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(CHATBOX_PLAYGROUND_KEY_PREFIX)) {
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
  session: ChatboxPlaygroundSession,
): void {
  try {
    localStorage.setItem(
      `${CHATBOX_PLAYGROUND_KEY_PREFIX}${session.playgroundId}`,
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
): ChatboxPlaygroundSession | null {
  try {
    const storageKey = `${CHATBOX_PLAYGROUND_KEY_PREFIX}${playgroundId}`;
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<ChatboxPlaygroundSession> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.updatedAt !== "number" ||
      Date.now() - parsed.updatedAt > PLAYGROUND_TTL_MS
    ) {
      localStorage.removeItem(storageKey);
      return null;
    }

    const normalized = normalizeChatboxSession(parsed);
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
    localStorage.removeItem(`${CHATBOX_PLAYGROUND_KEY_PREFIX}${playgroundId}`);
  } catch {
    // Ignore storage failures.
  }
}

export function writeChatboxSignInReturnPath(path: string): void {
  const normalizedPath = path.trim();
  if (!extractChatboxTokenFromPath(normalizedPath)) {
    return;
  }

  try {
    localStorage.setItem(
      CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      normalizedPath,
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readChatboxSignInReturnPath(): string | null {
  try {
    const raw = localStorage.getItem(CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY);
    if (!raw) return null;
    const normalizedPath = raw.trim();
    if (!normalizedPath || !extractChatboxTokenFromPath(normalizedPath)) {
      return null;
    }
    return normalizedPath;
  } catch {
    return null;
  }
}

export function clearChatboxSignInReturnPath(): void {
  localStorage.removeItem(CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY);
}

export function buildChatboxLink(token: string, chatboxName: string): string {
  const origin = getShareableAppOrigin();
  return `${origin}/chatbox/${slugify(chatboxName)}/${encodeURIComponent(token)}`;
}

export function buildPlaygroundChatboxLink(
  token: string,
  chatboxName: string,
  playgroundId: string,
): string {
  const url = new URL(buildChatboxLink(token, chatboxName));
  url.searchParams.set("playground", "1");
  url.searchParams.set("surface", "preview");
  url.searchParams.set("playgroundId", playgroundId);
  return url.toString();
}

// --- Builder session (survives OAuth redirect) ---

const BUILDER_SESSION_KEY = "mcpjam_chatbox_builder_session_v1";

export interface ChatboxBuilderSession {
  workspaceId: string;
  chatboxId: string | null;
  draft: Record<string, unknown> | null;
  viewMode: string;
}

export function readBuilderSession(
  workspaceId: string,
): ChatboxBuilderSession | null {
  try {
    const raw = sessionStorage.getItem(BUILDER_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatboxBuilderSession;
    if (parsed.workspaceId !== workspaceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeBuilderSession(session: ChatboxBuilderSession): void {
  sessionStorage.setItem(BUILDER_SESSION_KEY, JSON.stringify(session));
}

export function clearBuilderSession(): void {
  sessionStorage.removeItem(BUILDER_SESSION_KEY);
}
