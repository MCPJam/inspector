import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  NEGATIVE_TEST_MODES,
  NEGATIVE_TEST_MODE_DETAILS,
  XAA_IDP_KID,
  type NegativeTestDiff,
  type NegativeTestMode,
} from "../../../shared/xaa.js";
import {
  getXAAIdpJwks,
  getXAAIssuerUrl,
  initXAAIdpKeyPair,
} from "../../services/xaa-idp-keypair.js";
import {
  issueIdJag,
  issueMockIdToken,
  issueNegativeIdJag,
} from "../../services/xaa-idjag-signer.js";
import {
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
  validateUrl,
} from "../../utils/oauth-proxy.js";
import {
  buildDiscoveryCandidates,
  evaluateDiscovery,
} from "../../services/xaa-discovery.js";
import { WebRouteError } from "../web/errors.js";
import type { XaaResourceAppSecretResult } from "../../utils/server-secrets.js";
import { logger } from "../../utils/logger.js";

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const NEGATIVE_TEST_CASE_TIMEOUT_MS = 8_000;

// Hard per-host daily cap on negative-test runs. This is a server-side
// backstop independent of the client-side "passed a positive run" gate: even
// with the override, a single authorization-server host can't be hammered.
const NEGATIVE_TEST_DAILY_CAP = 50;
const NEGATIVE_TEST_DAY_MS = 24 * 60 * 60 * 1000;
const negativeTestHostCounters = new Map<
  string,
  { count: number; windowStart: number }
>();

function checkNegativeTestHostCap(host: string): boolean {
  const now = Date.now();
  const existing = negativeTestHostCounters.get(host);
  if (!existing || now - existing.windowStart >= NEGATIVE_TEST_DAY_MS) {
    negativeTestHostCounters.set(host, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= NEGATIVE_TEST_DAILY_CAP) {
    return false;
  }
  existing.count += 1;
  return true;
}

const authenticateSchema = z.object({
  userId: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  audience: z.string().trim().min(1).optional(),
});

const tokenExchangeSchema = z.object({
  identityAssertion: z.string().trim().min(1),
  audience: z.string().trim().min(1),
  resource: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  scope: z.string().trim().min(1).optional(),
  negativeTestMode: z.string().trim().optional(),
});

const discoverAsSchema = z
  .object({
    issuer: z.string().trim().min(1).optional(),
    tokenEndpoint: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.issuer || data.tokenEndpoint, {
    message: "issuer or tokenEndpoint is required",
  });

const healthCheckSchema = z.object({
  url: z.string().trim().min(1),
});

const negativeTestsSchema = z
  .object({
    audience: z.string().trim().min(1),
    resource: z.string().trim().min(1),
    subject: z.string().trim().min(1).optional(),
    clientId: z.string().trim().min(1).optional(),
    scope: z.string().trim().min(1).optional(),
    tokenEndpoint: z.string().trim().min(1).optional(),
    clientSecret: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    registrationId: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.registrationId || data.tokenEndpoint, {
    message: "tokenEndpoint or registrationId is required",
  });

type NegativeCaseOutcome = {
  mode: NegativeTestMode;
  label: string;
  expectedFailure: string;
  // What the authorization server did with the deliberately-broken assertion.
  outcome: "rejected" | "accepted" | "timeout" | "error";
  // pass = the AS correctly rejected the broken assertion; fail = the AS
  // issued a token for it (a real security finding); unknown = couldn't tell.
  verdict: "pass" | "fail" | "unknown";
  status?: number;
  detail?: string;
  // What the broken assertion changed vs. a valid one, for the scorecard diff.
  diff?: NegativeTestDiff;
};

// The 11 deliberately-broken modes (everything except the happy-path "valid").
const NEGATIVE_CASE_MODES: NegativeTestMode[] = NEGATIVE_TEST_MODES.filter(
  (mode): mode is NegativeTestMode => mode !== "valid"
);

// Build the "sent X / expected Y" diff from the assertion the signer actually
// emitted (header + payload), so the displayed values can't drift from the
// real mutation. `expected` is the value a valid ID-JAG would carry.
function buildNegativeDiff(
  mode: NegativeTestMode,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  expected: {
    audience: string;
    resource: string;
    clientId: string;
    subject: string;
    scope?: string;
    issuer: string;
  }
): NegativeTestDiff | undefined {
  const show = (value: unknown): string =>
    value === undefined || value === null ? "(omitted)" : String(value);

  switch (mode) {
    case "bad_signature":
      return {
        field: "signature",
        sent: "signed with a throwaway key",
        expected: "signed with the published JWKS key",
      };
    case "wrong_audience":
      return {
        field: "aud",
        sent: show(payload.aud),
        expected: expected.audience,
      };
    case "expired":
      return {
        field: "exp",
        sent: `${new Date(Number(payload.exp) * 1000).toISOString()} (past)`,
        expected: "a time in the future",
      };
    case "missing_claims":
      return {
        field: "sub, resource",
        sent: "(omitted)",
        expected: "both present",
      };
    case "invalid_type_header":
      return {
        field: "typ",
        sent: show(header.typ),
        expected: "oauth-id-jag+jwt",
      };
    case "wrong_issuer":
      return {
        field: "iss",
        sent: show(payload.iss),
        expected: expected.issuer,
      };
    case "resource_mismatch":
      return {
        field: "resource",
        sent: show(payload.resource),
        expected: expected.resource,
      };
    case "client_id_mismatch":
      return {
        field: "client_id",
        sent: show(payload.client_id),
        expected: expected.clientId,
      };
    case "unknown_kid":
      return {
        field: "kid",
        sent: show(header.kid),
        expected: XAA_IDP_KID,
      };
    case "unknown_sub":
      return {
        field: "sub",
        sent: show(payload.sub),
        expected: expected.subject,
      };
    case "scope_denial":
      return {
        field: "scope",
        sent: show(payload.scope),
        expected: expected.scope || "only the user's granted scopes",
      };
    default:
      return undefined;
  }
}

const proxyTokenSchema = z
  .object({
    tokenEndpoint: z.string().trim().min(1).optional(),
    assertion: z.string().trim().min(1),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z.string().trim().min(1).optional(),
    scope: z.string().trim().min(1).optional(),
    resource: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Registration-backed runs: the server resolves the stored secret and
    // forces the outbound URL to the registration's stored token endpoint.
    registrationId: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.registrationId || data.tokenEndpoint, {
    message: "tokenEndpoint or registrationId is required",
  });

interface CreateXaaRouterOptions {
  issuerBasePath: "/api/mcp" | "/api/web";
  httpsOnlyProxy: boolean;
  // When behind a TLS-terminating proxy (hosted mode), the issuer scheme must
  // be reconstructed from X-Forwarded-Proto because c.req.url is http://
  // internally. Leave false for local (no proxy) so the header can't be
  // spoofed into advertising https for a plain-http localhost run.
  trustForwardedHeaders?: boolean;
  protectedMiddlewares?: MiddlewareHandler[];
  // Resolves a registered resource app's client secret + stored token
  // endpoint server-side (hosted instance only). When absent — the
  // unauthenticated local instance — registration-backed proxy requests are
  // rejected.
  resolveRegistrationSecret?: (args: {
    registrationId: string;
    bearerToken: string;
  }) => Promise<XaaResourceAppSecretResult>;
}

type ParsedJwtPayload = {
  sub?: string;
  email?: string;
};

function toJsonError(
  message: string,
  options?: {
    status?: number;
    code?: string;
    details?: Record<string, unknown>;
  }
) {
  const status = options?.status ?? 500;
  const code = options?.code ?? "INTERNAL_ERROR";

  return Response.json(
    {
      code,
      message,
      error: message,
      ...(options?.details ? { details: options.details } : {}),
    },
    { status }
  );
}

function parseRequest<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message || "Request validation failed"
    );
  }
  return parsed.data;
}

function getIssuerForRequest(
  c: Context,
  issuerBasePath: string,
  trustForwardedHeaders: boolean
): string {
  const parsed = new URL(c.req.url);

  if (trustForwardedHeaders) {
    // Only the scheme is reconstructed from a forwarded header: the edge
    // terminates TLS so c.req.url is http:// internally. The host already
    // comes from the validated Host header in c.req.url, so we do NOT trust
    // X-Forwarded-Host — honoring it would let a client inject an arbitrary
    // issuer/jwks_uri (and a forged `iss` on the signed ID-JAG). Restrict to
    // a known scheme so a forwarded value can't switch to another protocol.
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    if (proto === "https" || proto === "http") {
      parsed.protocol = proto;
    }
  }

  return getXAAIssuerUrl(`${parsed.origin}${issuerBasePath}`);
}

function decodeJwtPayloadUnsafe(token: string): ParsedJwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Identity assertion must be a JWT");
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    ) as ParsedJwtPayload;
    return payload;
  } catch (error) {
    throw new Error(
      `Identity assertion payload is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }
}

function resolveNegativeTestMode(value?: string): NegativeTestMode {
  if (!value) {
    return DEFAULT_NEGATIVE_TEST_MODE;
  }

  if (!isNegativeTestMode(value)) {
    throw new Error(`Unsupported negative test mode: ${value}`);
  }

  return value;
}

export function createXaaRouter(options: CreateXaaRouterOptions): Hono {
  const router = new Hono();
  const protectedMiddlewares = options.protectedMiddlewares ?? [];
  const trustForwardedHeaders = options.trustForwardedHeaders ?? false;

  if (protectedMiddlewares.length > 0) {
    router.use("/authenticate", ...protectedMiddlewares);
    router.use("/token-exchange", ...protectedMiddlewares);
    router.use("/proxy/token", ...protectedMiddlewares);
    router.use("/discover-as", ...protectedMiddlewares);
    router.use("/health-check", ...protectedMiddlewares);
    router.use("/negative-tests", ...protectedMiddlewares);
  }

  router.get("/.well-known/jwks.json", (c) => {
    initXAAIdpKeyPair();
    return c.json(getXAAIdpJwks(), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  router.get("/.well-known/openid-configuration", (c) => {
    initXAAIdpKeyPair();
    const issuer = getIssuerForRequest(
      c,
      options.issuerBasePath,
      trustForwardedHeaders
    );

    return c.json(
      {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        authorization_endpoint: `${issuer}/authenticate`,
        token_endpoint: `${issuer}/token-exchange`,
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        grant_types_supported: [
          "urn:ietf:params:oauth:grant-type:token-exchange",
        ],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        id_token_signing_alg_values_supported: ["RS256"],
      },
      200,
      {
        "Cache-Control": "public, max-age=300",
      }
    );
  });

  router.post("/authenticate", async (c) => {
    try {
      const body = await c.req.json();
      const { userId, email, audience } = parseRequest(
        authenticateSchema,
        body
      );
      const issuer = getIssuerForRequest(
        c,
        options.issuerBasePath,
        trustForwardedHeaders
      );
      const subject = userId || "user-12345";
      const resolvedEmail = email || "demo.user@example.com";
      const issued = issueMockIdToken({
        issuer,
        subject,
        email: resolvedEmail,
        audience,
      });

      return c.json({
        id_token: issued.token,
        token_type: "Bearer",
        expires_in: Math.max(
          0,
          Math.floor((issued.expiresAt - Date.now()) / 1000)
        ),
        user: {
          sub: subject,
          email: resolvedEmail,
        },
      });
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid authenticate request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }
  });

  router.post("/token-exchange", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = parseRequest(tokenExchangeSchema, body);
      const negativeTestMode = resolveNegativeTestMode(parsed.negativeTestMode);
      const issuer = getIssuerForRequest(
        c,
        options.issuerBasePath,
        trustForwardedHeaders
      );
      const identityPayload = decodeJwtPayloadUnsafe(parsed.identityAssertion);
      const subject = identityPayload.sub || "user-12345";
      // Carry the ID token's email into the ID-JAG (spec RECOMMENDED) so the
      // Resource AS can use it for subject resolution / JIT provisioning.
      const email =
        typeof identityPayload.email === "string"
          ? identityPayload.email
          : undefined;

      const issued =
        negativeTestMode === "valid"
          ? issueIdJag({
              issuer,
              subject,
              email,
              audience: parsed.audience,
              resource: parsed.resource,
              clientId: parsed.clientId,
              scope: parsed.scope,
            })
          : issueNegativeIdJag(
              {
                issuer,
                subject,
                email,
                audience: parsed.audience,
                resource: parsed.resource,
                clientId: parsed.clientId,
                scope: parsed.scope,
              },
              negativeTestMode
            );

      return c.json({
        id_jag: issued.token,
        token_type: "N_A",
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        expires_in: Math.max(
          0,
          Math.floor((issued.expiresAt - Date.now()) / 1000)
        ),
        negative_test_mode: negativeTestMode,
      });
    } catch (error) {
      return toJsonError(
        error instanceof Error
          ? error.message
          : "Invalid token exchange request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }
  });

  router.post("/proxy/token", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = parseRequest(proxyTokenSchema, body);

      let url: string;
      let clientId = parsed.clientId;
      let clientSecret = parsed.clientSecret;
      let extraHeaders = parsed.headers;

      if (parsed.registrationId) {
        if (!options.resolveRegistrationSecret) {
          return toJsonError(
            "Registration-backed runs are not available on this instance",
            { status: 400, code: "VALIDATION_ERROR" }
          );
        }

        const authHeader = c.req.header("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return toJsonError("Missing or invalid bearer token", {
            status: 401,
            code: "UNAUTHORIZED",
          });
        }

        const resolved = await options.resolveRegistrationSecret({
          registrationId: parsed.registrationId,
          bearerToken: authHeader.slice("Bearer ".length),
        });

        if (!resolved.tokenEndpoint) {
          return toJsonError("The registration has no stored token endpoint", {
            status: 400,
            code: "VALIDATION_ERROR",
          });
        }

        // The stored secret is only ever posted to the registration's stored
        // token endpoint. Client-supplied tokenEndpoint/headers/clientSecret
        // are discarded so a caller can't redirect the secret elsewhere.
        url = resolved.tokenEndpoint;
        clientId = resolved.targetClientId ?? parsed.clientId;
        clientSecret = resolved.clientSecret;
        extraHeaders = undefined;
      } else {
        url = parsed.tokenEndpoint as string;
      }

      const result = await executeOAuthProxy({
        url,
        method: "POST",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: parsed.assertion,
          ...(clientId ? { client_id: clientId } : {}),
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          ...(parsed.scope ? { scope: parsed.scope } : {}),
          ...(parsed.resource ? { resource: parsed.resource } : {}),
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(extraHeaders || {}),
        },
        httpsOnly: options.httpsOnlyProxy,
      });

      return c.json(result);
    } catch (error) {
      if (error instanceof OAuthProxyError) {
        return toJsonError(error.message, {
          status: error.status,
          code:
            error.status === 400 ? "VALIDATION_ERROR" : "SERVER_UNREACHABLE",
        });
      }

      if (error instanceof WebRouteError) {
        return toJsonError(error.message, {
          status: error.status,
          code: error.code,
        });
      }

      logger.error("[XAA Token Proxy] Error", error);
      return toJsonError(
        error instanceof Error ? error.message : "Unknown proxy error",
        { status: 500, code: "INTERNAL_ERROR" }
      );
    }
  });

  router.post("/discover-as", async (c) => {
    let parsed;
    try {
      parsed = parseRequest(discoverAsSchema, await c.req.json());
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid discovery request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }

    const requestedIssuer = (parsed.issuer ?? parsed.tokenEndpoint) as string;

    let candidates: string[];
    try {
      candidates = buildDiscoveryCandidates(requestedIssuer);
    } catch {
      return toJsonError("issuer or tokenEndpoint is not a valid URL", {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    try {
      const triedStatuses: Array<{ url: string; status: number }> = [];
      for (const candidate of candidates) {
        const result = await fetchOAuthMetadata(
          candidate,
          options.httpsOnlyProxy
        );
        if ("metadata" in result) {
          return c.json(
            evaluateDiscovery(result.metadata, {
              requestedIssuer,
              metadataUrl: candidate,
            })
          );
        }
        triedStatuses.push({ url: candidate, status: result.status });
      }

      return toJsonError(
        "No authorization server metadata found at the well-known endpoints",
        {
          status: 404,
          code: "DISCOVERY_NOT_FOUND",
          details: { tried: triedStatuses },
        }
      );
    } catch (error) {
      // validateUrl inside fetchOAuthMetadata rejects disallowed outbound URLs
      // (e.g. private/reserved hosts, or http in hosted mode). Every candidate
      // shares the same host, so a guard rejection is terminal.
      if (error instanceof OAuthProxyError) {
        return toJsonError("URL not allowed", {
          status: error.status,
          code: "VALIDATION_ERROR",
        });
      }
      logger.error("[XAA Discover AS] Error", error);
      return toJsonError(
        error instanceof Error ? error.message : "Discovery failed",
        { status: 502, code: "SERVER_UNREACHABLE" }
      );
    }
  });

  router.post("/health-check", async (c) => {
    let parsed;
    try {
      parsed = parseRequest(healthCheckSchema, await c.req.json());
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid health check request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }

    let validatedUrl: URL;
    try {
      ({ url: validatedUrl } = await validateUrl(
        parsed.url,
        options.httpsOnlyProxy
      ));
    } catch (error) {
      if (error instanceof OAuthProxyError) {
        return toJsonError("URL not allowed", {
          status: error.status,
          code: "VALIDATION_ERROR",
        });
      }
      return toJsonError("URL not allowed", {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(validatedUrl.toString(), {
        method: "GET",
        // In hosted mode redirects are not followed, so a redirect to an
        // internal address can never be fetched.
        redirect: options.httpsOnlyProxy ? "manual" : "follow",
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        headers: { "User-Agent": "MCP-Inspector/1.0" },
      });

      const redirected =
        options.httpsOnlyProxy &&
        response.status >= 300 &&
        response.status < 400;

      return c.json({
        ok: !redirected && response.status < 400,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
        ...(redirected ? { reason: "redirect_not_followed" } : {}),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return c.json({
        ok: false,
        reason: isTimeout ? "timeout" : "unreachable",
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Negative-test scorecard: fire each deliberately-broken ID-JAG mode at the
  // user's authorization server and report whether the server correctly
  // rejected it (pass) or wrongly issued a token (fail — a real finding).
  router.post("/negative-tests", async (c) => {
    let parsed;
    try {
      parsed = parseRequest(negativeTestsSchema, await c.req.json());
    } catch (error) {
      return toJsonError(
        error instanceof Error
          ? error.message
          : "Invalid negative-tests request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }

    // Resolve the authorization-server target. Registration-backed runs
    // resolve the stored secret + endpoint server-side (same hardening as
    // /proxy/token); the client-supplied endpoint/headers/secret are ignored.
    let tokenEndpoint: string;
    let clientId = parsed.clientId;
    let clientSecret = parsed.clientSecret;
    let extraHeaders = parsed.headers;

    try {
      if (parsed.registrationId) {
        if (!options.resolveRegistrationSecret) {
          return toJsonError(
            "Registration-backed runs are not available on this instance",
            { status: 400, code: "VALIDATION_ERROR" }
          );
        }
        const authHeader = c.req.header("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return toJsonError("Missing or invalid bearer token", {
            status: 401,
            code: "UNAUTHORIZED",
          });
        }
        const resolved = await options.resolveRegistrationSecret({
          registrationId: parsed.registrationId,
          bearerToken: authHeader.slice("Bearer ".length),
        });
        if (!resolved.tokenEndpoint) {
          // mcpjam-issuer-only registration: there is no external auth server
          // to fire broken assertions at.
          return toJsonError(
            "Negative tests require a registration with its own auth server",
            { status: 400, code: "VALIDATION_ERROR" }
          );
        }
        tokenEndpoint = resolved.tokenEndpoint;
        clientId = resolved.targetClientId ?? parsed.clientId;
        clientSecret = resolved.clientSecret;
        extraHeaders = undefined;
      } else {
        tokenEndpoint = parsed.tokenEndpoint as string;
      }
    } catch (error) {
      if (error instanceof WebRouteError) {
        return toJsonError(error.message, {
          status: error.status,
          code: error.code,
        });
      }
      throw error;
    }

    // Validate the outbound URL once (every case hits the same endpoint) and
    // enforce the per-host daily cap.
    let validated: URL;
    try {
      ({ url: validated } = await validateUrl(
        tokenEndpoint,
        options.httpsOnlyProxy
      ));
    } catch (error) {
      if (error instanceof OAuthProxyError) {
        return toJsonError("URL not allowed", {
          status: error.status,
          code: "VALIDATION_ERROR",
        });
      }
      return toJsonError("URL not allowed", {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    if (!checkNegativeTestHostCap(validated.host)) {
      return toJsonError(
        "Daily negative-test limit reached for this authorization server",
        { status: 429, code: "RATE_LIMITED" }
      );
    }

    const issuer = getIssuerForRequest(
      c,
      options.issuerBasePath,
      trustForwardedHeaders
    );
    const subject = parsed.subject || "user-12345";

    const runCase = async (
      mode: NegativeTestMode
    ): Promise<NegativeCaseOutcome> => {
      const details = NEGATIVE_TEST_MODE_DETAILS[mode];
      const resolvedClientId = clientId || "mcpjam-debugger";
      let token: string;
      let diff: NegativeTestDiff | undefined;
      try {
        const issued = issueNegativeIdJag(
          {
            issuer,
            subject,
            audience: parsed.audience,
            resource: parsed.resource,
            clientId: resolvedClientId,
            scope: parsed.scope,
          },
          mode
        );
        token = issued.token;
        diff = buildNegativeDiff(mode, issued.header, issued.payload, {
          audience: parsed.audience,
          resource: parsed.resource,
          clientId: resolvedClientId,
          subject,
          scope: parsed.scope,
          issuer,
        });
      } catch (error) {
        return {
          mode,
          label: details.label,
          expectedFailure: details.expectedFailure,
          outcome: "error",
          verdict: "unknown",
          detail:
            error instanceof Error ? error.message : "Failed to mint ID-JAG",
        };
      }

      const form = new URLSearchParams();
      form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      form.set("assertion", token);
      if (clientId) form.set("client_id", clientId);
      if (clientSecret) form.set("client_secret", clientSecret);
      if (parsed.scope) form.set("scope", parsed.scope);
      form.set("resource", parsed.resource);

      try {
        const response = await fetch(validated.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "MCP-Inspector/1.0",
            ...(extraHeaders || {}),
          },
          body: form.toString(),
          redirect: options.httpsOnlyProxy ? "manual" : "follow",
          signal: AbortSignal.timeout(NEGATIVE_TEST_CASE_TIMEOUT_MS),
        });

        let body: any = null;
        try {
          body = await response.json();
        } catch {
          // non-JSON response; body stays null
        }

        const accepted =
          response.status >= 200 &&
          response.status < 300 &&
          typeof body?.access_token === "string";

        return {
          mode,
          label: details.label,
          expectedFailure: details.expectedFailure,
          outcome: accepted ? "accepted" : "rejected",
          verdict: accepted ? "fail" : "pass",
          status: response.status,
          detail: accepted
            ? `The auth server returned HTTP ${response.status} with an access token for this broken assertion. ` +
              `This test ${details.description.charAt(0).toLowerCase()}${details.description.slice(1)} ` +
              `${details.expectedFailure} Because a token was issued instead, a malformed or unauthorized ` +
              `assertion would be accepted in production.`
            : undefined,
          diff,
        };
      } catch (error) {
        const isTimeout =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        return {
          mode,
          label: details.label,
          expectedFailure: details.expectedFailure,
          outcome: isTimeout ? "timeout" : "error",
          // Couldn't reach a verdict — surfaced separately from a real finding.
          verdict: "unknown",
          diff,
          detail: isTimeout
            ? `No response within ${NEGATIVE_TEST_CASE_TIMEOUT_MS}ms`
            : error instanceof Error
            ? error.message
            : "Request failed",
        };
      }
    };

    // Each case has its own timeout and resolves independently, so one slow
    // or hanging authorization server can't sink the whole scorecard.
    const results = await Promise.all(NEGATIVE_CASE_MODES.map(runCase));

    return c.json({
      results,
      failures: results.filter((r) => r.verdict === "fail").length,
    });
  });

  return router;
}

const xaa = createXaaRouter({
  issuerBasePath: "/api/mcp",
  httpsOnlyProxy: false,
});

export default xaa;
