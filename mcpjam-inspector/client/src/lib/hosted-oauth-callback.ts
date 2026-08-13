import {
  isHostedOAuthSurface,
  type HostedOAuthSurface,
} from "@/lib/hosted-oauth-resume";
import {
  readChatboxSession,
  CHATBOX_OAUTH_PENDING_KEY,
  slugify,
} from "@/lib/chatbox-session";
import {
  legacyHashBookmarkToPath,
  normalizeReturnTargetPath,
  routePaths,
} from "@/lib/app-navigation";

export interface HostedOAuthPendingMarker {
  surface: HostedOAuthSurface;
  organizationId?: string | null;
  projectId?: string | null;
  serverId?: string | null;
  serverName: string;
  serverUrl: string | null;
  sessionId?: string | null;
  accessScope?: "project_member" | "chat_v2";
  chatboxId?: string | null;
  returnPath: string | null;
  startedAt: number;
}

export interface HostedOAuthCallbackContext extends HostedOAuthPendingMarker {}

export const HOSTED_OAUTH_PENDING_STORAGE_KEY = "mcp-hosted-oauth-pending";

/**
 * The score surface's "an authorization is in flight" sentinel.
 *
 * It MUST be a different key from `HOSTED_OAUTH_PENDING_STORAGE_KEY`: the gate
 * writes the structured marker to that key and then writes the literal string
 * `"true"` to whichever `pendingKey` its caller named. Passing the marker's own
 * key overwrites the marker with `"true"`, `readHostedOAuthPendingMarker` then
 * fails to parse it as an object, clears it, and the whole callback round trip
 * silently dead-ends. Chatbox has always used its own sentinel for the same
 * reason; score needs one too.
 */
export const SCORE_OAUTH_PENDING_KEY = "mcp-oauth-score-pending";

const HOSTED_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export function normalizeHostedOAuthServerName(
  serverName?: string | null
): string {
  return serverName?.trim().toLowerCase() ?? "";
}

function normalizeHostedOAuthReturnPath(
  returnTarget?: string | null,
  surface?: HostedOAuthSurface
): string | null {
  const trimmed = returnTarget?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("#")) {
    const legacyPath = legacyHashBookmarkToPath(trimmed);
    if (legacyPath) return legacyPath;
    if (surface === "chatbox") {
      const fragment = trimmed.replace(/^#\/?/, "");
      return fragment ? `/${fragment}` : null;
    }
  }

  if (
    surface === "chatbox" &&
    trimmed.startsWith("/") &&
    !trimmed.startsWith("//")
  ) {
    return trimmed;
  }

  // score.mcpjam.com lives at `/embed/score`, which is not an app-tab segment,
  // so `normalizeReturnTargetPath` would rewrite it to `/servers` and strand
  // the visitor in an app they never asked for — losing the run they had
  // started. Same carve-out as chatbox, and just as narrow: a same-origin
  // absolute path only, never a protocol-relative `//host` that would leave
  // the origin entirely.
  if (
    surface === "score" &&
    trimmed.startsWith("/") &&
    !trimmed.startsWith("//")
  ) {
    return trimmed;
  }

  return normalizeReturnTargetPath(trimmed);
}

export function matchesHostedOAuthServerIdentity(
  left: {
    serverName?: string | null;
    serverUrl?: string | null;
  },
  right: {
    serverName?: string | null;
    serverUrl?: string | null;
  }
): boolean {
  if (left.serverUrl && right.serverUrl && left.serverUrl === right.serverUrl) {
    return true;
  }

  const leftName = normalizeHostedOAuthServerName(left.serverName);
  const rightName = normalizeHostedOAuthServerName(right.serverName);
  return !!leftName && !!rightName && leftName === rightName;
}

export function writeHostedOAuthPendingMarker(
  marker: Omit<HostedOAuthPendingMarker, "startedAt">
): void {
  try {
    localStorage.setItem(
      HOSTED_OAUTH_PENDING_STORAGE_KEY,
      JSON.stringify({
        ...marker,
        organizationId: marker.organizationId ?? null,
        projectId: marker.projectId ?? null,
        serverId: marker.serverId ?? null,
        serverUrl: marker.serverUrl ?? null,
        sessionId: marker.sessionId ?? null,
        accessScope: marker.accessScope ?? null,
        chatboxId: marker.chatboxId ?? null,
        returnPath: normalizeHostedOAuthReturnPath(
          marker.returnPath,
          marker.surface
        ),
        startedAt: Date.now(),
      })
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readHostedOAuthPendingMarker(): HostedOAuthPendingMarker | null {
  try {
    const raw = localStorage.getItem(HOSTED_OAUTH_PENDING_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as
      | (Partial<HostedOAuthPendingMarker> & { returnHash?: unknown })
      | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !isHostedOAuthSurface(parsed.surface) ||
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
      organizationId:
        typeof parsed.organizationId === "string"
          ? parsed.organizationId
          : null,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
      serverId: typeof parsed.serverId === "string" ? parsed.serverId : null,
      serverName: parsed.serverName,
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : null,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      accessScope:
        parsed.accessScope === "project_member" ||
        parsed.accessScope === "chat_v2"
          ? parsed.accessScope
          : undefined,
      chatboxId: typeof parsed.chatboxId === "string" ? parsed.chatboxId : null,
      returnPath: normalizeHostedOAuthReturnPath(
        typeof parsed.returnPath === "string"
          ? parsed.returnPath
          : typeof parsed.returnHash === "string"
          ? parsed.returnHash
          : null,
        parsed.surface
      ),
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
  localStorage.removeItem(CHATBOX_OAUTH_PENDING_KEY);
  localStorage.removeItem(SCORE_OAUTH_PENDING_KEY);
}

export function clearHostedOAuthPendingState(): void {
  clearHostedOAuthPendingMarker();
  clearHostedOAuthLegacyPendingKeys();
}

function inferHostedOAuthSurfaceFromSessions(
  serverName: string,
  serverUrl: string | null
): HostedOAuthSurface | null {
  const hasChatboxLegacyPending = !!localStorage.getItem(
    CHATBOX_OAUTH_PENDING_KEY
  );
  if (hasChatboxLegacyPending) {
    return "chatbox";
  }

  const chatboxSession = readChatboxSession();
  if (!chatboxSession) {
    return null;
  }

  const chatboxMatch = chatboxSession.payload.servers.some((server) =>
    matchesHostedOAuthServerIdentity(
      {
        serverName: server.serverName,
        serverUrl: server.serverUrl,
      },
      { serverName, serverUrl }
    )
  );

  return chatboxMatch ? "chatbox" : null;
}

export function getHostedOAuthCallbackContext(): HostedOAuthCallbackContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  // Scope MCP-OAuth callback detection to /oauth/callback (the MCP redirect_uri
  // from getRedirectUri()). WorkOS sign-in lands on /callback?code=… which
  // would otherwise be misread here and pair with a stale mcp-oauth-pending
  // marker, producing a ghost "Finishing OAuth…" gate after sign-in.
  const pathname = window.location.pathname;
  if (
    pathname !== "/oauth/callback" &&
    !pathname.startsWith("/oauth/callback/")
  ) {
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

  const serverName = // Mirrors OAUTH_PENDING_STORAGE_KEY in lib/oauth/mcp-oauth.ts; the
    // literal avoids a module edge here and is pinned by
    // lib/oauth/__tests__/oauth-callback-recovery.test.ts.
    localStorage.getItem("mcp-oauth-pending")?.trim() ?? "";
  if (!serverName) {
    return null;
  }

  const serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
  const surface = inferHostedOAuthSurfaceFromSessions(serverName, serverUrl);
  if (!surface) {
    return null;
  }

  // Storage key name is retained for in-flight migration compatibility; new
  // values are normalized path targets, not hash routes.
  const storedReturnTarget = localStorage.getItem("mcp-oauth-return-hash");

  return {
    surface,
    organizationId: null,
    projectId: null,
    serverId: null,
    serverName,
    serverUrl,
    sessionId: null,
    accessScope: undefined,
    chatboxId: null,
    returnPath: normalizeHostedOAuthReturnPath(storedReturnTarget, surface),
    startedAt: Date.now(),
  };
}

export function resolveHostedOAuthReturnPath(
  context: Pick<HostedOAuthCallbackContext, "surface" | "returnPath">
): string {
  if (context.returnPath) {
    return (
      normalizeHostedOAuthReturnPath(context.returnPath, context.surface) ??
      routePaths.servers
    );
  }

  if (context.surface === "chatbox") {
    const chatboxSession = readChatboxSession();
    // No session to return to: land on the User Testing surface rather than a
    // code name the visitor would read in their address bar.
    return chatboxSession
      ? `/${slugify(chatboxSession.payload.name)}`
      : routePaths.userTesting;
  }

  // A score visitor never asked to see the app. If the return path went
  // missing, send them back to the runner rather than to `/servers`, which
  // would drop them into a product they have not signed into.
  if (context.surface === "score") {
    return routePaths.embedScore;
  }

  return routePaths.servers;
}
