import {
  normalizeScenarioHostStyleId,
  type ScenarioHostStyle,
} from "@/lib/scenario-client-style";
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
import type {
  ScenarioPerTurnFeedbackStyle,
  ScenarioTaskItem,
} from "@/types/chatUi";

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
 * Scenario access modes. Mirrors the backend `scenarioModeValidator`.
 */
export type ScenarioShareMode =
  "project_members" | "invited_only" | "anyone_with_link";

export interface ScenarioBootstrapServer {
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

export interface ScenarioWelcomeDialogPayload {
  enabled: boolean;
  body?: string;
}

/**
 * Per-turn ratings config. Absent or `enabled: false` ⇒ the widget renders
 * nothing, which is what lets the UI ship before any scenario turns it on.
 */
export interface ScenarioPerTurnFeedbackPayload {
  enabled: boolean;
  /**
   * Which widget to render, and therefore which score key the tester writes
   * under. Absent ⇒ `stars`, the only style that existed before this field.
   *
   * Aliased from the settings type rather than restated, so the bootstrap
   * payload and the scenario config cannot drift apart on what a style is.
   */
  style?: ScenarioPerTurnFeedbackStyle;
  prompt?: string;
  commentPlaceholder?: string;
  thanksMessage?: string;
}

/**
 * The study's "what to try" list, as the tester's session receives it.
 *
 * Absent on a backend predating BB-176, and `items: []` for a study whose
 * creator authored none — both mean the header control is not rendered, so
 * every reader must treat absent and empty the same way.
 *
 * `ScenarioTaskItem` is aliased from the settings type rather than restated,
 * so the bootstrap payload and the editor cannot drift apart on what a task
 * is.
 */
export interface ScenarioTasksPayload {
  items?: ScenarioTaskItem[];
}

export interface ChatUiPayload {
  surfaces?: {
    welcome?: ScenarioWelcomeDialogPayload | null;
    perTurnFeedback?: ScenarioPerTurnFeedbackPayload | null;
    tasks?: ScenarioTasksPayload | null;
  } | null;
}

export interface ScenarioBootstrapPayload {
  projectId: string;
  scenarioId: string;
  name: string;
  description?: string;
  hostStyle: ScenarioHostStyle;
  mode: ScenarioShareMode;
  allowGuestAccess: boolean;
  viewerIsProjectMember: boolean;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  servers: ScenarioBootstrapServer[];
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
   * Snapshotted at scenario creation time — see comment on `hostStyle`
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

export interface ScenarioSession {
  /**
   * Resolved scenario identity. Returned by /api/web/scenarios/redeem and
   * stored at the top level so callers don't have to dig through
   * `payload`. Every scenario-aware backend call keys on this; the URL
   * link token is consumed only at redemption time and is not persisted.
   */
  scenarioId: string;
  /**
   * Backend-owned monotonic counter returned by /web/scenario/redeem.
   * Bumps whenever access changes (mode, revoke-all, allowlist edits,
   * invite removal). Threaded into every scenario-aware server call so
   * inspector caches invalidate cleanly.
   */
  accessVersion: number;
  payload: ScenarioBootstrapPayload;
  surface?: "preview" | "share_link";
  /**
   * Original URL share token captured at redeem time. Persisted so the
   * hosted Copy link button can reconstruct the canonical share URL after
   * the redeem flow rewrites the address bar to `/#<slug>`. UI-only — no
   * backend call should key on this; access is gated by `accessVersion`.
   */
  shareToken?: string;
}

// Bumped from v1 → v2: ScenarioSession dropped the URL token and added
// required top-level `scenarioId` + `accessVersion`. Reading a v1 row would
// produce a malformed session; rev the key so the v1 row is ignored and
// the next landing-page mount re-redeems cleanly.
export const SCENARIO_SESSION_STORAGE_KEY = "mcpjam_scenario_session_v2";
export const SCENARIO_OAUTH_PENDING_KEY = "mcp-oauth-scenario-pending";
export const SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY =
  "mcpjam_scenario_signin_return_path_v1";

/** sessionStorage: optional servers the tester enabled for this scenario session. */
export function scenarioEnabledOptionalStorageKey(scenarioId: string): string {
  return `scenario-enabled-optional:${scenarioId}`;
}

// Defensive normalizer for the chatUi envelope in /web/scenario/redeem
// responses. Returns `undefined` when no recognized surface is present. The
// hosted runtime consumes `perTurnFeedback` and `tasks`; the deprecated
// session-level `feedback` dialog is dropped on purpose (its write path is
// gone — see the backend's `sessionScores` design note), and `welcome` is
// parsed only so an older stored session still round-trips — the recording
// notice replaced it, and nothing renders creator welcome copy any more
// (BB-176).
//
// EVERY surface has to be listed here. This is an allowlist, so a surface the
// backend sends and this function does not name reaches the runtime as
// `undefined` — which is how a new one silently does nothing.
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
  const tasksRaw = (surfaces as { tasks?: unknown }).tasks;
  const tasksItems =
    tasksRaw && typeof tasksRaw === "object"
      ? (tasksRaw as { items?: unknown }).items
      : undefined;
  // A row is kept only if it has both an id to key the tester's local check
  // state and a title to show. A titleless checkbox is not a task, and an
  // id-less one would collide with its neighbours the moment a task is
  // removed. The backend normalizer repairs both; this is the boundary that
  // holds when the response did not come from it.
  const tasks = Array.isArray(tasksItems)
    ? { items: normalizeScenarioTaskItems(tasksItems) }
    : undefined;
  // ANY surface is enough. Returning undefined unless `welcome` parsed (the
  // old behavior) would have silently dropped a per-turn-feedback config on
  // every scenario with no welcome dialog — which is most of them. An EMPTY
  // task list is still a parsed surface: "this study has no tasks" is the
  // ordinary answer, and it reads the same as absent downstream.
  if (!welcome && !perTurnFeedback && !tasks) return undefined;
  return {
    surfaces: {
      ...(welcome ? { welcome } : {}),
      ...(perTurnFeedback ? { perTurnFeedback } : {}),
      ...(tasks ? { tasks } : {}),
    },
  };
}

/**
 * The tester's task rows, kept only where they can actually work.
 *
 * A row needs both an id to key the tester's local check state and a title to
 * show. A titleless checkbox is not a task, and an id-less one would collide
 * with its neighbours the moment a task is removed.
 *
 * DUPLICATE IDS ARE DROPPED (first wins). The checklist keys both its checked
 * set and its remaining count on `task.id`, so two rows sharing an id would
 * tick together on one click and leave the "N left" count wrong. The backend
 * normalizer already repairs collisions — this boundary is for the responses
 * that did not come from it, which is the only reason it exists.
 */
function normalizeScenarioTaskItems(items: unknown[]): ScenarioTaskItem[] {
  const seen = new Set<string>();
  const kept: ScenarioTaskItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    const title = (item as { title?: unknown }).title;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof title !== "string" || title.trim().length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push({ id, title, ...optionalString(item, "hint") });
  }
  return kept;
}

/** Copy `key` through only when it is a real string; never null-punch it. */
function optionalString(
  source: unknown,
  key: string,
): Record<string, string> | Record<string, never> {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function normalizeHostCapabilitiesOverride(
  input: unknown,
): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function normalizeModelVisibleMcpToolResults(
  input: unknown,
): ModelVisibleMcpToolResults | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as ModelVisibleMcpToolResults;
}

function normalizeMcpToolResultImageRendering(
  input: unknown,
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
  input: unknown,
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

function normalizeScenarioShareMode(mode: unknown): ScenarioShareMode {
  if (mode === "project_members") return "project_members";
  if (mode === "anyone_with_link") return "anyone_with_link";
  // Legacy alias from before the scenario auth refactor renamed the
  // any-signed-in-with-link mode. Editor/builder surfaces still write
  // it; map to the semantic equivalent so persisted sessions don't
  // silently downgrade to invited-only when read back.
  if (mode === "any_signed_in_with_link") return "anyone_with_link";
  return "invited_only";
}

/** The tester-link path shape — see `lib/tester-link-path.ts`. */
export function extractScenarioTokenFromPath(pathname: string): string | null {
  return extractTesterLinkToken(pathname);
}

export function hasActiveScenarioSession(): boolean {
  return readScenarioSession() !== null;
}

export function normalizeScenarioSession(
  parsed: Partial<ScenarioSession> | null,
): ScenarioSession | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const scenarioId =
    typeof parsed.scenarioId === "string" ? parsed.scenarioId.trim() : "";
  const accessVersion =
    typeof parsed.accessVersion === "number" &&
    Number.isFinite(parsed.accessVersion)
      ? parsed.accessVersion
      : null;
  const payload = parsed.payload;
  const hostStyle =
    normalizeScenarioHostStyleId(payload?.hostStyle) ??
    (payload?.hostStyle == null ? DEFAULT_HOST_STYLE.id : null);

  if (
    !scenarioId ||
    accessVersion === null ||
    !payload ||
    typeof payload.projectId !== "string" ||
    typeof payload.scenarioId !== "string" ||
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
    scenarioId,
    accessVersion,
    payload: {
      projectId: payload.projectId,
      scenarioId: payload.scenarioId,
      name: payload.name,
      description:
        typeof payload.description === "string"
          ? payload.description
          : undefined,
      hostStyle,
      mode: normalizeScenarioShareMode(payload.mode),
      allowGuestAccess: payload.allowGuestAccess,
      viewerIsProjectMember: payload.viewerIsProjectMember,
      systemPrompt: payload.systemPrompt,
      modelId: payload.modelId,
      temperature: payload.temperature,
      requireToolApproval: payload.requireToolApproval,
      modelVisibleMcpToolResults: normalizeModelVisibleMcpToolResults(
        payload.modelVisibleMcpToolResults,
      ),
      mcpToolResultImageRendering: normalizeMcpToolResultImageRendering(
        payload.mcpToolResultImageRendering,
      ),
      servers: payload.servers
        .filter(
          (server): server is ScenarioBootstrapServer =>
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
          .hostCapabilitiesOverride,
      ),
      chatUiOverride: normalizeChatUiOverride(
        (payload as { chatUiOverride?: unknown }).chatUiOverride,
      ),
      mcpProfile: normalizeMcpProfile(
        (payload as { mcpProfile?: unknown }).mcpProfile,
      ),
    },
    surface: parsed.surface === "preview" ? "preview" : "share_link",
    shareToken:
      typeof parsed.shareToken === "string" && parsed.shareToken.trim()
        ? parsed.shareToken.trim()
        : undefined,
  };
}

function readStoredScenarioSession(storageKey: string): ScenarioSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;

    return normalizeScenarioSession(
      JSON.parse(raw) as Partial<ScenarioSession> | null,
    );
  } catch {
    return null;
  }
}

export function readScenarioSession(): ScenarioSession | null {
  return readStoredScenarioSession(SCENARIO_SESSION_STORAGE_KEY);
}

function writeStoredScenarioSession(
  storageKey: string,
  session: ScenarioSession,
): void {
  sessionStorage.setItem(storageKey, JSON.stringify(session));
}

export function writeScenarioSession(session: ScenarioSession): void {
  writeStoredScenarioSession(SCENARIO_SESSION_STORAGE_KEY, session);
}

/**
 * Tag a tester link as PREVIEW traffic — the write side of
 * `readScenarioSurfaceFromUrl`.
 *
 * A creator opening their own study still starts a real guest session, so
 * without this marker their look-around lands in the study's own Sessions list
 * as if a tester had run it. The docked preview pane used to set it on the
 * iframe src; now that the pane is gone and "Open preview" is the only preview
 * path, the header link has to carry it or every creator visit pollutes the
 * data the study exists to collect (BB-176).
 *
 * Returns the link UNCHANGED when it cannot be parsed: an untagged preview is
 * a labelling problem, a broken href is a dead button.
 */
export function withScenarioPreviewSurface(link: string): string {
  try {
    const url = new URL(link, window.location.href);
    url.searchParams.set("surface", "preview");
    return url.toString();
  } catch {
    return link;
  }
}

export function readScenarioSurfaceFromUrl(
  search: string,
): "preview" | "share_link" {
  try {
    const surface = new URLSearchParams(search).get("surface");
    return surface === "preview" ? "preview" : "share_link";
  } catch {
    return "share_link";
  }
}

export function clearScenarioSession(): void {
  sessionStorage.removeItem(SCENARIO_SESSION_STORAGE_KEY);
}

export function writeScenarioSignInReturnPath(path: string): void {
  const normalizedPath = path.trim();
  if (!extractScenarioTokenFromPath(normalizedPath)) {
    return;
  }

  try {
    localStorage.setItem(
      SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY,
      normalizedPath,
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readScenarioSignInReturnPath(): string | null {
  try {
    const raw = localStorage.getItem(SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY);
    if (!raw) return null;
    const normalizedPath = raw.trim();
    if (!normalizedPath || !extractScenarioTokenFromPath(normalizedPath)) {
      return null;
    }
    return normalizedPath;
  } catch {
    return null;
  }
}

export function clearScenarioSignInReturnPath(): void {
  localStorage.removeItem(SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY);
}

export function buildScenarioLink(token: string, scenarioName: string): string {
  const origin = getShareableAppOrigin();
  return `${origin}/${TESTER_LINK_PATH_SEGMENT}/${slugify(
    scenarioName,
  )}/${encodeURIComponent(token)}`;
}
