/**
 * The ONE guest authority this Inspector talks to.
 *
 * A guest identity is a pair: an opaque session cookie that the authority's
 * `/guest/session` resolves, and a short-lived RS256 bearer the authority
 * signs. Every endpoint that touches that identity — mint, lookup, promotion
 * proof, revoke — and the JWKS that verifies its bearers must belong to the
 * SAME authority. Mixing them is how a guest minted by one backend ended up
 * verified against another backend's keys, or a lookup fell through to a
 * different backend that then created a replacement guest.
 *
 * So the authority is resolved once, from configuration, and every guest call
 * goes through the record this module returns. There is no runtime fallback
 * from one authority to another: a misconfigured authority is a configuration
 * error, not a reason to quietly try someone else's.
 *
 * Two kinds:
 *
 *   - `backend`: the Convex deployment this Inspector is configured with
 *     (`CONVEX_HTTP_URL`), called directly with the deployment's guest-session
 *     shared secret. Hosted Inspector uses this, and so does a developer whose
 *     profile carries their own deployment's secret (`dev:setup-guest-auth`).
 *     The secret is a backend credential: it comes from the selected profile's
 *     environment and nowhere else — never generated, never read from
 *     `~/.mcpjam`, never inherited from another target.
 *
 *   - `hosted`: a hosted Inspector's public guest routes
 *     (`https://app.mcpjam.com/api/web/guest-session` and its siblings). This is
 *     the standard OSS profile's authority and needs no developer secrets. Its
 *     JWKS is the hosted Inspector's `/api/web/guest-jwks` — the same keys the
 *     platform MCP worker verifies against — not this Inspector's
 *     `CONVEX_HTTP_URL`, which may be an unrelated backend.
 *
 * Selection (first match wins):
 *
 *   1. `MCPJAM_GUEST_AUTHORITY=backend|hosted` — explicit.
 *   2. Hosted mode → `backend`.
 *   3. `MCPJAM_GUEST_SESSION_URL` set → `hosted` (the legacy override).
 *   4. `MCPJAM_GUEST_SESSION_SHARED_SECRET` set → `backend`.
 *   5. Otherwise → `hosted` at `https://app.mcpjam.com`.
 */

/** Header carrying the backend shared secret on direct Convex guest calls. */
export const GUEST_SESSION_SECRET_HEADER = "x-mcpjam-guest-session-secret";

export const DEFAULT_HOSTED_GUEST_AUTHORITY_ORIGIN = "https://app.mcpjam.com";

export type GuestAuthorityKind = "backend" | "hosted";

export interface GuestAuthority {
  kind: GuestAuthorityKind;
  /**
   * Stable identity of the authority (`backend:<origin>` / `hosted:<origin>`).
   * Safe to log: it names an origin, never a credential.
   */
  id: string;
  /** Origin every endpoint below belongs to. */
  origin: string;
  sessionUrl: string;
  revokeUrl: string;
  promotionProofUrl: string;
  jwksUrl: string;
  /** Present for `backend` only; sent as `GUEST_SESSION_SECRET_HEADER`. */
  sharedSecret?: string;
}

/**
 * The guest authority cannot be resolved from this configuration. Raised at
 * startup by the runtime-config check and per call by the guest helpers, so a
 * misconfiguration surfaces as an actionable message instead of a guest minted
 * by the wrong backend.
 */
export class GuestAuthorityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuestAuthorityConfigError";
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseHttpUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuestAuthorityConfigError(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GuestAuthorityConfigError(`${name} must be an http(s) URL.`);
  }
  return url;
}

function sameOriginOrThrow(
  authorityOrigin: string,
  name: string,
  raw: string,
): string {
  const url = parseHttpUrl(name, raw);
  if (url.origin !== authorityOrigin) {
    throw new GuestAuthorityConfigError(
      `${name} (${url.origin}) does not belong to the selected guest authority ` +
        `(${authorityOrigin}). Every guest endpoint must come from one authority; ` +
        `unset ${name} or select the authority it belongs to.`,
    );
  }
  return url.toString();
}

function selectKind(env: NodeJS.ProcessEnv): GuestAuthorityKind {
  const explicit = nonEmpty(env.MCPJAM_GUEST_AUTHORITY);
  if (explicit) {
    if (explicit === "backend" || explicit === "hosted") return explicit;
    throw new GuestAuthorityConfigError(
      `MCPJAM_GUEST_AUTHORITY must be "backend" or "hosted" (got "${explicit}").`,
    );
  }
  if (env.VITE_MCPJAM_HOSTED_MODE === "true") return "backend";
  if (nonEmpty(env.MCPJAM_GUEST_SESSION_URL)) return "hosted";
  if (nonEmpty(env.MCPJAM_GUEST_SESSION_SHARED_SECRET)) return "backend";
  return "hosted";
}

function resolveBackendAuthority(env: NodeJS.ProcessEnv): GuestAuthority {
  const rawHttpUrl = nonEmpty(env.CONVEX_HTTP_URL);
  if (!rawHttpUrl) {
    throw new GuestAuthorityConfigError(
      "The backend guest authority needs CONVEX_HTTP_URL.",
    );
  }
  const origin = parseHttpUrl("CONVEX_HTTP_URL", rawHttpUrl).origin;
  const sharedSecret = nonEmpty(env.MCPJAM_GUEST_SESSION_SHARED_SECRET);
  if (!sharedSecret) {
    throw new GuestAuthorityConfigError(
      `The backend guest authority (${origin}) needs MCPJAM_GUEST_SESSION_SHARED_SECRET ` +
        "from the selected profile. Run `npm run dev:setup-guest-auth -- --deployment dev:<name>` " +
        "for your own development deployment, or select the hosted guest authority " +
        "(MCPJAM_GUEST_AUTHORITY=hosted).",
    );
  }
  const jwksUrl = new URL("/guest/jwks", origin).toString();
  const configuredJwks = nonEmpty(env.MCPJAM_GUEST_JWKS_URL);
  if (
    configuredJwks &&
    parseHttpUrl("MCPJAM_GUEST_JWKS_URL", configuredJwks).toString() !== jwksUrl
  ) {
    throw new GuestAuthorityConfigError(
      `MCPJAM_GUEST_JWKS_URL points away from the backend guest authority's own ` +
        `JWKS (${jwksUrl}). A backend authority verifies with its own keys; unset it.`,
    );
  }
  return {
    kind: "backend",
    id: `backend:${origin}`,
    origin,
    sessionUrl: new URL("/guest/session", origin).toString(),
    revokeUrl: new URL("/guest/session/revoke", origin).toString(),
    promotionProofUrl: new URL("/guest/promotion-proof", origin).toString(),
    jwksUrl,
    sharedSecret,
  };
}

function resolveHostedAuthority(env: NodeJS.ProcessEnv): GuestAuthority {
  const sessionOverride = nonEmpty(env.MCPJAM_GUEST_SESSION_URL);
  const explicitOrigin = nonEmpty(env.MCPJAM_GUEST_AUTHORITY_ORIGIN);
  const origin = explicitOrigin
    ? parseHttpUrl("MCPJAM_GUEST_AUTHORITY_ORIGIN", explicitOrigin).origin
    : sessionOverride
      ? parseHttpUrl("MCPJAM_GUEST_SESSION_URL", sessionOverride).origin
      : DEFAULT_HOSTED_GUEST_AUTHORITY_ORIGIN;

  const sessionUrl = sessionOverride
    ? sameOriginOrThrow(origin, "MCPJAM_GUEST_SESSION_URL", sessionOverride)
    : new URL("/api/web/guest-session", origin).toString();
  const base = sessionUrl.replace(/\/+$/, "");

  const revokeOverride = nonEmpty(env.MCPJAM_GUEST_SESSION_REVOKE_URL);
  const proofOverride = nonEmpty(env.MCPJAM_GUEST_PROMOTION_PROOF_URL);
  const jwksOverride = nonEmpty(env.MCPJAM_GUEST_JWKS_URL);

  return {
    kind: "hosted",
    id: `hosted:${origin}`,
    origin,
    sessionUrl,
    revokeUrl: revokeOverride
      ? sameOriginOrThrow(
          origin,
          "MCPJAM_GUEST_SESSION_REVOKE_URL",
          revokeOverride,
        )
      : `${base}/revoke`,
    promotionProofUrl: proofOverride
      ? sameOriginOrThrow(
          origin,
          "MCPJAM_GUEST_PROMOTION_PROOF_URL",
          proofOverride,
        )
      : `${base}/promotion-proof`,
    jwksUrl: jwksOverride
      ? sameOriginOrThrow(origin, "MCPJAM_GUEST_JWKS_URL", jwksOverride)
      : new URL("/api/web/guest-jwks", origin).toString(),
  };
}

/** Pure resolution; throws `GuestAuthorityConfigError`. */
export function resolveGuestAuthority(
  env: NodeJS.ProcessEnv = process.env,
): GuestAuthority {
  return selectKind(env) === "backend"
    ? resolveBackendAuthority(env)
    : resolveHostedAuthority(env);
}

let cached: { authority: GuestAuthority } | { error: Error } | undefined;

/**
 * The process's guest authority. Resolved on first use and then fixed: the
 * authority is configuration, and a process that changed authorities halfway
 * through would verify yesterday's guests against today's keys.
 */
export function getGuestAuthority(): GuestAuthority {
  if (!cached) {
    try {
      cached = { authority: resolveGuestAuthority(process.env) };
    } catch (error) {
      cached = { error: error as Error };
    }
  }
  if ("error" in cached) throw cached.error;
  return cached.authority;
}

/** Non-throwing variant for diagnostics and startup checks. */
export function tryGetGuestAuthority():
  { ok: true; authority: GuestAuthority } | { ok: false; error: Error } {
  try {
    return { ok: true, authority: getGuestAuthority() };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

/** Test seam: forget the resolved authority so a test can change the env. */
export function resetGuestAuthorityForTests(): void {
  cached = undefined;
}

let reported = false;

/**
 * One startup line naming the selected guest authority (its kind and origin —
 * never a credential), or the configuration error that will make every guest
 * call fail. Called once per process from both server entry points.
 */
export function logGuestAuthorityOnce(log: {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): void {
  if (reported) return;
  reported = true;
  const resolved = tryGetGuestAuthority();
  if (resolved.ok) {
    log.info("[guest-auth] Guest authority selected", {
      event: "guest_auth.authority_selected",
      kind: resolved.authority.kind,
      origin: resolved.authority.origin,
    });
  } else {
    log.warn("[guest-auth] Guest authority is not configured", {
      event: "guest_auth.authority_config_error",
      message: resolved.error.message,
    });
  }
}
