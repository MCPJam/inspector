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
} from "./errors.js";
import { handleRoute } from "./auth.js";
import { resolveUserByExternalId } from "../../services/identity.js";
import {
  createWorkosKeyBinding,
  removeWorkosKeyBinding,
  WorkosKeyBindingError,
} from "../../services/workos-key-bindings.js";

/**
 * `/api/web/api-keys/*` — WorkOS API Key management.
 *
 * Calls the WorkOS REST API directly with the server-side `WORKOS_API_KEY`
 * (the Node SDK only exposes org-scoped helpers; the user-scoped endpoints
 * we need for v1 are documented REST routes). MCPJam never stores the raw
 * key value — `value` is in WorkOS's create response only, returned to the
 * browser once, and never persisted or logged.
 *
 * Security notes for future contributors:
 * - A user can only mint a key as powerful as their own session: the
 *   create call routes through `/user_management/users/{userId}` and
 *   `userId` is taken from the session JWT.
 * - DELETE re-fetches the key and verifies `owner.id === sessionUserId`
 *   before issuing the WorkOS delete, so passing another user's key id
 *   fails before WorkOS sees the request.
 * - `sk_…` keys cannot manage other `sk_…` keys (privilege isolation).
 */

const apiKeys = new Hono();

// `sessionAuthMiddleware` bypasses `/api/web/*` entirely (session-auth.ts:103),
// so this sub-router must explicitly require a bearer.
apiKeys.use("*", bearerAuthMiddleware);

// Privilege isolation: a WorkOS API key authenticates as the owning user
// but it must NOT be able to mint or revoke other API keys (would create
// a privilege loop). Session-only here.
apiKeys.use("*", async (c, next) => {
  if (c.get("authMethod") === "workos_api_key") {
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

const WORKOS_BASE_URL = "https://api.workos.com";

function getWorkOSRestKey(): string {
  const key = process.env.WORKOS_API_KEY;
  if (!key) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing WORKOS_API_KEY configuration",
    );
  }
  return key;
}

interface JwtClaims {
  sub?: string;
  org_id?: string;
}

/**
 * Decode the AuthKit JWT payload to read the WorkOS `sub` (user id) and
 * `org_id`. Signature is NOT re-verified here — Convex enforces auth on
 * downstream calls. We use the claims only to scope WorkOS REST requests
 * to the session user.
 */
function decodeSessionClaims(token: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Session JWT is malformed",
    );
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    ) as JwtClaims;
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Session JWT payload is not valid JSON",
    );
  }
}

interface SessionContext {
  userId: string;
  organizationId?: string;
}

function resolveSessionContext(c: any): SessionContext {
  const bearer = assertBearerToken(c);
  const claims = decodeSessionClaims(bearer);
  const userId = claims.sub;
  if (!userId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Session JWT is missing `sub` claim",
    );
  }
  return { userId, organizationId: claims.org_id };
}

async function callWorkOS(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const key = getWorkOSRestKey();
  const response = await fetch(`${WORKOS_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    // Empty body (204) — leave null.
  }
  return { status: response.status, body: parsed };
}

function mapWorkOSError(status: number, body: any, fallback: string): never {
  const safeMessage =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.error_description === "string"
        ? body.error_description
        : fallback;
  if (status === 401) {
    throw new WebRouteError(401, ErrorCode.UNAUTHORIZED, safeMessage);
  }
  if (status === 404) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, safeMessage);
  }
  if (status === 429) {
    throw new WebRouteError(429, ErrorCode.RATE_LIMITED, safeMessage);
  }
  throw new WebRouteError(500, ErrorCode.INTERNAL_ERROR, safeMessage);
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  // MCPJam organization id (Convex `Id<'organizations'>`) the key acts inside.
  // The dialog requires an explicit selection (auto-selected when the user
  // has exactly one org). This is NOT the WorkOS org id.
  organizationId: z.string().min(1),
});

apiKeys.post("/", async (c) =>
  handleRoute(c, async () => {
    const raw = await readJsonBody<unknown>(c);
    const { name, organizationId } = parseWithSchema(createSchema, raw);
    const session = resolveSessionContext(c);

    // Resolve the MCPJam (Convex) user id for the binding. The session bearer
    // carries the WorkOS user id (`sub`); the binding records the Convex user
    // id so the backend can verify org membership at mint time.
    const mcpjamUser = await resolveUserByExternalId(session.userId);
    if (!mcpjamUser) {
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Could not resolve your MCPJam account",
      );
    }

    const payload: Record<string, unknown> = { name };
    if (session.organizationId) {
      payload.organization_id = session.organizationId;
    }

    const { status, body } = await callWorkOS(
      "POST",
      `/user_management/users/${encodeURIComponent(session.userId)}/api_keys`,
      payload,
    );

    if (status < 200 || status >= 300) {
      mapWorkOSError(status, body, "Failed to create API key");
    }

    const workosKeyId = typeof body?.id === "string" ? body.id : null;
    if (!workosKeyId) {
      // WorkOS always returns an id on 2xx; without one we can neither bind
      // nor later revoke the key, so fail loud rather than ship a dead key.
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "WorkOS did not return an API key id",
      );
    }

    // Bind the key to the selected MCPJam org. A key with no binding is
    // orphaned (rejected on /api/v1/* with 401 UNAUTHORIZED, details.reason
    // "ORPHANED_KEY"), so if the bind fails we revoke the WorkOS key
    // immediately and report the failure — never leave an unusable key behind.
    try {
      await createWorkosKeyBinding({
        workosApiKeyId: workosKeyId,
        mcpjamOrganizationId: organizationId,
        mintedByUserId: mcpjamUser._id,
      });
    } catch (bindingError) {
      logger.error("API key org binding failed; revoking WorkOS key", {
        workos_key_id: workosKeyId,
        error:
          bindingError instanceof Error
            ? bindingError.message
            : String(bindingError),
      });
      try {
        await callWorkOS(
          "DELETE",
          `/api_keys/${encodeURIComponent(workosKeyId)}`,
        );
      } catch (revokeError) {
        // Best-effort cleanup. If this also fails the WorkOS key lingers with
        // no binding — not a security hole (the bearer middleware rejects
        // orphaned keys) but litter worth flagging.
        logger.error("Failed to revoke WorkOS key after binding failure", {
          workos_key_id: workosKeyId,
          error:
            revokeError instanceof Error
              ? revokeError.message
              : String(revokeError),
        });
      }

      const message =
        bindingError instanceof Error
          ? bindingError.message
          : "Failed to bind API key";
      if (bindingError instanceof WorkosKeyBindingError) {
        // Surface a client-fault rejection as itself; the key was not created.
        if (bindingError.status === 400) {
          throw new WebRouteError(
            400,
            ErrorCode.VALIDATION_ERROR,
            `${message} (API key not created)`,
          );
        }
        if (bindingError.status === 403) {
          throw new WebRouteError(
            403,
            ErrorCode.FORBIDDEN,
            `${message} (API key not created)`,
          );
        }
      }
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "Could not bind the API key to your organization. The key was not created.",
      );
    }

    logger.info("API key minted", {
      event: "api_key_created",
      auth_method: "session",
      workos_key_id: workosKeyId,
      actor_user_id: session.userId,
      mcpjam_organization_id: organizationId,
    });

    return body;
  }),
);

apiKeys.get("/", async (c) =>
  handleRoute(c, async () => {
    const session = resolveSessionContext(c);
    const params = new URLSearchParams();
    if (session.organizationId) {
      params.set("organization_id", session.organizationId);
    }
    const qs = params.toString();
    const { status, body } = await callWorkOS(
      "GET",
      `/user_management/users/${encodeURIComponent(session.userId)}/api_keys${
        qs ? `?${qs}` : ""
      }`,
    );

    if (status < 200 || status >= 300) {
      mapWorkOSError(status, body, "Failed to list API keys");
    }

    // WorkOS returns `{ data: [...] }` or `{ data: [...], list_metadata: ... }`.
    const items = Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body)
        ? body
        : [];
    return { items };
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
    const session = resolveSessionContext(c);

    // Cross-user defense in depth: fetch the key first and confirm the
    // owner matches the session user before deleting. WorkOS does not
    // enforce per-user ownership for the org-level admin key.
    const lookup = await callWorkOS(
      "GET",
      `/api_keys/${encodeURIComponent(id)}`,
    );
    if (lookup.status === 404) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "API key not found");
    }
    if (lookup.status < 200 || lookup.status >= 300) {
      mapWorkOSError(lookup.status, lookup.body, "Failed to load API key");
    }
    const ownerId = lookup.body?.owner?.id;
    if (typeof ownerId !== "string" || ownerId !== session.userId) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "API key not found",
      );
    }

    const { status, body } = await callWorkOS(
      "DELETE",
      `/api_keys/${encodeURIComponent(id)}`,
    );
    if (status !== 204 && (status < 200 || status >= 300)) {
      mapWorkOSError(status, body, "Failed to revoke API key");
    }

    // Remove the org binding. Best-effort: the backend delete is idempotent
    // and the WorkOS key is already gone, so a cleanup failure (including a
    // binding that was never written) must not fail the user-facing revoke.
    try {
      await removeWorkosKeyBinding(id);
    } catch (error) {
      logger.warn("Failed to remove API key org binding during revoke", {
        workos_key_id: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("API key revoked", {
      event: "api_key_revoked",
      auth_method: "session",
      workos_key_id: id,
      actor_user_id: session.userId,
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
