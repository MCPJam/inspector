import {
  normalizeChatboxHostStyleId,
  type ChatboxHostStyle,
} from "@/lib/chatbox-client-style";
import type {
  HostConfigMcpProfileV1,
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@/lib/client-config-v2";
import { DEFAULT_HOST_STYLE, type ChatUiOverride } from "@/lib/client-styles";
import {
  extractTesterLinkToken,
  TESTER_LINK_PATH_SEGMENT,
} from "@/lib/tester-link-path";
import type { ChatboxPerTurnFeedbackStyle } from "@/types/chatUi";

const MCPJAM_APP_ORIGIN = "https://app.mcpjam.com";

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

export function getShareableAppOrigin(): string {
  if (typeof window === "undefined") {
    return MCPJAM_APP_ORIGIN;
  }

  return window.location.protocol === "http:" ||
    window.location.protocol === "https:"
    ? window.location.origin
    : MCPJAM_APP_ORIGIN;
}

/**
 * Chatbox access modes. Mirrors the backend `chatboxModeValidator`.
 */
export type ChatboxShareMode =
  | "project_members"
  | "invited_only"
  | "anyone_with_link";

export interface ChatboxBootstrapServer {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
  oauthProtocolMode?: string | null;
  oauthProtocolVersion?: string | null;
  /** Effective host/per-server MCP wire pin, when one is configured. */
  wireProtocolVersion?: string | null;
  /**
   * Per-server OAuth facts the shared request builder consumes. Optional
   * because an older bootstrap payload does not send them; when it does, the
   * hosted authorization honors them instead of quietly building a different
   * request than a local connect would.
   */
  oauthResourceUrl?: string | null;
  hasClientSecret?: boolean | null;
  oauthCustomHeaders?: Record<string, string> | null;
  oauthAllowPathScopedIssuer?: boolean | null;
  registrationMode?: string | null;
  /** When true, excluded from initial OAuth and chat until enabled by the tester. */
  optional?: boolean;
}

export interface ChatboxWelcomeDialogPayload {
  enabled: boolean;
  body?: string;
}

/**
 * Per-turn ratings config. Absent or `enabled: false` ⇒ the widget renders
 * nothing, which is what lets the UI ship before any scenario turns it on.
 */
export interface ChatboxPerTurnFeedbackPayload {
  enabled: boolean;
  /**
   * Which widget to render, and therefore which score key the tester writes
   * under. Absent ⇒ `stars`, the only style that existed before this field.
   *
   * Aliased from the settings type rather than restated, so the bootstrap
   * payload and the scenario config cannot drift apart on what a style is.
   */
  style?: ChatboxPerTurnFeedbackStyle;
  prompt?: string;
  commentPlaceholder?: string;
  thanksMessage?: string;
}

export interface ChatUiPayload {
  surfaces?: {
    welcome?: ChatboxWelcomeDialogPayload | null;
    perTurnFeedback?: ChatboxPerTurnFeedbackPayload | null;
  } | null;
}

export interface ChatboxBootstrapPayload {
  projectId: string;
  chatboxId: string;
  name: string;
  description?: string;
  hostStyle: ChatboxHostStyle;
  mode: ChatboxShareMode;
  allowGuestAccess: boolean;
  viewerIsProjectMember: boolean;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  servers: ChatboxBootstrapServer[];
  /** When set by bootstrap or playground snapshot, drives hosted welcome copy. */
  chatUi?: ChatUiPayload | null;
  /**
   * User override for the MCP Apps `hostCapabilities` blob (see
   * HostConfigInputV2.hostCapabilitiesOverride). When undefined the hosted
   * runtime falls back to the active `hostStyle`'s preset.
   */
  hostCapabilitiesOverride?: Record<string, unknown>;
  /**
   * User override for the chat-UI chrome (logo, palette, indicator, fonts).
   * Mirrors `HostConfigInputV2.chatUiOverride`. When undefined the hosted
   * runtime renders the active `hostStyle`'s preset chrome verbatim.
   * Snapshotted at chatbox creation time — see comment on `hostStyle`
   * for snapshot semantics.
   */
  chatUiOverride?: ChatUiOverride;
  /**
   * Versioned envelope for host-level MCP state — see
   * `HostConfigMcpProfileV1` in `client/src/lib/host-config-v2.ts`.
   * When undefined the hosted runtime falls back to SDK-default
   * `clientInfo` / `supportedProtocolVersions` and the resource-declared
   * sandbox policy. The backend canonicalizer guarantees a non-undefined
   * value here is a valid `{ profileVersion: 1, ... }` envelope.
   */
  mcpProfile?: HostConfigMcpProfileV1;
}

export interface ChatboxSession {
  /**
   * Resolved chatbox identity. Returned by /api/web/chatboxes/redeem and
   * stored at the top level so callers don't have to dig through
   * `payload`. Every chatbox-aware backend call keys on this; the URL
   * link token is consumed only at redemption time and is not persisted.
   */
  chatboxId: string;
  /**
   * Backend-owned monotonic counter returned by /web/chatbox/redeem.
   * Bumps whenever access changes (mode, revoke-all, allowlist edits,
   * invite removal). Threaded into every chatbox-aware server call so
   * inspector caches invalidate cleanly.
   */
  accessVersion: number;
  payload: ChatboxBootstrapPayload;
  surface?: "preview" | "share_link";
  /**
   * Original URL share token captured at redeem time. Persisted so the
   * hosted Copy link button can reconstruct the canonical share URL after
   * the redeem flow rewrites the address bar to `/#<slug>`. UI-only — no
   * backend call should key on this; access is gated by `accessVersion`.
   */
  shareToken?: string;
}

// Bumped from v1 → v2: ChatboxSession dropped the URL token and added
// required top-level `chatboxId` + `accessVersion`. Reading a v1 row would
// produce a malformed session; rev the key so the v1 row is ignored and
// the next landing-page mount re-redeems cleanly.
export const CHATBOX_SESSION_STORAGE_KEY = "mcpjam_chatbox_session_v2";
export const CHATBOX_OAUTH_PENDING_KEY = "mcp-oauth-chatbox-pending";
export const CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_chatbox_signin_return_path_v1";

/** sessionStorage: optional servers the tester enabled for this chatbox session. */
export function chatboxEnabledOptionalStorageKey(chatboxId: string): string {
  return `chatbox-enabled-optional:${chatboxId}`;
}

// Defensive normalizer for the chatUi envelope in /web/chatbox/redeem
// responses. Returns `undefined` when no recognized surface is present. The
// hosted runtime consumes `welcome` and `perTurnFeedback`; the deprecated
// session-level `feedback` dialog is dropped on purpose (its write path is
// gone — see the backend's `sessionScores` design note).
/** A plain object whose every value is a string — the shape of custom headers. */
function isStringRecord(input: unknown): input is Record<string, string> {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.values(input).every((value) => typeof value === "string")
  );
}

function normalizeChatUiPayload(input: unknown): ChatUiPayload | undefined {
  if (!input || typeof input !== "object") return undefined;
  const surfaces = (input as { surfaces?: unknown }).surfaces;
  if (!surfaces || typeof surfaces !== "object") return undefined;
  const welcomeRaw = (surfaces as { welcome?: unknown }).welcome;
  const welcome =
    welcomeRaw &&
    typeof welcomeRaw === "object" &&
    typeof (welcomeRaw as { enabled?: unknown }).enabled === "boolean"
      ? {
          enabled: (welcomeRaw as { enabled: boolean }).enabled,
          body:
            typeof (welcomeRaw as { body?: unknown }).body === "string"
              ? (welcomeRaw as { body: string }).body
              : "",
        }
      : undefined;
  const perTurnRaw = (surfaces as { perTurnFeedback?: unknown })
    .perTurnFeedback;
  const perTurnFeedback =
    perTurnRaw &&
    typeof perTurnRaw === "object" &&
    typeof (perTurnRaw as { enabled?: unknown }).enabled === "boolean"
      ? {
          enabled: (perTurnRaw as { enabled: boolean }).enabled,
          // A CLOSED enum check, not `optionalString`: the value picks which
          // widget renders and which score key the tester writes under, so an
          // unrecognised string copied through would produce a scenario whose
          // rating widget renders nothing. Anything but "thumbs" omits the
          // field, and absence means stars downstream.
          ...((perTurnRaw as { style?: unknown }).style === "thumbs"
            ? { style: "thumbs" as const }
            : {}),
          ...optionalString(perTurnRaw, "prompt"),
          ...optionalString(perTurnRaw, "commentPlaceholder"),
          ...optionalString(perTurnRaw, "thanksMessage"),
        }
      : undefined;
  // EITHER surface is enough. Returning undefined unless `welcome` parsed
  // (the old behavior) would have silently dropped a per-turn-feedback config
  // on every scenario with no welcome dialog — which is most of them.
  if (!welcome && !perTurnFeedback) return undefined;
  return {
    surfaces: {
      ...(welcome ? { welcome } : {}),
      ...(perTurnFeedback ? { perTurnFeedback } : {}),
    },
  };
}

/** Copy `key` through only when it is a real string; never null-punch it. */
function optionalString(
  source: unknown,
  key: string
): Record<string, string> | Record<string, never> {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function normalizeHostCapabilitiesOverride(
  input: unknown
): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function normalizeModelVisibleMcpToolResults(
  input: unknown
): ModelVisibleMcpToolResults | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as ModelVisibleMcpToolResults;
}

function normalizeMcpToolResultImageRendering(
  input: unknown
): McpToolResultImageRenderingPolicy | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as McpToolResultImageRenderingPolicy;
}

/**
 * Defensive boundary check for `chatUiOverride` in redeem responses /
 * playground snapshots. Same untrusted-shape gate as
 * {@link normalizeHostCapabilitiesOverride}: reject obvious shape errors,
 * pass anything object-shaped through as `ChatUiOverride`. The backend
 * validator is the source of truth for structural correctness; this only
 * guards against an upstream serialization bug slipping garbage into
 * typed code.
 */
function normalizeChatUiOverride(input: unknown): ChatUiOverride | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as ChatUiOverride;
}

function normalizeMcpProfile(
  input: unknown
): HostConfigMcpProfileV1 | undefined {
  // Same untrusted-shape gate as normalizeHostCapabilitiesOverride: this
  // is the boundary between the redeem-response JSON and the typed
  // session. The backend canonicalizer (`canonicalizeMcpProfile` in
  // `convex/lib/hostConfigV2.ts`) is the source of truth for structural
  // validity — a value reaching this point is either undefined or a
  // backend-validated `{ profileVersion: 1, ... }` envelope. We only
  // reject obvious shape errors (non-object, array, null) so an upstream
  // serialization bug can't slip a truthy garbage payload into typed
  // code that assumes the envelope shape.
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as HostConfigMcpProfileV1;
}

function normalizeChatboxShareMode(mode: unknown): ChatboxShareMode {
  if (mode === "project_members") return "project_members";
  if (mode === "anyone_with_link") return "anyone_with_link";
  // Legacy alias from before the chatbox auth refactor renamed the
  // any-signed-in-with-link mode. Editor/builder surfaces still write
  // it; map to the semantic equivalent so persisted sessions don't
  // silently downgrade to invited-only when read back.
  if (mode === "any_signed_in_with_link") return "anyone_with_link";
  return "invited_only";
}

/** Both tester-link path shapes — see `lib/tester-link-path.ts`. */
export function extractChatboxTokenFromPath(pathname: string): string | null {
  return extractTesterLinkToken(pathname);
}

export function hasActiveChatboxSession(): boolean {
  return readChatboxSession() !== null;
}

export function normalizeChatboxSession(
  parsed: Partial<ChatboxSession> | null
): ChatboxSession | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const chatboxId =
    typeof parsed.chatboxId === "string" ? parsed.chatboxId.trim() : "";
  const accessVersion =
    typeof parsed.accessVersion === "number" &&
    Number.isFinite(parsed.accessVersion)
      ? parsed.accessVersion
      : null;
  const payload = parsed.payload;
  const hostStyle =
    normalizeChatboxHostStyleId(payload?.hostStyle) ??
    (payload?.hostStyle == null ? DEFAULT_HOST_STYLE.id : null);

  if (
    !chatboxId ||
    accessVersion === null ||
    !payload ||
    typeof payload.projectId !== "string" ||
    typeof payload.chatboxId !== "string" ||
    typeof payload.name !== "string" ||
    hostStyle === null ||
    typeof payload.modelId !== "string" ||
    typeof payload.systemPrompt !== "string" ||
    typeof payload.temperature !== "number" ||
    typeof payload.requireToolApproval !== "boolean" ||
    typeof payload.allowGuestAccess !== "boolean" ||
    typeof payload.viewerIsProjectMember !== "boolean" ||
    !Array.isArray(payload.servers)
  ) {
    return null;
  }

  return {
    chatboxId,
    accessVersion,
    payload: {
      projectId: payload.projectId,
      chatboxId: payload.chatboxId,
      name: payload.name,
      description:
        typeof payload.description === "string"
          ? payload.description
          : undefined,
      hostStyle,
      mode: normalizeChatboxShareMode(payload.mode),
      allowGuestAccess: payload.allowGuestAccess,
      viewerIsProjectMember: payload.viewerIsProjectMember,
      systemPrompt: payload.systemPrompt,
      modelId: payload.modelId,
      temperature: payload.temperature,
      requireToolApproval: payload.requireToolApproval,
      modelVisibleMcpToolResults: normalizeModelVisibleMcpToolResults(
        payload.modelVisibleMcpToolResults
      ),
      mcpToolResultImageRendering: normalizeMcpToolResultImageRendering(
        payload.mcpToolResultImageRendering
      ),
      servers: payload.servers
        .filter(
          (server): server is ChatboxBootstrapServer =>
            !!server &&
            typeof server === "object" &&
            typeof server.serverId === "string" &&
            typeof server.serverName === "string"
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
          ...(typeof server.oauthProtocolMode === "string"
            ? { oauthProtocolMode: server.oauthProtocolMode }
            : {}),
          ...(typeof server.oauthProtocolVersion === "string"
            ? { oauthProtocolVersion: server.oauthProtocolVersion }
            : {}),
          ...(typeof server.wireProtocolVersion === "string"
            ? { wireProtocolVersion: server.wireProtocolVersion }
            : {}),
          // Per-server OAuth facts the hosted authorization needs to build the
          // same request a local connect builds. This mapping is an allowlist,
          // so a field absent here is silently dropped no matter what the
          // payload carried — which is exactly how the hosted path came to
          // authorize differently from every other entry point.
          ...(typeof server.oauthResourceUrl === "string"
            ? { oauthResourceUrl: server.oauthResourceUrl }
            : {}),
          ...(typeof server.hasClientSecret === "boolean"
            ? { hasClientSecret: server.hasClientSecret }
            : {}),
          ...(isStringRecord(server.oauthCustomHeaders)
            ? { oauthCustomHeaders: server.oauthCustomHeaders }
            : {}),
          ...(typeof server.oauthAllowPathScopedIssuer === "boolean"
            ? { oauthAllowPathScopedIssuer: server.oauthAllowPathScopedIssuer }
            : {}),
          ...(typeof server.registrationMode === "string"
            ? { registrationMode: server.registrationMode }
            : {}),
          optional: Boolean(server.optional),
        })),
      chatUi: normalizeChatUiPayload(payload.chatUi),
      hostCapabilitiesOverride: normalizeHostCapabilitiesOverride(
        (payload as { hostCapabilitiesOverride?: unknown })
          .hostCapabilitiesOverride
      ),
      chatUiOverride: normalizeChatUiOverride(
        (payload as { chatUiOverride?: unknown }).chatUiOverride
      ),
      mcpProfile: normalizeMcpProfile(
        (payload as { mcpProfile?: unknown }).mcpProfile
      ),
    },
    surface: parsed.surface === "preview" ? "preview" : "share_link",
    shareToken:
      typeof parsed.shareToken === "string" && parsed.shareToken.trim()
        ? parsed.shareToken.trim()
        : undefined,
  };
}

function readStoredChatboxSession(storageKey: string): ChatboxSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;

    return normalizeChatboxSession(
      JSON.parse(raw) as Partial<ChatboxSession> | null
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
  session: ChatboxSession
): void {
  sessionStorage.setItem(storageKey, JSON.stringify(session));
}

export function writeChatboxSession(session: ChatboxSession): void {
  writeStoredChatboxSession(CHATBOX_SESSION_STORAGE_KEY, session);
}

export function readChatboxSurfaceFromUrl(
  search: string
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

export function writeChatboxSignInReturnPath(path: string): void {
  const normalizedPath = path.trim();
  if (!extractChatboxTokenFromPath(normalizedPath)) {
    return;
  }

  try {
    localStorage.setItem(
      CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      normalizedPath
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
  return `${origin}/${TESTER_LINK_PATH_SEGMENT}/${slugify(
    chatboxName
  )}/${encodeURIComponent(token)}`;
}
