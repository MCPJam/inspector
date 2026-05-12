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
  extra: Record<string, string>
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
  if (context?.ipHash) {
    headers["x-mcpjam-guest-ip-hash"] = context.ipHash;
  }
  return headers;
}

function buildRequestBody(
  context: GuestSessionFetchContext | undefined
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

async function performGuestSessionFetch(
  url: string,
  init: RequestInit,
  source: "Convex" | "MCPJam",
  mode: "lookup_or_create" | "lookup_only" | undefined
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
        `[guest-auth] Failed to fetch ${source} guest session: ${response.status} ${response.statusText}`
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
        `[guest-auth] ${source} guest session response was missing token or expiresAt`
      );
      return { kind: "error", status: 503, setCookies };
    }

    logger.info(
      `[guest-auth] Fetched guest token from ${source} guest session`
    );
    return { kind: "session", session, setCookies };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to fetch ${source} guest session: ${errMsg}`
    );
    return { kind: "error", status: 503, setCookies: [] };
  }
}

export async function fetchRemoteGuestSession(
  context?: GuestSessionFetchContext
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
    context?.body?.mode
  );
}

export async function fetchConvexGuestSession(
  context?: GuestSessionFetchContext
): Promise<GuestSessionFetchResult> {
  try {
    await provisionGuestAuthConfigToConvex();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to provision Convex guest auth env: ${errMsg}`
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
    context?.body?.mode
  );
}

/**
 * Server-only fetch helper used by inspector services that need a guest
 * bearer token without browser context (no cookie, no UA). Returns
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

function getConvexGuestSessionRevokeUrl(): string {
  return buildConvexGuestUrl("/guest/session/revoke");
}

function getConvexGuestPromotionProofUrl(): string {
  return buildConvexGuestUrl("/guest/promotion-proof");
}

function getRemoteGuestPromotionProofUrl(): string {
  const override = process.env.MCPJAM_GUEST_PROMOTION_PROOF_URL;
  if (override) return override;
  const baseUrl = getRemoteGuestSessionUrl();
  if (baseUrl.endsWith("/guest-session")) {
    return `${baseUrl}/promotion-proof`;
  }
  return `${baseUrl.replace(/\/$/, "")}/promotion-proof`;
}

function getRemoteGuestSessionRevokeUrl(): string {
  const override = process.env.MCPJAM_GUEST_SESSION_REVOKE_URL;
  if (override) return override;
  // Derive from the lookup URL when only the lookup URL is overridden.
  const baseUrl = getRemoteGuestSessionUrl();
  if (baseUrl.endsWith("/guest-session")) {
    return `${baseUrl}/revoke`;
  }
  return `${baseUrl.replace(/\/$/, "")}/revoke`;
}

export type GuestSessionRevokeResult = {
  status: number;
  setCookies: string[];
  body: { revoked: boolean } | null;
};

async function performGuestSessionRevoke(
  url: string,
  init: RequestInit,
  source: "Convex" | "MCPJam"
): Promise<GuestSessionRevokeResult> {
  try {
    const response = await fetch(url, init);
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
        `[guest-auth] ${source} guest session revoke returned ${response.status} ${response.statusText}`
      );
    }
    return { status: response.status, setCookies, body };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to revoke guest session via ${source}: ${errMsg}`
    );
    return { status: 503, setCookies: [], body: null };
  }
}

export async function fetchConvexGuestSessionRevoke(
  context?: GuestSessionFetchContext
): Promise<GuestSessionRevokeResult> {
  try {
    await provisionGuestAuthConfigToConvex();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to provision Convex guest auth env: ${errMsg}`
    );
    return { status: 503, setCookies: [], body: null };
  }

  return performGuestSessionRevoke(
    getConvexGuestSessionRevokeUrl(),
    {
      method: "POST",
      headers: buildForwardedHeaders(context, {
        [GUEST_SESSION_SECRET_HEADER]: getGuestSessionSharedSecret(),
      }),
      signal: AbortSignal.timeout(10_000),
    },
    "Convex"
  );
}

export async function fetchRemoteGuestSessionRevoke(
  context?: GuestSessionFetchContext
): Promise<GuestSessionRevokeResult> {
  return performGuestSessionRevoke(
    getRemoteGuestSessionRevokeUrl(),
    {
      method: "POST",
      headers: buildForwardedHeaders(context, {}),
      signal: AbortSignal.timeout(10_000),
    },
    "MCPJam"
  );
}

export type GuestPromotionProofResult =
  | {
      kind: "proof";
      proof: { guestId?: string; token: string; expiresAt: number };
    }
  | { kind: "miss" }
  | { kind: "revoked"; setCookies: string[] }
  | { kind: "error"; status: number };

async function performGuestPromotionProofFetch(
  url: string,
  init: RequestInit,
  source: "Convex" | "MCPJam"
): Promise<GuestPromotionProofResult> {
  try {
    const response = await fetch(url, init);
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
        `[guest-auth] ${source} guest promotion proof returned 403 ${response.statusText}`
      );
      return { kind: "error", status: 403 };
    }
    if (!response.ok) {
      logger.warn(
        `[guest-auth] ${source} guest promotion proof returned ${response.status} ${response.statusText}`
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
        `[guest-auth] ${source} guest promotion proof response was missing token or expiresAt`
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
      `[guest-auth] Failed to fetch ${source} guest promotion proof: ${errMsg}`
    );
    return { kind: "error", status: 503 };
  }
}

export async function fetchConvexGuestPromotionProof(
  context?: GuestSessionFetchContext
): Promise<GuestPromotionProofResult> {
  try {
    await provisionGuestAuthConfigToConvex();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[guest-auth] Failed to provision Convex guest auth env: ${errMsg}`
    );
    return { kind: "error", status: 503 };
  }

  return performGuestPromotionProofFetch(
    getConvexGuestPromotionProofUrl(),
    {
      method: "POST",
      headers: buildForwardedHeaders(context, {
        [GUEST_SESSION_SECRET_HEADER]: getGuestSessionSharedSecret(),
      }),
      signal: AbortSignal.timeout(10_000),
    },
    "Convex"
  );
}

export async function fetchRemoteGuestPromotionProof(
  context?: GuestSessionFetchContext
): Promise<GuestPromotionProofResult> {
  return performGuestPromotionProofFetch(
    getRemoteGuestPromotionProofUrl(),
    {
      method: "POST",
      headers: buildForwardedHeaders(context, {}),
      signal: AbortSignal.timeout(10_000),
    },
    "MCPJam"
  );
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
