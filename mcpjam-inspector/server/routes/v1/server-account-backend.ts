/**
 * The Convex `/web/oauth/*` account routes, as the v1 accounts API calls them.
 *
 * One forwarding path for every account route and for the deprecated
 * `import-tokens` alias. The caller's identity is exchanged the way every v1
 * call to Convex exchanges it, so an API key acts as the person who made it. A
 * refusal keeps the backend's status, its code and its sentence. An account
 * view is projected field by field, so nothing the backend keeps on a row (a
 * token, a vault id, a recorded profile) can reach a caller.
 */
import type { Context } from "hono";
import { z } from "zod";
import { buildConvexAuthHeaders, callerContextFromHono } from "../web/auth.js";
import { assertBearerToken, ErrorCode, WebRouteError } from "../web/errors.js";
import { retryAfterFromMs } from "./convex-errors.js";

const BACKEND_TIMEOUT_MS = 15_000;

/**
 * The contract's account view, and every field a caller may see. Unknown keys
 * are stripped on parse, which is what keeps a field the backend adds later
 * from being published by accident.
 */
export const accountViewSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.enum(["personal", "project"]),
  isDefault: z.boolean(),
  needsReconnect: z.boolean(),
  hostedOnly: z.boolean(),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type AccountView = z.infer<typeof accountViewSchema>;

export const accountAnswer = z.object({ account: accountViewSchema });
export const accountListAnswer = z.object({
  accounts: z.array(accountViewSchema),
});
export const uploadAnswer = z.object({
  created: z.boolean(),
  account: accountViewSchema,
  expiresAt: z.number().nullable(),
});
export const deleteAnswer = z.object({ outcome: z.literal("deleted") });

/** The v1 code each status the contract uses answers with. */
const CODE_FOR_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

/** Copy for a refusal that arrived without the backend's own sentence. */
const FALLBACK_MESSAGE: Readonly<Partial<Record<ErrorCode, string>>> = {
  [ErrorCode.NOT_FOUND]:
    "Account not found. List the server's accounts to find its id or name.",
  [ErrorCode.RATE_LIMITED]:
    "Too many uploads to this server. Wait, then upload again.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A backend refusal as a v1 error: the same status, the backend's code in
 * `details.code`, and the contract's details copied key by key, so a payload
 * that grows a field does not publish it without someone deciding to.
 */
export function accountRefusal(
  status: number,
  payload: unknown,
): WebRouteError {
  const body = isRecord(payload) ? payload : {};
  const code = CODE_FOR_STATUS[status];
  if (!code) {
    return new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      `The account service failed with status ${status}. Try again.`,
    );
  }
  const retryAfterMs =
    typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs)
      ? body.retryAfterMs
      : undefined;
  const accountIds = Array.isArray(body.accountIds)
    ? body.accountIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const details = {
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    ...(accountIds ? { accountIds } : {}),
    ...(typeof body.accountId === "string"
      ? { accountId: body.accountId }
      : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  const sentence = [body.error, body.message].find(
    (value): value is string => typeof value === "string" && !!value.trim(),
  );
  const error = new WebRouteError(
    status,
    code,
    sentence?.trim() ??
      FALLBACK_MESSAGE[code] ??
      "The account request was refused. Check the request, then try again.",
    Object.keys(details).length > 0 ? details : undefined,
  );
  const retryAfter =
    status === 429 ? retryAfterFromMs(retryAfterMs) : undefined;
  return retryAfter ? error.withHeaders({ "Retry-After": retryAfter }) : error;
}

/** The path params every account route is scoped by. */
export function accountScope(c: Context): {
  projectId: string;
  serverId: string;
} {
  return {
    projectId: c.req.param("projectId") ?? "",
    serverId: c.req.param("serverId") ?? "",
  };
}

/** POST one account route and parse its answer against the contract. */
export async function callAccountsBackend<T>(
  c: Context,
  path: string,
  body: Record<string, unknown>,
  answer: z.ZodType<T>,
): Promise<T> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  const headers = buildConvexAuthHeaders(
    callerContextFromHono(c),
    assertBearerToken(c),
  );
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${convexUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw timedOut
      ? new WebRouteError(
          504,
          ErrorCode.TIMEOUT,
          `The account service did not answer within ${BACKEND_TIMEOUT_MS / 1000} seconds. Try again.`,
        )
      : new WebRouteError(
          502,
          ErrorCode.SERVER_UNREACHABLE,
          "Could not reach the account service. Try again.",
        );
  }
  const payload = parseJson(text);
  if (!response.ok) throw accountRefusal(response.status, payload);
  const parsed = answer.safeParse(payload);
  if (!parsed.success) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "The account service answered in a form this server can't read. Try again.",
    );
  }
  return parsed.data;
}

/**
 * A body that is not JSON is read as no body: the status still decides, and a
 * refusal without the backend's sentence falls back to its own copy.
 */
function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
