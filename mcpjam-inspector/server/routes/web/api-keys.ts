import { Hono } from "hono";
import { getInternalBackendConfig } from "../../services/internal-backend.js";
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
import { resolveWorkosApiBaseUrl } from "../../services/workos-api-base.js";
import {
  lookupWorkosKeyBinding,
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

const WORKOS_CALL_TIMEOUT_MS = 15_000;

async function callWorkOS(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const key = getWorkOSRestKey();
  // Resolved per call so a test that stubs the env after this module
  // loaded is still honoured.
  const baseUrl = resolveWorkosApiBaseUrl(process.env).baseUrl;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    // A stalled WorkOS call must not pin a user request open indefinitely.
    signal: AbortSignal.timeout(WORKOS_CALL_TIMEOUT_MS),
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

/** Max in-flight Convex binding lookups while labeling a user's key list. */
const BINDING_LOOKUP_CONCURRENCY = 8;
/** Max owners whose WorkOS key lists are walked at once for the org inventory. */
const OWNER_LIST_CONCURRENCY = 4;

/** `Promise.all` with at most `limit` calls of `fn` in flight; keeps order. */
async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  return results;
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
      org_pending:
        "This organization is still being set up for API keys — please try again shortly.",
      org_failed:
        "This organization couldn't be set up for API keys. Please try again or contact support.",
      membership_pending:
        "Your access to this organization is still syncing — please try again shortly.",
      membership_failed:
        "Your access to this organization couldn't be synced. Please try again or contact support.",
    };
    throw new OrganizationNotReadyError(
      readiness.reason
        ? messages[readiness.reason]
        : "This organization isn't ready to create API keys yet.",
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
        throw new WebRouteError(409, ErrorCode.VALIDATION_ERROR, error.message);
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
        // The key id is already bound to a different org. The backend refuses
        // to re-point a live key, and it is right to: the request is
        // well-formed and the caller is permitted, so this is a conflict, not
        // a validation error or a backend fault.
        if (bindingError.status === 409) {
          throw new WebRouteError(
            409,
            ErrorCode.CONFLICT,
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

const organizationIdParamSchema = z.string().trim().min(1);

// Session-only, admin-authorized organization inventory; returns no key secrets.
//
// Trust boundary: the owner/admin decision lives in the backend
// (`workosApiKeyBindings.listForOrganization` returns null for anyone below
// admin, and reads bindings through the org index, so it cannot return
// another org's rows). This route adds two local checks so a backend
// regression cannot silently widen who sees what: a membership floor via the
// readiness check (a non-member 403s before the inventory is even asked
// for), and a per-key cross-check that each returned key's own binding
// points at the requested org.
apiKeys.get("/organization/:organizationId", async (c) =>
  handleRoute(c, async () => {
    const session = await resolveSessionContext(c);
    const actor = await resolveUserByExternalId(session.userId);
    if (!actor)
      throw new WebRouteError(401, ErrorCode.UNAUTHORIZED, "Unknown user");
    const organizationId = parseWithSchema(
      organizationIdParamSchema,
      c.req.param("organizationId"),
    );
    try {
      await resolveApiKeyReadiness(organizationId, actor._id);
    } catch (error) {
      if (error instanceof ApiKeyReadinessError) {
        const code =
          error.status === 404
            ? ErrorCode.NOT_FOUND
            : error.status === 403
              ? ErrorCode.FORBIDDEN
              : ErrorCode.VALIDATION_ERROR;
        throw new WebRouteError(error.status, code, error.message);
      }
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "Organization API keys are unavailable. Please try again later.",
      );
    }
    const { convexUrl, serviceToken } = getInternalBackendConfig();
    const params = new URLSearchParams({
      organizationId,
      actorUserId: actor._id,
    });
    const response = await fetch(
      `${convexUrl}/internal/v1/organization-api-keys?${params}`,
      {
        headers: { "x-inspector-service-token": serviceToken },
      },
    );
    if (response.status === 403)
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "Only organization owners and admins can view API keys.",
      );
    if (!response.ok)
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "Organization API keys are unavailable. Please try again later.",
      );
    const { items: bindings } = (await response.json()) as {
      items: Array<{
        workosApiKeyId: string;
        owner: {
          id: string;
          name: string;
          email: string;
          externalId: string | null;
        };
      }>;
    };
    const items: Array<{
      id: string;
      name: string;
      obfuscated_value: string;
      created_at: string;
      last_used_at: string | null;
      organizationId: string;
      owner: { id: string; name: string; email: string };
    }> = [];
    // Fetch once per owner, then include only keys explicitly bound to this
    // org. Owners are walked with bounded concurrency so a large org neither
    // serializes every WorkOS call nor fans them all out at once.
    type InventoryItem = (typeof items)[number];
    const listOwnerKeys = async (
      externalId: string,
    ): Promise<InventoryItem[]> => {
      const owned: InventoryItem[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ limit: "100" });
        if (after) query.set("after", after);
        const { status, body } = await callWorkOS(
          "GET",
          `/user_management/users/${encodeURIComponent(externalId)}/api_keys?${query}`,
        );
        if (status < 200 || status >= 300)
          mapWorkOSError(status, body, "Failed to list organization API keys");
        for (const key of body?.data ?? []) {
          const binding = bindings.find(
            (b) =>
              b.workosApiKeyId === key.id && b.owner.externalId === externalId,
          );
          if (binding)
            owned.push({
              id: key.id,
              name: key.name,
              obfuscated_value: key.obfuscated_value,
              created_at: key.created_at,
              last_used_at: key.last_used_at,
              organizationId,
              owner: {
                id: binding.owner.id,
                name: binding.owner.name,
                email: binding.owner.email,
              },
            });
        }
        after =
          typeof body?.list_metadata?.after === "string"
            ? body.list_metadata.after
            : null;
        if (!after) break;
        if (page === 9)
          throw new WebRouteError(
            502,
            ErrorCode.SERVER_UNREACHABLE,
            "Could not load the complete organization key list.",
          );
      }
      return owned;
    };
    const ownerExternalIds = [
      ...new Set(
        bindings
          .map((b) => b.owner.externalId)
          .filter((id): id is string => !!id),
      ),
    ];
    const perOwner = await mapWithConcurrency(
      ownerExternalIds,
      OWNER_LIST_CONCURRENCY,
      listOwnerKeys,
    );
    items.push(...perOwner.flat());
    // Cross-check each key's own binding against the requested org. A key
    // whose binding is missing, points elsewhere, or cannot be read is
    // dropped rather than shown: on this route an unlabeled key would be an
    // authorization claim, not decoration.
    let droppedKeys = 0;
    const verified = await mapWithConcurrency(
      items,
      BINDING_LOOKUP_CONCURRENCY,
      async (item) => {
        try {
          const binding = await lookupWorkosKeyBinding(item.id);
          return binding?.mcpjamOrganizationId === organizationId;
        } catch {
          return false;
        }
      },
    );
    const scoped = items.filter((_, index) => {
      if (verified[index]) return true;
      droppedKeys += 1;
      return false;
    });
    if (droppedKeys > 0) {
      logger.warn(
        "Dropped organization API keys whose binding did not verify",
        {
          organization_id: organizationId,
          dropped: droppedKeys,
          total: items.length,
        },
      );
    }
    return { items: scoped };
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
    }
    // Org labels are decoration on this list, not authorization: the org
    // boundary is enforced at USE time in bearer-auth.ts. So a binding lookup
    // that fails (Convex down, route not deployed, misconfigured service
    // token) must not take the list down or leak its message — before the
    // labels existed this list depended on WorkOS alone, and it still should.
    // Lookups are bounded so a long key list cannot fan out one service-token
    // fetch per key all at once.
    let lookupFailures = 0;
    let firstFailure: unknown;
    const organizationIds = await mapWithConcurrency(
      items,
      BINDING_LOOKUP_CONCURRENCY,
      async (key): Promise<string | null> => {
        try {
          const binding = await lookupWorkosKeyBinding(key.id);
          return binding?.mcpjamOrganizationId ?? null;
        } catch (error) {
          lookupFailures += 1;
          firstFailure ??= error;
          return null;
        }
      },
    );
    if (lookupFailures > 0) {
      logger.warn("API key org binding lookup failed; listing keys unlabeled", {
        failed: lookupFailures,
        total: items.length,
        error:
          firstFailure instanceof Error
            ? firstFailure.message
            : String(firstFailure),
      });
    }
    return {
      items: items.map((key, index) => ({
        id: key.id,
        name: key.name,
        obfuscated_value: key.obfuscated_value,
        created_at: key.created_at,
        last_used_at: key.last_used_at,
        organizationId: organizationIds[index],
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
      // Name the actor on the binding delete so the backend's audit row says
      // who revoked instead of inferring the minter. The check above already
      // proved this session owns the key, so this is not the authorization —
      // it is attribution, plus defense in depth on a route the service token
      // alone can reach. Resolving can fail (a WorkOS user with no MCPJam row
      // yet); the revoke is already done, so send it unattributed rather than
      // turning a bookkeeping gap into a failed revoke.
      const actor = await resolveUserByExternalId(session.userId);
      await removeWorkosKeyBinding(id, actor?._id);
    } catch (error) {
      const status =
        error instanceof WorkosKeyBindingError ? error.status : undefined;
      logger.warn("Failed to remove API key org binding during revoke", {
        workos_key_id: id,
        // A 403 is the minter-only rule firing, which should be unreachable
        // behind the ownership check above — worth separating from an
        // unreachable backend when reading logs.
        ...(status === 403 ? { reason: "not_key_minter" } : {}),
        ...(status !== undefined ? { binding_status: status } : {}),
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
