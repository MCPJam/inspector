/**
 * How the sign-in popup's callback page finds the tab that opened it.
 *
 * A provider page that sends `Cross-Origin-Opener-Policy: same-origin` cuts
 * the popup off from its opener: back on `/oauth/callback/debug`,
 * `window.opener` is null and `window.name` is empty, exactly like a desktop
 * app's system-browser return. So the opener leaves a marker in
 * `localStorage`, keyed by a hash of the request's `state`, before the popup
 * opens. The callback page answers on a BroadcastChannel named for that hash
 * when it finds one, and hands off to the desktop app only when it doesn't.
 *
 * The marker holds no credential: no code, verifier or token, and the key is
 * a hash, not the `state` itself. The answer stays memory-only (see
 * `oauth-callback-inbox.ts`).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export type OAuthPopupFlow = "conformance" | "debugger";

/** A marker outlives no sign-in: after this the callback goes to desktop. */
export const OAUTH_POPUP_MARKER_TTL_MS = 10 * 60_000;

const MARKER_KEY_PREFIX = "mcpjam:oauth-popup:";

interface OAuthPopupMarker {
  flow: OAuthPopupFlow;
  createdAt: number;
  expiresAt: number;
}

/** What the callback page sends back: a code or a provider error. */
export interface OAuthCallbackMessage {
  type: "OAUTH_CALLBACK";
  state: string | null;
  code?: string;
  /** RFC 9207 issuer; absent travels as `undefined`, never `null`. */
  iss?: string;
  error?: string;
  errorDescription?: string;
}

export function hashOAuthState(state: string): string {
  return bytesToHex(sha256(utf8ToBytes(state)));
}

export function oauthCallbackChannelName(stateHash: string): string {
  return `oauth_callback:${stateHash}`;
}

/** The `state` an authorization URL carries, or null. */
export function readAuthorizationUrlState(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.get("state") || null;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Storage disabled (sandboxed frame, strict privacy mode): no marker, so
    // the callback only reaches a connected opener.
    return null;
  }
}

function parseMarker(raw: string | null): OAuthPopupMarker | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "expiresAt" in value &&
      typeof value.expiresAt === "number" &&
      "flow" in value &&
      (value.flow === "conformance" || value.flow === "debugger") &&
      "createdAt" in value &&
      typeof value.createdAt === "number"
    ) {
      return { flow: value.flow, createdAt: value.createdAt, expiresAt: value.expiresAt };
    }
    return null;
  } catch {
    return null;
  }
}

function pruneExpiredMarkers(store: Storage, now: number): void {
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const key = store.key(index);
    if (!key?.startsWith(MARKER_KEY_PREFIX)) continue;
    const marker = parseMarker(store.getItem(key));
    if (!marker || marker.expiresAt <= now) store.removeItem(key);
  }
}

/** Records that this tab is waiting on `state`. Returns the state hash. */
export function writeOAuthPopupMarker(
  state: string,
  flow: OAuthPopupFlow,
  now = Date.now(),
): string {
  const stateHash = hashOAuthState(state);
  const store = storage();
  if (!store) return stateHash;
  const marker: OAuthPopupMarker = {
    flow,
    createdAt: now,
    expiresAt: now + OAUTH_POPUP_MARKER_TTL_MS,
  };
  try {
    pruneExpiredMarkers(store, now);
    store.setItem(MARKER_KEY_PREFIX + stateHash, JSON.stringify(marker));
  } catch (error) {
    // A full or blocked store leaves only the opener path; say so in devtools.
    console.warn("[OAuth Popup] Couldn't save the sign-in marker:", error);
  }
  return stateHash;
}

/** The live marker for `state`, or null when there is none or it expired. */
export function readOAuthPopupMarker(
  state: string,
  now = Date.now(),
): OAuthPopupMarker | null {
  const store = storage();
  if (!store) return null;
  const key = MARKER_KEY_PREFIX + hashOAuthState(state);
  const marker = parseMarker(store.getItem(key));
  if (marker && marker.expiresAt > now) return marker;
  if (marker) store.removeItem(key);
  return null;
}

export function deleteOAuthPopupMarker(state: string): void {
  storage()?.removeItem(MARKER_KEY_PREFIX + hashOAuthState(state));
}

/** The callback answer as a message, or null when it holds neither. */
export function buildOAuthCallbackMessage(
  params: URLSearchParams,
): OAuthCallbackMessage | null {
  const code = params.get("code") ?? undefined;
  const error = params.get("error") ?? undefined;
  if (!code && !error) return null;
  return {
    type: "OAUTH_CALLBACK",
    state: params.get("state"),
    code: error ? undefined : code,
    iss: params.get("iss") ?? undefined,
    error,
    errorDescription: params.get("error_description") ?? undefined,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Reads an untyped message; older callback pages send `iss: null`. */
export function parseOAuthCallbackMessage(
  data: unknown,
): OAuthCallbackMessage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== "OAUTH_CALLBACK") return null;
  const code = optionalString(record.code);
  const error = optionalString(record.error);
  if (!code && !error) return null;
  return {
    type: "OAUTH_CALLBACK",
    state: typeof record.state === "string" ? record.state : null,
    code: error ? undefined : code,
    iss: optionalString(record.iss),
    error,
    errorDescription: optionalString(record.errorDescription),
  };
}

export type OAuthCallbackRoute = "opener" | "channel" | "desktop";

/**
 * Where the callback page sends its answer: the connected opener first, then
 * the tab whose marker matches `state`, and the desktop app only when no tab
 * here is waiting.
 */
export function resolveOAuthCallbackRoute(
  hasOpener: boolean,
  state: string | null,
): OAuthCallbackRoute {
  if (hasOpener) return "opener";
  if (state && readOAuthPopupMarker(state)) return "channel";
  return "desktop";
}
