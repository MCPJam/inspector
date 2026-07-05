import { Hono } from "hono";
import { z } from "zod";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { logger } from "../../utils/logger.js";
import {
  ErrorCode,
  WebRouteError,
  webError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  statusToErrorCode,
} from "./errors.js";
import { handleRoute } from "./auth.js";

/**
 * `/api/web/api-keys/*` — platform API key management (`sk_mcpjam_…`).
 *
 * Thin forwarding layer over the backend's `/web/api-keys` routes. The caller's
 * session bearer is passed through verbatim; Convex verifies the AuthKit JWT,
 * checks org membership, mints/lists/revokes, and stores only the key's hash.
 * Because auth is the forwarded user bearer (not a server-side secret), this
 * works identically hosted, local, and via npx — no WorkOS, no proxy.
 *
 * MCPJam never sees the raw key again after mint: the backend returns the
 * plaintext `value` once in the create response, surfaced to the browser and
 * never persisted or logged.
 *
 * Security notes:
 * - `sk_…` keys cannot manage other keys (privilege isolation) — rejected
 *   here before the bearer is even forwarded, and again on the backend.
 * - Ownership is enforced on the backend: list returns only the caller's keys;
 *   revoke of a foreign/unknown id reads as 404.
 */

const apiKeys = new Hono();

// Privilege isolation: a platform API key authenticates as the owning user but
// must NOT mint or revoke other keys (privilege loop). Reject `sk_…` BEFORE
// bearerAuthMiddleware validates it — `sk_` is the same unambiguous
// discriminator the middleware uses, so this short-circuits a request that
// always ends in 403. (Bonus: invalid/revoked keys get the same 403, not a
// 401, so the endpoint can't be used to probe key validity.)
apiKeys.use("*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer sk_")) {
    return c.json(
      {
        code: ErrorCode.FORBIDDEN,
        message: "API keys cannot manage other API keys",
      },
      403,
    );
  }
  return next();
});

// `sessionAuthMiddleware` bypasses `/api/web/*` entirely (session-auth.ts:103),
// so this sub-router must explicitly require a bearer.
apiKeys.use("*", bearerAuthMiddleware);

const REMOTE_PROXY_TIMEOUT_MS = 30_000;

interface BackendKey {
  id: string;
  name: string;
  obfuscatedValue: string;
  createdAt: number;
  lastUsedAt?: number | null;
  value?: string;
}

/**
 * Forward a management request to the backend's `/web/api-keys` route with the
 * caller's bearer. Returns the parsed JSON and status; maps a backend error
 * status onto the matching `WebRouteError` so the client sees the same shapes
 * as before. Transport failure → 502 SERVER_UNREACHABLE.
 */
async function callBackendApiKeys(
  method: string,
  pathAndQuery: string,
  bearer: string,
  body?: unknown,
): Promise<any> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  const target = `${convexUrl}/web/api-keys${pathAndQuery}`;

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REMOTE_PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error("API key backend request failed", {
      method,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Could not reach the MCPJam backend to manage API keys",
    );
  }

  const parsed = (await response.json().catch(() => null)) as any;
  if (response.status < 200 || response.status >= 300) {
    const message =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.message === "string"
          ? parsed.message
          : "API key request failed";
    throw new WebRouteError(
      response.status,
      statusToErrorCode(response.status),
      message,
    );
  }
  return parsed;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  // MCPJam organization id (Convex `Id<'organizations'>`) the key acts inside.
  // The dialog requires an explicit selection (auto-selected when the user has
  // exactly one org).
  organizationId: z.string().min(1),
});

apiKeys.post("/", async (c) =>
  handleRoute(c, async () => {
    const raw = await readJsonBody<unknown>(c);
    const { name, organizationId } = parseWithSchema(createSchema, raw);
    const bearer = assertBearerToken(c);

    const result = await callBackendApiKeys("POST", "", bearer, {
      name,
      organizationId,
    });
    const key = result?.key as BackendKey | undefined;
    if (!key || typeof key.value !== "string") {
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "Backend did not return the new API key",
      );
    }

    logger.info("API key minted", {
      event: "api_key_created",
      auth_method: "session",
      key_id: key.id,
      mcpjam_organization_id: organizationId,
    });

    // Exact `CreatedApiKey` shape the client expects.
    return {
      id: key.id,
      name: key.name,
      obfuscated_value: key.obfuscatedValue,
      created_at: iso(key.createdAt),
      last_used_at: null,
      value: key.value,
    };
  }),
);

apiKeys.get("/", async (c) =>
  handleRoute(c, async () => {
    const bearer = assertBearerToken(c);
    const result = await callBackendApiKeys("GET", "", bearer);
    const keys: BackendKey[] = Array.isArray(result?.keys) ? result.keys : [];
    return {
      items: keys.map((k) => ({
        id: k.id,
        name: k.name,
        obfuscated_value: k.obfuscatedValue,
        created_at: iso(k.createdAt),
        last_used_at: iso(k.lastUsedAt),
      })),
    };
  }),
);

apiKeys.delete("/:id", async (c) =>
  handleRoute(c, async () => {
    const id = c.req.param("id");
    if (!id) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Missing API key id",
      );
    }
    const bearer = assertBearerToken(c);

    try {
      await callBackendApiKeys(
        "DELETE",
        `?keyId=${encodeURIComponent(id)}`,
        bearer,
      );
    } catch (error) {
      // Normalize the backend's "Key not found" message to the client's.
      if (error instanceof WebRouteError && error.status === 404) {
        throw new WebRouteError(404, ErrorCode.NOT_FOUND, "API key not found");
      }
      throw error;
    }

    logger.info("API key revoked", {
      event: "api_key_revoked",
      auth_method: "session",
      key_id: id,
    });

    return { ok: true };
  }),
);

apiKeys.onError((error, c) => {
  if (error instanceof WebRouteError) {
    return webError(c, error.status, error.code, error.message, error.details);
  }
  return webError(
    c,
    500,
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : "Internal error",
  );
});

export default apiKeys;
