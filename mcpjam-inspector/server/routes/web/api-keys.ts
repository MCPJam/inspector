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
import {
  verifyAuthKitToken,
  AuthKitConfigError,
} from "../../services/authkit-jwt.js";
import {
  resolveApiKeyReadiness,
  ApiKeyReadinessError,
} from "../../services/organizations.js";

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
 * - DELETE verifies the key id appears in the session user's own key list
 *   before issuing the WorkOS delete, so passing another user's key id
 *   fails before WorkOS sees the request. (WorkOS exposes no single-key
 *   GET for user keys — both `/api_keys/{id}` and the user-scoped variant
 *   404 even for existing ids — so list membership is the ownership check.)
 * - `sk_…` keys cannot manage other `sk_…` keys (privilege isolation).
 */

const apiKeys = new Hono();

// Privilege isolation: a WorkOS API key authenticates as the owning user but
// it must NOT mint or revoke other API keys (would create a privilege loop).
// Reject `sk_…` BEFORE bearerAuthMiddleware validates it — `sk_` is the same
// unambiguous discriminator the middleware uses (bearer-auth.ts), so this is
// equivalent to a post-validation `authMethod` check while skipping a ~200ms
// WorkOS validate plus Convex identity/binding lookups on a request that always
// ends in 403. (Bonus: invalid/revoked keys get the same 403, not a 401, so the
// endpoint can't be used to probe key validity.)
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

interface SessionContext {
  userId: string;
}

/**
 * Authenticate a key-management request by VERIFYING the WorkOS AuthKit access
 * token (signature, issuer, audience, exp/nbf) and returning only the trusted
 * `sub`.
 *
 * These routes act on the caller's behalf using the server's admin
 * `WORKOS_API_KEY` and write Convex org bindings, so the token MUST be verified
 * here — unlike other `/api/web/*` routes, nothing downstream re-checks it.
 * Verification (and the resulting 401) happens before any WorkOS or
 * binding-endpoint side effect.
 */
async function resolveSessionContext(c: any): Promise<SessionContext> {
  const bearer = assertBearerToken(c);
  let session;
  try {
    session = await verifyAuthKitToken(bearer);
  } catch (error) {
    if (error instanceof AuthKitConfigError) {
      logger.error("AuthKit verification is misconfigured", {
        error: error.message,
      });
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server auth verification is not configured",
      );
    }
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Invalid or expired session token",
    );
  }
  return { userId: session.sub };
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
  // WorkOS 422s carry the actual cause in `errors` (e.g.
  // `[{field: "organization_id", code: "organization_id should not be empty"}]`)
  // while `message` is just "Validation failed" — keep the field errors or the
  // failure is undiagnosable from our logs.
  const fieldErrors = Array.isArray(body?.errors) ? body.errors : undefined;
  logger.error("WorkOS API call failed", {
    workos_status: status,
    message: safeMessage,
    ...(fieldErrors ? { workos_errors: fieldErrors } : {}),
  });
  if (status === 401) {
    throw new WebRouteError(401, ErrorCode.UNAUTHORIZED, safeMessage);
  }
  if (status === 404) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, safeMessage);
  }
  if (status === 429) {
    throw new WebRouteError(429, ErrorCode.RATE_LIMITED, safeMessage);
  }
  throw new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    safeMessage,
    fieldErrors ? { workosErrors: fieldErrors } : undefined,
  );
}

/**
 * WorkOS REQUIRES `organization_id` when minting a user API key (422
 * "Validation failed" without it). The dialog already requires the caller to
 * select the target MCPJam (Convex) organization for the key
 * (`createSchema.organizationId` below) — that selection, not anything
 * derived from the session JWT, is what authoritatively determines which
 * WorkOS org the key gets minted into. Deriving it from the session instead
 * (a JWT `org_id` claim, or "first active WorkOS membership") gets MORE
 * ambiguous, not less, once a user can belong to several synced WorkOS orgs —
 * it doesn't reflect which org the user actually intends to act as.
 *
 * So this resolves the WorkOS org id via the backend's readiness check,
 * keyed on the request's own `organizationId` + the caller's resolved MCPJam
 * user id. Throws `ApiKeyReadinessError` (403 not-a-member, 404 org-not-found)
 * or `OrganizationNotReadyError` (sync still in flight) — the POST handler
 * translates both.
 */
class OrganizationNotReadyError extends Error {
  readonly reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.name = "OrganizationNotReadyError";
    this.reason = reason;
  }
}

async function resolveWorkosOrgId(
  mcpjamOrganizationId: string,
  mcpjamUserId: string,
): Promise<string> {
  const readiness = await resolveApiKeyReadiness(
    mcpjamOrganizationId,
    mcpjamUserId,
  );
  if (!readiness.ready || !readiness.workosOrganizationId) {
    const messages: Record<string, string> = {
      org_pending: "This organization is still being set up for API keys — please try again shortly.",
      org_failed: "This organization couldn't be set up for API keys. Please try again or contact support.",
      membership_pending: "Your access to this organization is still syncing — please try again shortly.",
      membership_failed: "Your access to this organization couldn't be synced. Please try again or contact support.",
    };
    throw new OrganizationNotReadyError(
      readiness.reason ? messages[readiness.reason] : "This organization isn't ready to create API keys yet.",
      readiness.reason,
    );
  }
  return readiness.workosOrganizationId;
}

/**
 * Whether `keyId` belongs to `userId`, checked by walking the user-scoped
 * key list (see DELETE: WorkOS has no single-key GET for user keys).
 */
async function userOwnsApiKey(userId: string, keyId: string): Promise<boolean> {
  let after: string | null = null;
  // Page cap is a runaway guard only — real users have a handful of keys.
  // Exhausting it with pages still remaining means ownership is UNKNOWN,
  // which must surface as an error: returning false here would read as a
  // 404 and make keys beyond the cap silently unrevokeable.
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) {
      params.set("after", after);
    }
    const { status, body } = await callWorkOS(
      "GET",
      `/user_management/users/${encodeURIComponent(userId)}/api_keys?${params.toString()}`,
    );
    if (status < 200 || status >= 300) {
      mapWorkOSError(status, body, "Failed to load API keys");
    }
    const items: any[] = Array.isArray(body?.data) ? body.data : [];
    if (items.some((key) => key?.id === keyId)) {
      return true;
    }
    after =
      typeof body?.list_metadata?.after === "string"
        ? body.list_metadata.after
        : null;
    if (!after) {
      return false;
    }
  }
  logger.error("API key ownership check exhausted page cap", {
    workos_user_id: userId,
    workos_key_id: keyId,
  });
  throw new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    "Could not verify API key ownership",
  );
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
    const session = await resolveSessionContext(c);

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

    let workosOrgId: string;
    try {
      workosOrgId = await resolveWorkosOrgId(organizationId, mcpjamUser._id);
    } catch (error) {
      if (error instanceof ApiKeyReadinessError) {
        const code =
          error.status === 403
            ? ErrorCode.FORBIDDEN
            : error.status === 400
              ? ErrorCode.VALIDATION_ERROR
              : ErrorCode.NOT_FOUND;
        throw new WebRouteError(error.status, code, error.message);
      }
      if (error instanceof OrganizationNotReadyError) {
        throw new WebRouteError(
          409,
          ErrorCode.VALIDATION_ERROR,
          error.message,
        );
      }
      throw error;
    }

    const payload: Record<string, unknown> = {
      name,
      organization_id: workosOrgId,
    };

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
    const session = await resolveSessionContext(c);
    // Deliberately NOT filtered by `session.organizationId`: a key is now
    // minted into whichever MCPJam org the caller selected in the dialog
    // (see POST above), which can differ from the WorkOS org the session
    // happens to be scoped to. Filtering here caused a minted key to vanish
    // from this list (and become unrevokeable from the UI) whenever those
    // two orgs didn't match. WorkOS keys are already user-scoped by this
    // endpoint; the MCPJam-org boundary is enforced at USE time via the
    // workosApiKeyBindings lookup in bearer-auth.ts, not at listing time.
    //
    // Unscoped-by-org means a user's keys can now span enough pages for
    // WorkOS to paginate (`list_metadata.after`) — same page-walk pattern
    // as `userOwnsApiKey` below, so a key on a later page doesn't silently
    // disappear from Settings the same way the org filter used to hide one.
    const items: any[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ limit: "100" });
      if (after) {
        params.set("after", after);
      }
      const { status, body } = await callWorkOS(
        "GET",
        `/user_management/users/${encodeURIComponent(session.userId)}/api_keys?${params.toString()}`,
      );
      if (status < 200 || status >= 300) {
        mapWorkOSError(status, body, "Failed to list API keys");
      }
      // WorkOS returns `{ data: [...] }` or `{ data: [...], list_metadata: ... }`.
      const pageItems = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body)
          ? body
          : [];
      items.push(...pageItems);
      after =
        typeof body?.list_metadata?.after === "string"
          ? body.list_metadata.after
          : null;
      if (!after) {
        break;
      }
      if (page === 9) {
        // Page cap hit with more pages remaining — unlike `userOwnsApiKey`
        // below (a correctness-critical ownership check, where this must
        // hard-fail), a listing endpoint degrades better by returning what
        // it has than by failing the whole Settings page. Still log it: a
        // silent truncation here is exactly the "key vanished" failure mode
        // this file has been fixing, just capped rather than unconditional.
        logger.warn("API key listing exhausted page cap", {
          workos_user_id: session.userId,
        });
      }
    }
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
    const session = await resolveSessionContext(c);

    // Cross-user defense in depth: WorkOS does not enforce per-user
    // ownership for the org-level admin key, and it exposes no single-key
    // GET for user keys (404s even for existing ids). The key must appear
    // in the session user's OWN key list — enumeration under the user is
    // the ownership proof. An unknown or foreign id reads as not-found.
    if (!(await userOwnsApiKey(session.userId, id))) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "API key not found");
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
