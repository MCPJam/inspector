/**
 * Resolve an OAuth client profile from the catalog (HP-43 step 3).
 *
 * This is the piece that turns "emulate client X" into a profile the engine
 * can compile. The catalog itself lives in the private backend; the inspector
 * proxies it at `/api/v1/oauth-profiles*` so the OSS SDK and CLI never learn a
 * `*.convex.site` address.
 *
 * Two properties, both deliberate:
 *
 *  1. **Never throws.** Every failure collapses to `{ok: false, reason}` so a
 *     caller can report it rather than crash mid-run.
 *  2. **No fallback.** Unlike the host-compat catalog there is no bundled copy
 *     to degrade to — bundling profiles would put client names in public
 *     source. `ok: false` therefore means "this client cannot be emulated
 *     right now", never "something else was used instead". Callers must
 *     surface it; silently continuing would report a coverage summary and a
 *     comparison for a client that was never emulated.
 */

import { DEFAULT_PLATFORM_API_BASE_URL } from "../../platform/client.js";
import { canonicalizeOAuthProfile } from "../../host-config/canonicalize.js";
import type { HostConfigOAuthProfile } from "../../host-config/types.js";
import {
  computeOAuthProfileDigest,
  oauthProfileEnvelopeSchema,
  oauthProfileListEnvelopeSchema,
  SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION,
  type OAuthProfileSummary,
} from "./profile-catalog.js";

export interface FetchOAuthProfileOptions {
  /** API origin + version prefix. Defaults to the hosted production API. */
  baseUrl?: string;
  /** Bearer token. These routes are authenticated — the catalog is not public. */
  authToken?: string;
  /** Abort the whole exchange after this long. Default 5000ms. */
  timeoutMs?: number;
  /** Injectable for tests / non-global-fetch runtimes. */
  fetchImpl?: typeof fetch;
}

/**
 * Why a profile could not be resolved.
 *
 *   `network`        — the request failed outright.
 *   `timeout`        — aborted at `timeoutMs`.
 *   `unauthorized`   — 401/403; the catalog requires credentials.
 *   `not_found`      — no such client in the catalog.
 *   `unavailable`    — any other non-2xx (e.g. 503 catalog-not-seeded).
 *   `invalid`        — body was not a parseable envelope, or the profile did
 *                      not survive canonicalization.
 *   `digest_mismatch`— the profile bytes do not hash to the digest the catalog
 *                      asserted. See the contract doc: a wrong digest would
 *                      let a capture of one client be compared against a run
 *                      of another and reported as a match.
 */
export type FetchOAuthProfileFailureReason =
  | "network"
  | "timeout"
  | "unauthorized"
  | "not_found"
  | "unavailable"
  | "invalid"
  | "digest_mismatch";

export type FetchOAuthProfileResult =
  | {
      ok: true;
      clientId: string;
      clientVersion?: string;
      /** Canonicalized — ready for `deriveOAuthEmulation`. */
      profile: HostConfigOAuthProfile;
      /** Verified locally, not merely echoed from the catalog. */
      profileDigest: string;
      catalogRevision: string;
    }
  | { ok: false; reason: FetchOAuthProfileFailureReason; detail?: string };

export type FetchOAuthProfileCatalogResult =
  | {
      ok: true;
      entries: OAuthProfileSummary[];
      catalogRevision: string;
    }
  | { ok: false; reason: FetchOAuthProfileFailureReason; detail?: string };

interface RawFetch {
  status: number;
  body: unknown;
}

/** Perform the request, mapping every failure onto a reason. Never throws. */
async function requestCatalog(
  path: string,
  options: FetchOAuthProfileOptions | undefined
): Promise<
  { ok: true; response: RawFetch } | { ok: false; reason: FetchOAuthProfileFailureReason }
> {
  const baseUrl = (options?.baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL).replace(
    /\/+$/u,
    ""
  );
  const timeoutMs = options?.timeoutMs ?? 5000;
  // Read through `globalThis` so a runtime without a fetch binding yields
  // undefined rather than throwing outside the try — the never-throws contract
  // must hold everywhere. Bind it too: a detached `fetch` throws "Illegal
  // invocation" in browsers and workers.
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "network" };
  }

  // The deadline must cover the body read: `fetch` resolves on headers, so
  // clearing the timer early would leave a stalled body free to hang.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(options?.authToken
          ? { authorization: `Bearer ${options.authToken}` }
          : {}),
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (response.status === 404) {
      return { ok: false, reason: "not_found" };
    }
    if (!response.ok) {
      return { ok: false, reason: "unavailable" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A body that aborts past the deadline is a timeout, not malformed JSON.
      if (controller.signal.aborted) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, response: { status: response.status, body } };
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}

function schemaVersionDetail(body: unknown): string | undefined {
  const version =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  return typeof version === "number" &&
    version !== SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION
    ? `catalog schema version ${version} is not supported by this SDK (expected ${SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION})`
    : undefined;
}

/** List what can be emulated. Metadata only — no profile bodies. */
export async function fetchOAuthProfileCatalog(
  options?: FetchOAuthProfileOptions
): Promise<FetchOAuthProfileCatalogResult> {
  const raw = await requestCatalog("/oauth-profiles", options);
  if (!raw.ok) return raw;

  const parsed = oauthProfileListEnvelopeSchema.safeParse(raw.response.body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      ...(schemaVersionDetail(raw.response.body)
        ? { detail: schemaVersionDetail(raw.response.body) }
        : {}),
    };
  }

  return {
    ok: true,
    entries: parsed.data.entries,
    catalogRevision: parsed.data.catalogRevision,
  };
}

/**
 * Resolve one client's profile, canonicalized and digest-verified.
 *
 * `clientId` is path-encoded: it is catalog data, and letting it interpolate
 * raw would let a crafted id reach a different route.
 */
export async function fetchOAuthProfile(
  clientId: string,
  options?: FetchOAuthProfileOptions
): Promise<FetchOAuthProfileResult> {
  if (!clientId.trim()) {
    return { ok: false, reason: "invalid", detail: "clientId is required" };
  }

  const raw = await requestCatalog(
    `/oauth-profiles/${encodeURIComponent(clientId)}`,
    options
  );
  if (!raw.ok) return raw;

  const parsed = oauthProfileEnvelopeSchema.safeParse(raw.response.body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      ...(schemaVersionDetail(raw.response.body)
        ? { detail: schemaVersionDetail(raw.response.body) }
        : {}),
    };
  }

  // Canonicalize through the SAME function the backend used. A profile that
  // would not survive canonicalization is a data bug, and half-enforcing it
  // would emulate a client that does not exist.
  let profile: HostConfigOAuthProfile;
  try {
    const canonical = canonicalizeOAuthProfile(
      parsed.data.profile as HostConfigOAuthProfile
    );
    if (!canonical) {
      return { ok: false, reason: "invalid", detail: "profile was empty" };
    }
    profile = canonical;
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // Recompute rather than trust. The digest gates the golden-trace
  // comparator's binding check, so accepting an asserted one would let a
  // capture of one client be diffed against a run of another.
  const digest = await computeOAuthProfileDigest(profile);
  if (digest !== parsed.data.profileDigest) {
    return {
      ok: false,
      reason: "digest_mismatch",
      detail: `catalog asserted ${parsed.data.profileDigest}, profile hashes to ${digest}`,
    };
  }

  return {
    ok: true,
    clientId: parsed.data.clientId,
    ...(parsed.data.clientVersion
      ? { clientVersion: parsed.data.clientVersion }
      : {}),
    profile,
    profileDigest: digest,
    catalogRevision: parsed.data.catalogRevision,
  };
}
