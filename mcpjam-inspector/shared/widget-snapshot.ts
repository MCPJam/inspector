import { sanitizeForConvexTransport } from "./convex-sanitize";
import type { EvalTraceWidgetSnapshot } from "./eval-trace";

/**
 * Wire shape of a `sharedChatWidgetSnapshots` row, less the
 * session/scope context that varies by writer (the playground threads
 * `chatboxId`/`accessVersion`/`chatSessionId`; the eval per-turn fanout
 * embeds widgets in `appendEvalTurnTrace.turn.widgets`; the synthetic
 * runner adds its own ambient scope at the mutation site).
 *
 * Every writer to `sharedChatWidgetSnapshots` (client playground hook,
 * server synthetic-sessions runner, server eval persist) builds this
 * shape and then layers site-specific context on top. The backend table
 * schema in `mcpjam-backend/convex/schema.ts::sharedChatWidgetSnapshots`
 * is the source of truth for the wire contract; this type is its
 * inspector-side mirror.
 *
 * `injectedOpenAiCompat*`:
 *   The OpenAI Apps SDK `window.openai` shim's provenance — was the
 *   shim injected at capture time, and with which per-method
 *   capability surface. Backend now accepts these on both
 *   `chatSessions:createWidgetSnapshot` and `appendEvalTurnTrace`
 *   (mcpjam-backend#435); persisted on the `sharedChatWidgetSnapshots`
 *   row. Replay reads these to reconstruct the same `window.openai`
 *   surface the widget was captured against, since the cached HTML
 *   bytes embed shim assumptions made at capture time.
 */
export type SharedChatWidgetSnapshotPayload = {
  toolCallId: string;
  toolName: string;
  /**
   * The MCP server identifier. Optional because the playground's
   * `createWidgetSnapshot` mutation can derive it from the session row
   * server-side when absent (visitor sessions know their server).
   * Required by the eval `appendEvalTurnTrace` path — that caller MUST
   * supply it. Wire shape:
   *   - eval: friendly name (e.g. `"excalidraw"`); backend resolves via
   *     `resolveEvalWidgetServerIds`.
   *   - playground/synthetic: already-resolved `Id<'servers'>` string.
   */
  serverId?: string;
  widgetHtmlBlobId: string;
  uiType: "mcp-apps" | "openai-apps";
  resourceUri?: string;
  toolInputBlobId?: string;
  toolOutputBlobId?: string;
  widgetCsp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  /**
   * Free-form on the wire — backend validator is `v.any()`. JSON Schema
   * fragments routinely appear here and use $-prefixed keys (`$ref`,
   * `$schema`). Callers MUST pass the result through
   * `sanitizeWidgetForBackend` before sending; Convex's argument
   * validator rejects raw $-prefixed keys.
   */
  widgetPermissions?: unknown;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  displayContext?: SharedChatWidgetDisplayContext;
  /**
   * Whether the OpenAI Apps SDK `window.openai` shim was injected into
   * `widgetHtmlBlobId`'s contents at capture time. Persisted so replay
   * can render the blob faithfully under a different host config —
   * the cached HTML embeds shim assumptions, so a render without the
   * matching shim would call methods that don't exist on `window`.
   */
  injectedOpenAiCompat?: boolean;
  /**
   * The per-method `window.openai.*` surface the runtime was configured
   * with when the widget HTML was captured. The boolean above only
   * answers "was a shim injected?"; this matrix tells replay *which*
   * surface so debug/diff views can render the delta vs preset.
   *
   * Absent for snapshots captured before the matrix shipped — replay
   * treats those as the full ChatGPT surface (pre-matrix default).
   */
  injectedOpenAiCompatCapabilities?: InjectedOpenAiCompatCapabilities;
};

/**
 * Structurally identical to `OpenAiAppsCapabilities` in
 * `client/src/lib/client-styles/types.ts` (and to the matching shape on
 * `EvalTraceWidgetSnapshot`). All three are wire-level mirrors of the
 * Convex `injectedOpenAiCompatCapabilitiesValidator` — kept separate
 * because the client-styles file lives in `client/` and can't be
 * imported from shared/. A future cleanup could move the canonical
 * definition here and have the client-side alias re-export.
 */
export type InjectedOpenAiCompatCapabilities = {
  callTool?: boolean;
  sendFollowUpMessage?: boolean;
  setWidgetState?: boolean;
  requestDisplayMode?: "all" | "fullscreen-only" | "none";
  notifyIntrinsicHeight?: boolean;
  openExternal?: boolean;
  setOpenInAppUrl?: boolean;
  requestModal?: boolean;
  uploadFile?: boolean;
  selectFiles?: boolean;
  getFileDownloadUrl?: boolean;
  requestCheckout?: boolean;
  requestClose?: boolean;
};

/**
 * Per-render display environment threaded with a widget snapshot. Same
 * shape the `displayContextValidator` enforces server-side. Re-exported
 * from `client/src/hooks/useViews.ts` as `DisplayContext` for callers
 * that imported it from there before this module existed.
 */
export type SharedChatWidgetDisplayContext = {
  theme?: "light" | "dark";
  displayMode?: "inline" | "pip" | "fullscreen";
  deviceType?: "mobile" | "tablet" | "desktop";
  viewport?: { width: number; height: number };
  locale?: string;
  timeZone?: string;
  capabilities?: { hover: boolean; touch: boolean };
  safeAreaInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
};

/**
 * CSP fields persisted with a widget snapshot. Re-exported from
 * `useViews.ts` as `WidgetCsp` for compatibility.
 */
export type SharedChatWidgetCsp = NonNullable<
  SharedChatWidgetSnapshotPayload["widgetCsp"]
>;

function toStringArrayOrUndefined(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Defensive normalization for `widgetCsp` when the caller has it as a
 * loose record. Used by writers whose source captures CSP via JSON
 * (eval/synthetic, which round-trip through `_storage`); the playground
 * has it from the live runtime widget shape, which is already typed,
 * but running it through this is a no-op on a well-shaped input so
 * callers can use the same pipeline.
 *
 * Returns `undefined` rather than `{}` when no recognized fields are
 * present — both `chatSessions:createWidgetSnapshot` and
 * `appendEvalTurnTrace` treat absent CSP differently from an empty
 * one, so the distinction matters.
 */
export function normalizeWidgetCsp(
  input: unknown,
): SharedChatWidgetSnapshotPayload["widgetCsp"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const csp: NonNullable<SharedChatWidgetSnapshotPayload["widgetCsp"]> = {};
  const connect = toStringArrayOrUndefined(rec.connectDomains);
  const resource = toStringArrayOrUndefined(rec.resourceDomains);
  const frame = toStringArrayOrUndefined(rec.frameDomains);
  const base = toStringArrayOrUndefined(rec.baseUriDomains);
  if (connect) csp.connectDomains = connect;
  if (resource) csp.resourceDomains = resource;
  if (frame) csp.frameDomains = frame;
  if (base) csp.baseUriDomains = base;
  return Object.keys(csp).length > 0 ? csp : undefined;
}

/**
 * Sanitize a widget payload for Convex transport. Escapes $-prefixed
 * keys (typically inside `widgetPermissions`) to `__convexReserved__*`
 * so Convex's argument validator accepts them. Idempotent on payloads
 * with no reserved keys.
 *
 * Why every writer needs this: backend `widgetPermissions` validator is
 * `v.any()` for shape flexibility, but Convex still enforces the
 * reserved-key prefix at the transport layer, so the validator never
 * gets the chance to see the data — the whole mutation call fails. The
 * sibling `sessionMessages` / `spans` / `prompts` arrays in the eval
 * fanout already use the same sanitizer for the same reason.
 */
export function sanitizeWidgetForBackend<
  T extends SharedChatWidgetSnapshotPayload,
>(payload: T): T {
  return sanitizeForConvexTransport(payload);
}

/**
 * Convert an `EvalTraceWidgetSnapshot` (the serialized capture shape
 * used by `captureMcpAppWidgetSnapshots` and shared between the eval
 * and synthetic-sessions runners) to the shared payload.
 *
 * Returns `null` when the widget is unsendable. Today that means
 * `widgetHtmlBlobId` is missing — the backend table requires it, and
 * without HTML the widget is unusable to the Sessions viewer anyway.
 *
 * Field renames:
 *   `protocol` → `uiType`
 * Dropped:
 *   `toolMetadata` (backend persists tool input/output separately, not
 *     as inline metadata)
 *   `widgetHtmlUrl` (backend stores only the blob id)
 *
 * Callers MUST run the result through `sanitizeWidgetForBackend`
 * before sending. (The two steps are kept separate so tests can exercise
 * the mapping without the sanitizer's key-mangling and vice versa.)
 */
export function evalTraceSnapshotToPayload(
  snap: EvalTraceWidgetSnapshot,
): SharedChatWidgetSnapshotPayload | null {
  if (!snap.widgetHtmlBlobId) return null;
  const payload: SharedChatWidgetSnapshotPayload = {
    toolCallId: snap.toolCallId,
    toolName: snap.toolName,
    serverId: snap.serverId,
    widgetHtmlBlobId: snap.widgetHtmlBlobId,
    uiType: snap.protocol,
  };
  if (snap.resourceUri) payload.resourceUri = snap.resourceUri;
  const csp = normalizeWidgetCsp(snap.widgetCsp);
  if (csp) payload.widgetCsp = csp;
  if (snap.widgetPermissions !== undefined && snap.widgetPermissions !== null) {
    payload.widgetPermissions = snap.widgetPermissions;
  }
  if (typeof snap.widgetPermissive === "boolean") {
    payload.widgetPermissive = snap.widgetPermissive;
  }
  if (typeof snap.prefersBorder === "boolean") {
    payload.prefersBorder = snap.prefersBorder;
  }
  if (typeof snap.injectedOpenAiCompat === "boolean") {
    payload.injectedOpenAiCompat = snap.injectedOpenAiCompat;
  }
  if (snap.injectedOpenAiCompatCapabilities) {
    payload.injectedOpenAiCompatCapabilities =
      snap.injectedOpenAiCompatCapabilities;
  }
  return payload;
}
