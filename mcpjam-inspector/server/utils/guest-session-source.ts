import type { GuestSessionFailureReason } from "@/shared/guest-session-failure";
import { guestIpForwardHeaders } from "./guest-spend-ip.js";
import { getFetchErrorCause, isFetchTimeout } from "./fetch-error-cause.js";
import { logger } from "./logger.js";
import {
  GUEST_SESSION_SECRET_HEADER,
  getGuestAuthority,
  type GuestAuthority,
} from "./guest-authority.js";

/**
 * Every guest call this Inspector makes, routed to the ONE resolved guest
 * authority (`guest-authority.ts`).
 *
 * Nothing here writes configuration anywhere. Earlier versions provisioned
 * the guest signing keys and shared secret into the configured Convex
 * deployment from inside these helpers — on startup, on the first guest
 * request, on document bootstrap, even on a JWKS read — and silently fell back
 * to a different backend's mint when that write was refused. Ordinary
 * Inspector use now performs zero remote configuration writes; a developer
 * deployment is initialized once, explicitly, by `npm run dev:setup-guest-auth`.
 */

export type RemoteGuestSession = {
  guestId?: string;
  token: string;
  expiresAt: number;
};

export type GuestSessionFetchContext = {
  /**
   * The ONE upstream guest cookie to forward, already in
   * `__Host-mcpjam_guest_session=<value>` form. Never a whole `Cookie` header:
   * forwarding everything would leak unrelated auth/CSRF cookies from this
   * origin to the authority.
   */
  cookie?: string | null;
  userAgent?: string | null;
  body?: GuestSessionRequestBody | null;
  // Hashed client IP so the upstream can record the IP-bucket key on the
  // guest's session row at resolve time. Letting the display path read it
  // from the row before any /stream call has run. Omitted when unavailable so
  // Convex falls back to cookie-only guest limits instead of a shared unknown
  // IP bucket.
  ipHash?: string | null;
};

export type GuestSessionRequestBody = {
  mode?: "lookup_or_create" | "lookup_only";
  legacyToken?: string;
};

export type GuestSessionFetchResult =
  | {
      kind: "session";
      session: RemoteGuestSession;
      setCookies: string[];
    }
  | {
      kind: "miss";
      setCookies: string[];
    }
  | {
      kind: "error";
      status: number;
      setCookies: string[];
      /** Seconds from the upstream `Retry-After` header on a 429. */
      retryAfterSeconds?: number;
      /** Why the upstream hop failed. Sent to the browser on the 503. */
      reason: GuestSessionFailureReason;
      /** The upstream's status, when it answered with a non-ok response. */
      upstreamStatus?: number;
      /** The network error code, e.g. `ENOTFOUND`, when the fetch threw. */
      networkCode?: string;
    };

/** Which kind of authority answered, for log lines. Never a URL or secret. */
function sourceLabel(authority: GuestAuthority): string {
  return authority.kind === "backend" ? "backend" : "hosted";
}

/**
 * Resolve the authority for one call. A configuration error is logged once per
 * call with its (credential-free) message and surfaces to the caller as a
 * `configuration` failure — never as a silent switch to another authority.
 */
function authorityOrNull(): GuestAuthority | null {
  try {
    return getGuestAuthority();
  } catch (error) {
    logger.warn("[guest-auth] Guest authority is not configured", {
      event: "guest_auth.authority_config_error",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Name a thrown fetch or body-read failure. The request's signal carries only
 * our timeout, so an aborted signal means the timeout fired even when the error
 * itself does not say so.
 */
function classifyThrown(
  error: unknown,
  signal: AbortSignal | null | undefined,
  fallback: GuestSessionFailureReason,
): { reason: GuestSessionFailureReason; networkCode?: string } {
  if (isFetchTimeout(error)) return { reason: "timeout" };
  const networkCode = getFetchErrorCause(error);
  if (networkCode) return { reason: "network", networkCode };
  if (signal?.aborted) return { reason: "timeout" };
  return { reason: fallback };
}

export function readSetCookies(headers: Headers): string[] {
  const fnHeaders = headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof fnHeaders.getSetCookie === "function") {
    return fnHeaders.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function buildForwardedHeaders(
  authority: GuestAuthority,
  context: GuestSessionFetchContext | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authority.kind === "backend" && authority.sharedSecret) {
    headers[GUEST_SESSION_SECRET_HEADER] = authority.sharedSecret;
  }
  if (context?.cookie) {
    headers["Cookie"] = context.cookie;
  }
  if (context?.userAgent) {
    headers["User-Agent"] = context.userAgent;
  }
  // The IP-hash attestation rides with `INSPECTOR_SERVICE_TOKEN`, a credential
  // for the selected profile's OWN backend. It is sent to the backend
  // authority only — never to a hosted authority, which neither needs nor
  // should receive this deployment's service token.
  if (authority.kind === "backend") {
    Object.assign(headers, guestIpForwardHeaders(context?.ipHash));
  }
  return headers;
}

function buildRequestBody(
  context: GuestSessionFetchContext | undefined,
): string {
  const body: GuestSessionRequestBody = {};
  if (context?.body?.mode) body.mode = context.body.mode;
  if (context?.body?.legacyToken) body.legacyToken = context.body.legacyToken;
  return JSON.stringify(body);
}

function parseSessionPayload(raw: unknown): RemoteGuestSession | null {
  if (!raw || typeof raw !== "object") return null;
  const session = raw as Record<string, unknown>;
  if (
    typeof session.token !== "string" ||
    typeof session.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    guestId: typeof session.guestId === "string" ? session.guestId : undefined,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

function parseRetryAfterSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

// Default per-fetch timeout. Callers may shorten this (e.g. the document
// bootstrap path) as defense-in-depth so the inner fetch can't outlive a
// shorter whole-helper deadline.
const DEFAULT_GUEST_FETCH_TIMEOUT_MS = 10_000;

/**
 * Resolve (lookup, migrate, or mint) a guest session at the selected
 * authority. `lookup_only` never creates a guest: the authority answers 204
 * when nothing matches, and that is returned as a `miss`.
 */
export async function fetchGuestSession(
  context?: GuestSessionFetchContext,
  timeoutMs: number = DEFAULT_GUEST_FETCH_TIMEOUT_MS,
): Promise<GuestSessionFetchResult> {
  const authority = authorityOrNull();
  if (!authority) {
    return {
      kind: "error",
      status: 503,
      setCookies: [],
      reason: "configuration",
    };
  }
  const source = sourceLabel(authority);
  const mode = context?.body?.mode;
  const init: RequestInit = {
    method: "POST",
    headers: buildForwardedHeaders(authority, context),
    body: buildRequestBody(context),
    signal: AbortSignal.timeout(timeoutMs),
  };

  try {
    const response = await fetch(authority.sessionUrl, init);
    const setCookies = readSetCookies(response.headers);

    // 204 is the upstream's explicit "no guest exists" signal and is always
    // a miss. 404 is ambiguous: in lookup_only it's a reasonable miss, but
    // in lookup_or_create (the default) it almost certainly means the
    // upstream endpoint is missing/misconfigured and should surface as an
    // error rather than silently disabling guest auth.
    if (response.status === 204) {
      return { kind: "miss", setCookies };
    }
    if (response.status === 404 && mode === "lookup_only") {
      return { kind: "miss", setCookies };
    }

    if (!response.ok) {
      logger.warn(
        `[guest-auth] Failed to fetch ${source} guest session: ${response.status} ${response.statusText}`,
      );
      const retryAfterSeconds =
        response.status === 429
          ? parseRetryAfterSeconds(response.headers.get("retry-after"))
          : undefined;
      return {
        kind: "error",
        status: response.status,
        setCookies,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        reason: "upstream_status",
        upstreamStatus: response.status,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // A timeout that fires mid-body lands here too, not only a non-JSON page.
      const failure = classifyThrown(error, init.signal, "bad_json");
      logger.warn(
        `[guest-auth] Failed to read ${source} guest session response`,
        failure,
      );
      return { kind: "error", status: 503, setCookies, ...failure };
    }

    const session = parseSessionPayload(body);
    if (!session) {
      logger.warn(
        `[guest-auth] ${source} guest session response was missing token or expiresAt`,
      );
      return { kind: "error", status: 503, setCookies, reason: "bad_payload" };
    }

    logger.info(
      `[guest-auth] Fetched guest token from ${source} guest session`,
    );
    return { kind: "session", session, setCookies };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const failure = classifyThrown(error, init.signal, "network");
    logger.warn(
      `[guest-auth] Failed to fetch ${source} guest session: ${errMsg}`,
      failure,
    );
    return { kind: "error", status: 503, setCookies: [], ...failure };
  }
}

/**
 * Server-only fetch helper used by inspector services that need a guest
 * bearer token without browser context (no cookie, no UA). Returns
 * just the session JSON or null. Always uses lookup_or_create.
 */
export async function fetchGuestSessionForServerSideAuth(): Promise<RemoteGuestSession | null> {
  const result = await fetchGuestSession();
  return result.kind === "session" ? result.session : null;
}

export type GuestSessionRevokeResult = {
  status: number;
  setCookies: string[];
  body: { revoked: boolean } | null;
};

export async function fetchGuestSessionRevoke(
  context?: GuestSessionFetchContext,
): Promise<GuestSessionRevokeResult> {
  const authority = authorityOrNull();
  if (!authority) return { status: 503, setCookies: [], body: null };
  const source = sourceLabel(authority);
  try {
    const response = await fetch(authority.revokeUrl, {
      method: "POST",
      headers: buildForwardedHeaders(authority, context),
      signal: AbortSignal.timeout(10_000),
    });
    const setCookies = readSetCookies(response.headers);
    let body: { revoked: boolean } | null = null;
    try {
      const raw = (await response.json()) as { revoked?: unknown };
      if (typeof raw.revoked === "boolean") {
        body = { revoked: raw.revoked };
      }
    } catch {
      body = null;
    }
    if (!response.ok) {
      logger.warn(
        `[guest-auth] ${source} guest session revoke returned ${response.status} ${response.statusText}`,
      );
    }
    return { status: response.status, setCookies, body };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to revoke guest session via ${source}: ${errMsg}`,
    );
    return { status: 503, setCookies: [], body: null };
  }
}

export type GuestPromotionProofResult =
  | {
      kind: "proof";
      proof: { guestId?: string; token: string; expiresAt: number };
    }
  | { kind: "miss" }
  | { kind: "revoked"; setCookies: string[] }
  | { kind: "error"; status: number };

export async function fetchGuestPromotionProof(
  context?: GuestSessionFetchContext,
): Promise<GuestPromotionProofResult> {
  const authority = authorityOrNull();
  if (!authority) return { kind: "error", status: 503 };
  const source = sourceLabel(authority);
  try {
    const response = await fetch(authority.promotionProofUrl, {
      method: "POST",
      headers: buildForwardedHeaders(authority, context),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 204) {
      return { kind: "miss" };
    }
    if (response.status === 403) {
      const setCookies = readSetCookies(response.headers);
      // Try to read the body so we can distinguish "session revoked" from
      // generic forbidden, but don't fail if it's not JSON.
      try {
        const raw = (await response.json()) as { code?: unknown };
        if (raw?.code === "FORBIDDEN") {
          return { kind: "revoked", setCookies };
        }
      } catch {
        // fall through
      }
      logger.warn(
        `[guest-auth] ${source} guest promotion proof returned 403 ${response.statusText}`,
      );
      return { kind: "error", status: 403 };
    }
    if (!response.ok) {
      logger.warn(
        `[guest-auth] ${source} guest promotion proof returned ${response.status} ${response.statusText}`,
      );
      return { kind: "error", status: response.status };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "error", status: 503 };
    }

    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as Record<string, unknown>).token !== "string" ||
      typeof (body as Record<string, unknown>).expiresAt !== "number"
    ) {
      logger.warn(
        `[guest-auth] ${source} guest promotion proof response was missing token or expiresAt`,
      );
      return { kind: "error", status: 503 };
    }

    const proof = body as {
      guestId?: string;
      token: string;
      expiresAt: number;
    };
    return {
      kind: "proof",
      proof: {
        guestId: typeof proof.guestId === "string" ? proof.guestId : undefined,
        token: proof.token,
        expiresAt: proof.expiresAt,
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to fetch ${source} guest promotion proof: ${errMsg}`,
    );
    return { kind: "error", status: 503 };
  }
}

/**
 * The selected authority's guest JWKS. A read — it never provisions anything.
 */
export async function fetchGuestJwks(): Promise<Response | null> {
  const authority = authorityOrNull();
  if (!authority) return null;
  try {
    return await fetch(authority.jwksUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to fetch guest JWKS: ${errMsg}`);
    return null;
  }
}
