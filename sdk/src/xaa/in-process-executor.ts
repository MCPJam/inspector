// Node-only in-process XAARequestExecutor — the CLI's "loopback" analog to the
// inspector's server-backed executor. It services the three MCPJam-owned mint
// routes (`/authenticate`, `/token-exchange`, `/proxy/token`) in-process using
// the node mint, and external AS/MCP requests through the hardened OAuth proxy.
// This is the seam that lets the CLI drive the shared browser-safe state machine
// without a running inspector server. Imports crypto/fs (mint) + node:dns
// (proxy) — MUST stay out of the browser entry.
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
} from "../oauth-proxy.js";
import { getXAAIssuerUrl, initXAAIdpKeyPair } from "./mint/keypair.js";
import { issueMockIdToken, issueNegativeIdJag } from "./mint/signer.js";
import { buildJwtBearerRequest } from "./mint/jwt-bearer.js";
import { decodeJWT } from "../oauth/state-machines/shared/jwt.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
} from "./constants.js";
import type {
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

function jsonResult(status: number, body: unknown): XAARequestResult {
  return {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : String(status),
    headers: { "content-type": "application/json" },
    body,
    ok: status >= 200 && status < 300,
  };
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Build a Node in-process executor. The internal-route switch is exhaustive; an
 * unrecognized MCPJam route returns 404 rather than silently succeeding.
 */
export function createInProcessXaaExecutor(
  options: InProcessXaaExecutorOptions,
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
    init?: RequestInit,
  ): Promise<XAARequestResult> => {
    const body = parseInitBody(init);

    // Mock OIDC login → id_token. Mirrors the server /authenticate route.
    if (path.endsWith("/authenticate")) {
      const { token } = issueMockIdToken({
        issuer: resolveIssuer(),
        subject: str(body.userId),
        email: str(body.email),
        audience: str(body.audience) || undefined,
      });
      return jsonResult(200, { id_token: token });
    }

    // Token exchange → ID-JAG. Decodes the identity assertion for sub/email,
    // exactly as the server /token-exchange route does, then mints (applying
    // the negative-test tamper when requested). Like the server route, a
    // missing/malformed assertion or one without a subject is a 400 — never a
    // silently minted empty-subject ID-JAG.
    if (path.endsWith("/token-exchange")) {
      const assertion = str(body.identityAssertion);
      if (!assertion) {
        return jsonResult(400, {
          error: "Token exchange requires a non-empty identity assertion.",
        });
      }
      const decoded = decodeJWT(assertion);
      if (!decoded) {
        return jsonResult(400, {
          error: "The identity assertion is not a decodable JWT.",
        });
      }
      const claims = asRecord(decoded);
      const subject = str(claims.sub);
      if (!subject) {
        return jsonResult(400, {
          error: "The identity assertion has no subject (`sub`) claim.",
        });
      }
      const mode = isNegativeTestMode(body.negativeTestMode)
        ? body.negativeTestMode
        : DEFAULT_NEGATIVE_TEST_MODE;
      const { token } = issueNegativeIdJag(
        {
          issuer: resolveIssuer(),
          subject,
          audience: str(body.audience),
          resource: str(body.resource),
          clientId: str(body.clientId),
          scope: str(body.scope) || undefined,
          email: typeof claims.email === "string" ? claims.email : undefined,
        },
        mode,
      );
      return jsonResult(200, { id_jag: token });
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
        headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
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
  ): Promise<XAARequestResult> => {
    const response = await executeDebugOAuthProxy({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body ?? undefined,
      httpsOnly,
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
  value: unknown,
): value is "client_secret_post" | "client_secret_basic" | "none" {
  return (
    value === "client_secret_post" ||
    value === "client_secret_basic" ||
    value === "none"
  );
}
