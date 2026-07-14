// Node-only in-process XAARequestExecutor — the CLI's "loopback" analog to the
// inspector's server-backed executor. It services the MCPJam-owned mint routes
// (`/authenticate`, `/token`, `/token-exchange`, `/proxy/token`) in-process as
// thin adapters over the shared handler cores in `mint/handlers.ts`, and
// external AS/MCP requests through the hardened OAuth proxy.
// This is the seam that lets the CLI drive the shared browser-safe state machine
// without a running inspector server. Imports crypto/fs (mint) + node:dns
// (proxy) — MUST stay out of the browser entry.
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchPinnedPublicDocument,
} from "../oauth-proxy.js";
import { TOKEN_EXCHANGE_GRANT } from "../oauth/client-identity.js";
import { getXAAIssuerUrl, initXAAIdpKeyPair } from "./mint/keypair.js";
import {
  handleXaaAuthenticate,
  handleXaaJsonTokenExchange,
  handleXaaTokenExchangeGrant,
} from "./mint/handlers.js";
import { buildJwtBearerRequest } from "./mint/jwt-bearer.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  normalizeIdentityAssertionFormat,
  normalizeSubjectIdentifierFormat,
} from "./constants.js";
import type {
  XAAExternalRequestOptions,
  XAARequestExecutor,
  XAARequestResult,
} from "./state-machines/types.js";

export interface InProcessXaaExecutorOptions {
  /** Origin the local mock IdP issues from (`getXAAIssuerUrl` appends `/xaa`). */
  issuerBaseUrl: string;
  /** Reject non-HTTPS / private targets. Default false (local dev). */
  httpsOnly?: boolean;
  /** Per-request timeout (ms) applied to every outbound proxy request. */
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function parseInitBody(init?: RequestInit): Record<string, unknown> {
  if (!init || init.body == null) return {};
  if (typeof init.body === "string") {
    try {
      return asRecord(JSON.parse(init.body));
    } catch {
      return {};
    }
  }
  return asRecord(init.body);
}

function parseFormBody(init?: RequestInit): Record<string, string> {
  if (!init || typeof init.body !== "string") return {};
  return Object.fromEntries(new URLSearchParams(init.body));
}

function jsonResult(status: number, body: unknown): XAARequestResult {
  return {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : String(status),
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
    body,
    ok: status >= 200 && status < 300,
  };
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Normalize any HeadersInit (Record, Headers, or tuple array) to a plain record.
function normalizeHeaders(
  headers: HeadersInit | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Build a Node in-process executor. The internal-route switch is exhaustive; an
 * unrecognized MCPJam route returns 404 rather than silently succeeding.
 */
export function createInProcessXaaExecutor(
  options: InProcessXaaExecutorOptions
): XAARequestExecutor {
  const httpsOnly = options.httpsOnly ?? false;
  const timeoutMs = options.timeoutMs;

  // Ensure the keypair is loaded, then return the canonical /xaa issuer.
  const resolveIssuer = (): string => {
    initXAAIdpKeyPair();
    return getXAAIssuerUrl(options.issuerBaseUrl);
  };

  const internalRequest = async (
    path: string,
    init?: RequestInit
  ): Promise<XAARequestResult> => {
    const body = parseInitBody(init);

    // Mock login → identity assertion (OIDC id_token or SAML assertion).
    // Thin adapter over the shared core, which owns the server's
    // demo-identity defaults and rich response body.
    if (path.endsWith("/authenticate")) {
      if (
        body.assertionFormat !== undefined &&
        normalizeIdentityAssertionFormat(body.assertionFormat) === undefined
      ) {
        return jsonResult(400, {
          error: `Unsupported assertion format: ${String(
            body.assertionFormat
          )}`,
        });
      }
      const result = handleXaaAuthenticate({
        issuer: resolveIssuer(),
        userId: nonEmptyString(body.userId),
        email: nonEmptyString(body.email),
        audience: nonEmptyString(body.audience),
        resourceClientId: nonEmptyString(body.resourceClientId),
        assertionFormat: normalizeIdentityAssertionFormat(body.assertionFormat),
      });
      return jsonResult(result.status, result.body);
    }

    // Standards-track RFC 8693 token exchange. The valid debugger flow uses
    // this form-encoded endpoint; the JSON route below remains available for
    // intentionally malformed assertions used by negative tests. Grant-type
    // dispatch is the adapter's (it mirrors the server's outer /token route);
    // everything else lives in the shared core.
    if (path.endsWith("/token") && !path.endsWith("/proxy/token")) {
      const form = parseFormBody(init);
      if (form.grant_type !== TOKEN_EXCHANGE_GRANT) {
        return jsonResult(400, { error: "unsupported_grant_type" });
      }
      const result = handleXaaTokenExchangeGrant(resolveIssuer(), form);
      return jsonResult(result.status, result.body);
    }

    // Token exchange → ID-JAG. The adapter mirrors the server's zod +
    // resolveNegativeTestMode validation; the shared core decodes the
    // assertion for sub/email and mints (applying the negative-test tamper
    // when requested). Like the server route, a missing/malformed assertion
    // or one without a subject is a 400 — never a silently minted
    // empty-subject ID-JAG.
    if (path.endsWith("/token-exchange")) {
      const identityAssertion = nonEmptyString(body.identityAssertion);
      if (!identityAssertion) {
        return jsonResult(400, {
          error: "Token exchange requires a non-empty identity assertion.",
        });
      }
      const requiredFields = {
        audience: nonEmptyString(body.audience),
        clientId: nonEmptyString(body.clientId),
      };
      const missingField = Object.entries(requiredFields).find(
        ([, value]) => value === undefined
      )?.[0];
      if (missingField) {
        return jsonResult(400, {
          error: `Token exchange requires a non-empty ${missingField}.`,
        });
      }
      if (
        body.negativeTestMode !== undefined &&
        !isNegativeTestMode(body.negativeTestMode)
      ) {
        return jsonResult(400, {
          error: `Unsupported negative test mode: ${String(
            body.negativeTestMode
          )}`,
        });
      }
      if (
        body.assertionFormat !== undefined &&
        normalizeIdentityAssertionFormat(body.assertionFormat) === undefined
      ) {
        return jsonResult(400, {
          error: `Unsupported assertion format: ${String(
            body.assertionFormat
          )}`,
        });
      }
      if (
        body.subjectIdFormat !== undefined &&
        normalizeSubjectIdentifierFormat(body.subjectIdFormat) === undefined
      ) {
        return jsonResult(400, {
          error: `Unsupported subject identifier format: ${String(
            body.subjectIdFormat
          )}`,
        });
      }
      try {
        const result = handleXaaJsonTokenExchange({
          issuer: resolveIssuer(),
          identityAssertion,
          audience: requiredFields.audience!,
          resource: nonEmptyString(body.resource),
          clientId: requiredFields.clientId!,
          scope: nonEmptyString(body.scope),
          negativeTestMode: isNegativeTestMode(body.negativeTestMode)
            ? body.negativeTestMode
            : DEFAULT_NEGATIVE_TEST_MODE,
          assertionFormat: normalizeIdentityAssertionFormat(
            body.assertionFormat
          ),
          subjectIdFormat: normalizeSubjectIdentifierFormat(
            body.subjectIdFormat
          ),
        });
        return jsonResult(result.status, result.body);
      } catch (error) {
        return jsonResult(400, {
          error:
            error instanceof Error
              ? error.message
              : "Invalid token exchange request",
        });
      }
    }

    // jwt-bearer redemption proxy → { status, body } (the upstream token
    // endpoint response), matching the server /proxy/token wrapper. Only the
    // inline token-endpoint shape is supported in-process (the CLI has no
    // server-side registration/server-target secret resolution).
    if (path.endsWith("/proxy/token")) {
      const tokenEndpoint = str(body.tokenEndpoint);
      if (!tokenEndpoint) {
        return jsonResult(400, {
          error: "In-process redemption requires an explicit token endpoint.",
        });
      }
      const { headers, body: form } = buildJwtBearerRequest({
        assertion: str(body.assertion),
        clientId: str(body.clientId) || undefined,
        clientSecret: str(body.clientSecret) || undefined,
        scope: str(body.scope) || undefined,
        resource: str(body.resource) || undefined,
        tokenEndpointAuthMethod: isTokenAuthMethod(body.tokenEndpointAuthMethod)
          ? body.tokenEndpointAuthMethod
          : undefined,
      });
      const upstream = await executeOAuthProxy({
        url: tokenEndpoint,
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        httpsOnly,
        timeoutMs,
      });
      return jsonResult(200, { status: upstream.status, body: upstream.body });
    }

    return jsonResult(404, { error: `Unknown internal route: ${path}` });
  };

  const externalRequest = async (
    url: string,
    init?: RequestInit,
    options?: XAAExternalRequestOptions
  ): Promise<XAARequestResult> => {
    // Preserve the caller's redirect intent (CIMD's document preflight sends
    // `redirect: "manual"` and MUST NOT follow redirects) and normalize the
    // headers regardless of whether they arrive as a Record, Headers, or tuples.
    const redirect =
      init?.redirect === "manual"
        ? "manual"
        : init?.redirect === "follow"
        ? "follow"
        : undefined;
    // `enforcePublicHost` (the caller-influenced CIMD document fetch) uses the
    // connection-pinned GET: resolve once, reject private/reserved (RFC 6890),
    // and pin the validated IP into the socket so there is no second DNS
    // resolution to rebind. This holds even with the executor's local-dev
    // `httpsOnly: false` default, and never touches the loopback RS calls.
    if (options?.enforcePublicHost === true) {
      const pinned = await fetchPinnedPublicDocument(url, {
        headers: normalizeHeaders(init?.headers),
        timeoutMs,
      });
      return {
        status: pinned.status,
        statusText: pinned.statusText,
        headers: pinned.headers,
        body: pinned.body,
        ok: pinned.status >= 200 && pinned.status < 300,
      };
    }
    const response = await executeDebugOAuthProxy({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: normalizeHeaders(init?.headers),
      body: init?.body ?? undefined,
      httpsOnly,
      ...(redirect ? { redirect } : {}),
      timeoutMs,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      ok: response.status >= 200 && response.status < 300,
    };
  };

  return { internalRequest, externalRequest };
}

function isTokenAuthMethod(
  value: unknown
): value is "client_secret_post" | "client_secret_basic" | "none" {
  return (
    value === "client_secret_post" ||
    value === "client_secret_basic" ||
    value === "none"
  );
}
