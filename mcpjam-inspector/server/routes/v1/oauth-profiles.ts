/**
 * `GET /api/v1/oauth-profiles` and `/api/v1/oauth-profiles/:clientId` — the
 * stable public URLs for the OAuth client profile catalog (HP-43).
 *
 * The OSS SDK/CLI never learn a `*.convex.site` address: this route is the one
 * public host, proxying the backend's profile catalog.
 *
 * Two deliberate differences from `/v1/host-catalog`, the closest analogue:
 *
 *   - **Authenticated.** Host-compat data is public metadata; a per-client
 *     OAuth evidence catalog is not. This mounts AFTER the bearer middleware
 *     and is deliberately absent from the guest allowlist, so anonymous
 *     callers cannot enumerate the catalog.
 *   - **No bundled fallback, no serve-stale.** There is no bundled copy to
 *     degrade to — bundling profiles would put client names in public source.
 *     An upstream failure is reported as a failure, because "emulate some
 *     other client than the one you asked for" is never an acceptable
 *     degradation: it would silently invalidate every coverage and comparison
 *     claim the run goes on to make.
 *
 * See docs/host-oauth-profiles/profile-catalog-contract.md.
 */
import { Hono, type Context } from "hono";
import { assertBearerToken } from "../web/errors.js";
import {
  buildConvexAuthHeaders,
  callerContextFromHono,
} from "../web/auth.js";
import { logger } from "../../utils/logger.js";
import { v1Error } from "./envelope.js";

const oauthProfiles = new Hono();

const UPSTREAM_TIMEOUT_MS = 6_500;

type ProxyFailure = {
  code: "NOT_FOUND" | "FORBIDDEN" | "SERVER_UNREACHABLE" | "INTERNAL_ERROR";
  message: string;
};

/**
 * Proxy one upstream GET. Returns the parsed body, or a typed failure the
 * caller maps onto a v1 error — never a silent fallback.
 */
async function proxyUpstream(
  c: Context,
  upstreamPath: string
): Promise<{ ok: true; body: unknown } | { ok: false; failure: ProxyFailure }> {
  const convexUrl = process.env.CONVEX_HTTP_URL?.trim();
  if (!convexUrl) {
    return {
      ok: false,
      failure: {
        code: "INTERNAL_ERROR",
        message:
          "The OAuth profile catalog is not configured for this deployment (CONVEX_HTTP_URL is unset).",
      },
    };
  }

  const bearerToken = assertBearerToken(c);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(upstreamPath, convexUrl), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...buildConvexAuthHeaders(callerContextFromHono(c), bearerToken),
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        ok: false,
        failure: {
          code: "NOT_FOUND",
          message: "No OAuth client profile with that id.",
        },
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        failure: {
          code: "FORBIDDEN",
          message: "Not authorized to read the OAuth profile catalog.",
        },
      };
    }
    if (!response.ok) {
      logger.warn("[oauth-profiles] upstream returned non-2xx", {
        status: response.status,
        upstreamPath,
      });
      return {
        ok: false,
        failure: {
          code: "SERVER_UNREACHABLE",
          message: "The OAuth profile catalog is temporarily unavailable.",
        },
      };
    }

    return { ok: true, body: await response.json() };
  } catch (error) {
    logger.warn("[oauth-profiles] upstream fetch failed", {
      error: error instanceof Error ? error.name : typeof error,
      upstreamPath,
    });
    return {
      ok: false,
      failure: {
        code: "SERVER_UNREACHABLE",
        message: "The OAuth profile catalog could not be reached.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

oauthProfiles.get("/oauth-profiles", async (c) => {
  const result = await proxyUpstream(c, "/public/oauth-profiles");
  if (!result.ok) {
    return v1Error(c, result.failure.code, result.failure.message);
  }
  // Contents change on publish, not per request — but they are per-account
  // authorized, so never let a shared cache hold them.
  c.header("Cache-Control", "private, max-age=60");
  return c.json(result.body as Record<string, unknown>);
});

oauthProfiles.get("/oauth-profiles/:clientId", async (c) => {
  const clientId = c.req.param("clientId");
  if (!clientId?.trim()) {
    return v1Error(c, "VALIDATION_ERROR", "clientId is required.");
  }
  const result = await proxyUpstream(
    c,
    `/public/oauth-profiles/${encodeURIComponent(clientId)}`
  );
  if (!result.ok) {
    return v1Error(c, result.failure.code, result.failure.message);
  }
  c.header("Cache-Control", "private, max-age=60");
  return c.json(result.body as Record<string, unknown>);
});

export default oauthProfiles;
