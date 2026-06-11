/**
 * Public v1 OAuth surface.
 *
 * When a v1 operation hits an OAuth-protected server without a stored grant,
 * the caller gets `OAUTH_REQUIRED` with `{ serverId, serverUrl }` details.
 * This route closes the loop: an agent completes the OAuth flow itself
 * (e.g. SDK `runOAuthLogin` — interactive loopback, headless, or
 * client-credentials) and imports the resulting tokens here. The backend
 * stores them scoped to (user, project, server); every subsequent v1 connect
 * injects the stored access token automatically and 401s trigger a
 * server-side refresh — no further caller involvement.
 *
 * Unlike the hosted `/api/web/oauth/*` proxies (which forward the raw
 * Authorization header), this route builds delegation-aware Convex headers so
 * WorkOS API-key callers work.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  assertBearerToken,
  parseWithSchema,
  ErrorCode,
  WebRouteError,
} from "../web/errors.js";
import { buildConvexAuthHeaders } from "../web/auth.js";
import { synthesizeServerBody } from "./adapter.js";
import { v1Resource } from "./envelope.js";

const oauth = new Hono();

const IMPORT_TIMEOUT_MS = 15_000;

const importTokensSchema = z.object({
  projectId: z.string().min(1),
  serverId: z.string().min(1),
  serverUrl: z.string().min(1),
  oauthResourceUrl: z.string().optional(),
  clientInformation: z
    .object({
      clientId: z.string().min(1),
      clientSecret: z.string().optional(),
    })
    .optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
    id_token: z.string().optional(),
  }),
});

// POST /v1/projects/:projectId/servers/:serverId/oauth/import-tokens
// Store externally-obtained OAuth tokens for this server. Returns
// { imported: true, expiresAt } on success.
oauth.post(
  "/projects/:projectId/servers/:serverId/oauth/import-tokens",
  async (c) => {
    const rawBody = await synthesizeServerBody(c);
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(importTokensSchema, rawBody);

    const convexUrl = process.env.CONVEX_HTTP_URL;
    if (!convexUrl) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing CONVEX_HTTP_URL configuration"
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${convexUrl}/web/oauth/import-tokens`, {
        method: "POST",
        headers: buildConvexAuthHeaders(c, bearerToken),
        // `kind: "generic"` — the registry OAuth-proxy variant is a hosted
        // client concern, not part of the public surface.
        body: JSON.stringify({ ...body, kind: "generic" }),
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" ||
          (error as { code?: string }).code === "ABORT_ERR");
      throw new WebRouteError(
        isAbort ? 504 : 502,
        isAbort ? ErrorCode.TIMEOUT : ErrorCode.SERVER_UNREACHABLE,
        isAbort
          ? `Token import timed out after ${IMPORT_TIMEOUT_MS}ms`
          : "Failed to reach the token import service"
      );
    } finally {
      clearTimeout(timeoutId);
    }

    type ImportTokensPayload = {
      expiresAt?: number | null;
      code?: string;
      message?: string;
    };
    let payload: ImportTokensPayload | null = null;
    try {
      payload = (await response.json()) as ImportTokensPayload;
    } catch {
      // handled below
    }

    if (!response.ok) {
      const status = response.status;
      const code =
        status === 401
          ? ErrorCode.UNAUTHORIZED
          : status === 403
            ? ErrorCode.FORBIDDEN
            : status === 404
              ? ErrorCode.NOT_FOUND
              : status === 400
                ? ErrorCode.VALIDATION_ERROR
                : ErrorCode.INTERNAL_ERROR;
      throw new WebRouteError(
        status >= 400 && status < 500 ? status : 502,
        code,
        payload?.message ?? `Token import failed (${status})`
      );
    }

    return v1Resource(c, {
      imported: true,
      expiresAt: payload?.expiresAt ?? null,
    });
  }
);

export default oauth;
