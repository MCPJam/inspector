import { provisionGuestAuthConfigToConvex } from "./convex-guest-auth-sync.js";
import { logger } from "./logger.js";
import {
  GUEST_SESSION_SECRET_HEADER,
  getGuestSessionSharedSecret,
} from "./guest-session-secret.js";

const DEFAULT_REMOTE_GUEST_SESSION_URL =
  "https://app.mcpjam.com/api/web/guest-session";

export type RemoteGuestSession = {
  guestId?: string;
  token: string;
  expiresAt: number;
};

export type GuestSessionFetchContext = {
  cookie?: string | null;
  userAgent?: string | null;
  forwardedFor?: string | null;
  realIp?: string | null;
  body?: GuestSessionRequestBody | null;
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
      message?: string;
      setCookies: string[];
    };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for guest auth");
  }
  return convexHttpUrl;
}

function buildConvexGuestUrl(pathname: string): string {
  return new URL(pathname, getConvexHttpUrl()).toString();
}

function getConvexGuestSessionUrl(): string {
  return buildConvexGuestUrl("/guest/session");
}

export function getRemoteGuestSessionUrl(): string {
  return (
    process.env.MCPJAM_GUEST_SESSION_URL || DEFAULT_REMOTE_GUEST_SESSION_URL
  );
}

export function getRemoteGuestJwksUrl(): string {
  return (
    process.env.MCPJAM_GUEST_JWKS_URL || buildConvexGuestUrl("/guest/jwks")
  );
}

function readSetCookies(headers: Headers): string[] {
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
  context: GuestSessionFetchContext | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (context?.cookie) {
    headers["Cookie"] = context.cookie;
  }
  if (context?.userAgent) {
    headers["User-Agent"] = context.userAgent;
  }
  if (context?.forwardedFor) {
    headers["X-Forwarded-For"] = context.forwardedFor;
  }
  if (context?.realIp) {
    headers["X-Real-IP"] = context.realIp;
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
    guestId:
      typeof session.guestId === "string" ? session.guestId : undefined,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

async function performGuestSessionFetch(
  url: string,
  init: RequestInit,
  source: "Convex" | "MCPJam",
  mode: "lookup_or_create" | "lookup_only" | undefined,
): Promise<GuestSessionFetchResult> {
  try {
    const response = await fetch(url, init);
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
      return { kind: "error", status: response.status, setCookies };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "error", status: 503, setCookies };
    }

    const session = parseSessionPayload(body);
    if (!session) {
      logger.warn(
        `[guest-auth] ${source} guest session response was missing token or expiresAt`,
      );
      return { kind: "error", status: 503, setCookies };
    }

    logger.info(`[guest-auth] Fetched guest token from ${source} guest session`);
    return { kind: "session", session, setCookies };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to fetch ${source} guest session: ${errMsg}`);
    return { kind: "error", status: 503, setCookies: [] };
  }
}

export async function fetchRemoteGuestSession(
  context?: GuestSessionFetchContext,
): Promise<GuestSessionFetchResult> {
  return performGuestSessionFetch(
    getRemoteGuestSessionUrl(),
    {
      method: "POST",
      headers: buildForwardedHeaders(context, {}),
      body: buildRequestBody(context),
      signal: AbortSignal.timeout(10_000),
    },
    "MCPJam",
    context?.body?.mode,
  );
}

export async function fetchConvexGuestSession(
  context?: GuestSessionFetchContext,
): Promise<GuestSessionFetchResult> {
  try {
    await provisionGuestAuthConfigToConvex();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to provision Convex guest auth env: ${errMsg}`,
    );
    return { kind: "error", status: 503, setCookies: [] };
  }

  return performGuestSessionFetch(
    getConvexGuestSessionUrl(),
    {
      method: "POST",
      headers: buildForwardedHeaders(context, {
        [GUEST_SESSION_SECRET_HEADER]: getGuestSessionSharedSecret(),
      }),
      body: buildRequestBody(context),
      signal: AbortSignal.timeout(10_000),
    },
    "Convex",
    context?.body?.mode,
  );
}

/**
 * Server-only fetch helper used by inspector services that need a guest
 * bearer token without browser context (no cookie, no UA, no IP). Returns
 * just the session JSON or null. Always uses lookup_or_create.
 */
export async function fetchGuestSessionForServerSideAuth(): Promise<RemoteGuestSession | null> {
  const useRemote =
    process.env.MCPJAM_GUEST_SESSION_URL ||
    process.env.NODE_ENV === "production";

  const result = useRemote
    ? await fetchRemoteGuestSession()
    : await fetchConvexGuestSession();

  return result.kind === "session" ? result.session : null;
}

export async function fetchRemoteGuestJwks(): Promise<Response | null> {
  try {
    if (!process.env.MCPJAM_GUEST_JWKS_URL) {
      await provisionGuestAuthConfigToConvex();
    }

    return await fetch(getRemoteGuestJwksUrl(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[guest-auth] Failed to fetch MCPJam guest JWKS: ${errMsg}`);
    return null;
  }
}
