import type { Context } from "hono";
import {
  fetchGuestSession,
  type GuestSessionFetchContext,
  type GuestSessionFetchResult,
} from "../../utils/guest-session-source.js";
import {
  applyScopedCookieWrites,
  currentNamespace,
  readOwnScopedCookie,
} from "../../utils/scoped-cookie-context.js";
import {
  buildDeletionCookie,
  parseCookieHeader,
  sealScopedCookie,
  unsealScopedCookie,
  type ScopedCookieWrite,
} from "../../utils/scoped-cookies.js";
import { logger } from "../../utils/logger.js";

/**
 * The guest cookie on a LOCAL (loopback) Inspector.
 *
 * The guest authority identifies a browser's guest by an opaque cookie it
 * sets as `__Host-mcpjam_guest_session`. Locally that cookie used to be passed
 * straight through (plus a de-prefixed `mcpjam_guest_session` twin for plain
 * http), which put ONE guest identity on the whole `localhost` cookie host:
 * every instance — on any port, against any backend — presented it.
 *
 * Now the opaque value is kept in this namespace's sealed `mcpjam_gst_<ns>`
 * cookie, and that is the only guest cookie a local response emits. The
 * authority still sees exactly the cookie it set; the browser just stores it
 * per instance.
 *
 * MIGRATION. A browser upgrading from the shared cookie still carries one or
 * both legacy names. When this namespace has no guest cookie yet, each
 * distinct legacy value is offered to the selected authority with
 * `lookup_only` — which never creates a guest. A match is adopted into the
 * scoped cookie, so the guest keeps its data. A miss (another backend's guest,
 * or one this authority no longer knows) is left exactly where it is: not
 * reused, and not deleted, since it may belong to an instance still running
 * the old version. A lookup that FAILS rather than misses stops the request
 * instead of minting a replacement that would orphan the real guest.
 */

export const UPSTREAM_GUEST_COOKIE_NAME = "__Host-mcpjam_guest_session";
export const LEGACY_LOCAL_GUEST_COOKIE_NAMES = [
  "mcpjam_guest_session",
  UPSTREAM_GUEST_COOKIE_NAME,
] as const;

/** Used only when the authority's cookie names no lifetime of its own. */
const DEFAULT_UPSTREAM_GUEST_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/** Upper bound on an opaque guest cookie value we will forward or store. */
const MAX_GUEST_COOKIE_VALUE_LENGTH = 512;

type ScopedGuestPayload = { upstream: string };

export function upstreamGuestCookieHeader(value: string): string {
  return `${UPSTREAM_GUEST_COOKIE_NAME}=${value}`;
}

function isPlausibleCookieValue(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_GUEST_COOKIE_VALUE_LENGTH &&
    /^[A-Za-z0-9._~\-]+$/.test(value)
  );
}

/**
 * The guest cookie the authority set in one of its `Set-Cookie` headers:
 * `{ value, maxAgeSeconds }`, `{ cleared: true }` for an expiring one, or null
 * when it set none.
 */
export function parseUpstreamGuestSetCookie(
  setCookies: readonly string[],
  nowMs: number = Date.now(),
):
  | { kind: "set"; value: string; maxAgeSeconds: number }
  | { kind: "cleared" }
  | null {
  for (const header of setCookies) {
    const [nameValue, ...attributes] = header.split(";").map((p) => p.trim());
    if (!nameValue?.startsWith(`${UPSTREAM_GUEST_COOKIE_NAME}=`)) continue;
    const value = nameValue.slice(UPSTREAM_GUEST_COOKIE_NAME.length + 1);
    let maxAgeSeconds: number | null = null;
    for (const attribute of attributes) {
      const [rawKey, ...rest] = attribute.split("=");
      const key = rawKey?.trim().toLowerCase();
      const attrValue = rest.join("=").trim();
      if (key === "max-age") {
        const parsed = Number.parseInt(attrValue, 10);
        if (Number.isFinite(parsed)) maxAgeSeconds = parsed;
      } else if (key === "expires" && maxAgeSeconds === null) {
        const at = Date.parse(attrValue);
        if (Number.isFinite(at)) {
          maxAgeSeconds = Math.floor((at - nowMs) / 1000);
        }
      }
    }
    if (!value || (maxAgeSeconds !== null && maxAgeSeconds <= 0)) {
      return { kind: "cleared" };
    }
    if (!isPlausibleCookieValue(value)) return null;
    return {
      kind: "set",
      value,
      maxAgeSeconds: maxAgeSeconds ?? DEFAULT_UPSTREAM_GUEST_COOKIE_MAX_AGE_S,
    };
  }
  return null;
}

/** The opaque upstream value stored in this namespace's guest cookie. */
export function readScopedGuestUpstream(c: Context): string | null {
  const opened = unsealScopedCookie({
    kind: "guest",
    nsId: currentNamespace().id,
    value: readOwnScopedCookie(c, "guest"),
  }) as Partial<ScopedGuestPayload> | null;
  return opened && isPlausibleCookieValue(opened.upstream)
    ? opened.upstream
    : null;
}

export function scopedGuestWrite(
  upstream: string,
  maxAgeSeconds: number,
  nowMs: number = Date.now(),
): ScopedCookieWrite {
  return {
    kind: "guest",
    value: sealScopedCookie({
      kind: "guest",
      nsId: currentNamespace().id,
      payload: { upstream } satisfies ScopedGuestPayload,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + maxAgeSeconds * 1000,
    }),
    maxAgeSeconds,
  };
}

/**
 * Mirror what the authority did to its cookie onto this namespace's scoped
 * cookie. Upstream `Set-Cookie` headers themselves are never passed through.
 */
export function applyUpstreamGuestCookies(
  c: Context,
  setCookies: readonly string[],
): void {
  const upstream = parseUpstreamGuestSetCookie(setCookies);
  if (!upstream) return;
  applyScopedCookieWrites(c, [
    upstream.kind === "set"
      ? scopedGuestWrite(upstream.value, upstream.maxAgeSeconds)
      : { kind: "guest", value: null },
  ]);
}

export function clearScopedGuestCookie(c: Context): void {
  applyScopedCookieWrites(c, [{ kind: "guest", value: null }]);
}

/** Distinct legacy guest cookie values this browser still sends. */
export function legacyGuestCookieValues(c: Context): string[] {
  const cookies = parseCookieHeader(c.req.header("cookie"));
  const values: string[] = [];
  for (const name of LEGACY_LOCAL_GUEST_COOKIE_NAMES) {
    const value = cookies.get(name);
    if (isPlausibleCookieValue(value) && !values.includes(value)) {
      values.push(value);
    }
  }
  return values;
}

/**
 * Delete the legacy cookies holding exactly `upstream` — an identity that was
 * matched and is now being revoked. Unmatched legacy cookies are left alone.
 */
export function deleteMatchedLegacyGuestCookies(
  c: Context,
  upstream: string,
): void {
  const cookies = parseCookieHeader(c.req.header("cookie"));
  for (const name of LEGACY_LOCAL_GUEST_COOKIE_NAMES) {
    if (cookies.get(name) !== upstream) continue;
    c.header(
      "Set-Cookie",
      buildDeletionCookie(name, name.startsWith("__Host-")),
      { append: true },
    );
  }
}

export type LocalGuestCookieResolution =
  /** This namespace already has a guest, or none could be migrated. */
  | { kind: "cookie"; upstream: string | null }
  /** A legacy guest was matched and adopted; `result` is its session. */
  | {
      kind: "migrated";
      upstream: string;
      result: Extract<GuestSessionFetchResult, { kind: "session" }>;
    }
  /** A legacy lookup failed (not a miss); do not mint a replacement. */
  | {
      kind: "lookup_failed";
      result: Extract<GuestSessionFetchResult, { kind: "error" }>;
    };

/**
 * Which guest this local request is about, migrating a legacy one if this
 * namespace has none. Writes the scoped cookie for a migrated guest.
 */
export async function resolveLocalGuestCookie(
  c: Context,
  base: Omit<GuestSessionFetchContext, "cookie" | "body">,
  timeoutMs?: number,
): Promise<LocalGuestCookieResolution> {
  const scoped = readScopedGuestUpstream(c);
  if (scoped) return { kind: "cookie", upstream: scoped };

  for (const legacy of legacyGuestCookieValues(c)) {
    const result = await fetchGuestSession(
      {
        ...base,
        cookie: upstreamGuestCookieHeader(legacy),
        body: { mode: "lookup_only" },
      },
      timeoutMs,
    );
    if (result.kind === "session") {
      const upstream = parseUpstreamGuestSetCookie(result.setCookies);
      const adopted =
        upstream?.kind === "set"
          ? upstream
          : {
              kind: "set" as const,
              value: legacy,
              maxAgeSeconds: DEFAULT_UPSTREAM_GUEST_COOKIE_MAX_AGE_S,
            };
      applyScopedCookieWrites(c, [
        scopedGuestWrite(adopted.value, adopted.maxAgeSeconds),
      ]);
      logger.info("Migrated a legacy local guest cookie", {
        event: "guest_auth.legacy_cookie_migrated",
        namespace: currentNamespace().id,
      });
      return { kind: "migrated", upstream: adopted.value, result };
    }
    if (result.kind === "error" && result.status !== 403) {
      logger.warn(
        "Legacy guest cookie lookup failed; not minting a replacement",
        {
          event: "guest_auth.legacy_cookie_lookup_failed",
          namespace: currentNamespace().id,
          status: result.status,
          reason: result.reason,
        },
      );
      return { kind: "lookup_failed", result };
    }
    // A miss, or a revoked legacy guest: not this authority's live guest.
  }
  return { kind: "cookie", upstream: null };
}
