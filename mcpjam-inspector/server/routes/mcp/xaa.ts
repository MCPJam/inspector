import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
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
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";
import { logger } from "../../utils/logger.js";

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

const proxyTokenSchema = z.object({
  tokenEndpoint: z.string().trim().min(1),
  assertion: z.string().trim().min(1),
  clientId: z.string().trim().min(1).optional(),
  clientSecret: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  resource: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

interface CreateXaaRouterOptions {
  issuerBasePath: "/api/mcp" | "/api/web";
  httpsOnlyProxy: boolean;
  protectedMiddlewares?: MiddlewareHandler[];
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
  },
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
    { status },
  );
}

function parseRequest<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || "Request validation failed");
  }
  return parsed.data;
}

function getIssuerForRequest(requestUrl: string, issuerBasePath: string): string {
  const origin = new URL(requestUrl).origin;
  return getXAAIssuerUrl(`${origin}${issuerBasePath}`);
}

function decodeJwtPayloadUnsafe(token: string): ParsedJwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Identity assertion must be a JWT");
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    ) as ParsedJwtPayload;
    return payload;
  } catch (error) {
    throw new Error(
      `Identity assertion payload is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
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

  if (protectedMiddlewares.length > 0) {
    router.use("/authenticate", ...protectedMiddlewares);
    router.use("/token-exchange", ...protectedMiddlewares);
    router.use("/proxy/token", ...protectedMiddlewares);
  }

  router.get("/.well-known/jwks.json", (c) => {
    initXAAIdpKeyPair();
    return c.json(getXAAIdpJwks(), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  router.get("/.well-known/openid-configuration", (c) => {
    initXAAIdpKeyPair();
    const issuer = getIssuerForRequest(c.req.url, options.issuerBasePath);

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
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_post",
        ],
        id_token_signing_alg_values_supported: ["RS256"],
      },
      200,
      {
        "Cache-Control": "public, max-age=300",
      },
    );
  });

  router.post("/authenticate", async (c) => {
    try {
      const body = await c.req.json();
      const { userId, email, audience } = parseRequest(authenticateSchema, body);
      const issuer = getIssuerForRequest(c.req.url, options.issuerBasePath);
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
          Math.floor((issued.expiresAt - Date.now()) / 1000),
        ),
        user: {
          sub: subject,
          email: resolvedEmail,
        },
      });
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid authenticate request",
        { status: 400, code: "VALIDATION_ERROR" },
      );
    }
  });

  router.post("/token-exchange", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = parseRequest(tokenExchangeSchema, body);
      const negativeTestMode = resolveNegativeTestMode(parsed.negativeTestMode);
      const issuer = getIssuerForRequest(c.req.url, options.issuerBasePath);
      const identityPayload = decodeJwtPayloadUnsafe(parsed.identityAssertion);
      const subject = identityPayload.sub || "user-12345";

      const issued =
        negativeTestMode === "valid"
          ? issueIdJag({
              issuer,
              subject,
              audience: parsed.audience,
              resource: parsed.resource,
              clientId: parsed.clientId,
              scope: parsed.scope,
            })
          : issueNegativeIdJag(
              {
                issuer,
                subject,
                audience: parsed.audience,
                resource: parsed.resource,
                clientId: parsed.clientId,
                scope: parsed.scope,
              },
              negativeTestMode,
            );

      return c.json({
        id_jag: issued.token,
        token_type: "N_A",
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        expires_in: Math.max(
          0,
          Math.floor((issued.expiresAt - Date.now()) / 1000),
        ),
        negative_test_mode: negativeTestMode,
      });
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid token exchange request",
        { status: 400, code: "VALIDATION_ERROR" },
      );
    }
  });

  router.post("/proxy/token", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = parseRequest(proxyTokenSchema, body);
      const result = await executeOAuthProxy({
        url: parsed.tokenEndpoint,
        method: "POST",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: parsed.assertion,
          ...(parsed.clientId ? { client_id: parsed.clientId } : {}),
          ...(parsed.clientSecret ? { client_secret: parsed.clientSecret } : {}),
          ...(parsed.scope ? { scope: parsed.scope } : {}),
          ...(parsed.resource ? { resource: parsed.resource } : {}),
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(parsed.headers || {}),
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

      logger.error("[XAA Token Proxy] Error", error);
      return toJsonError(
        error instanceof Error ? error.message : "Unknown proxy error",
        { status: 500, code: "INTERNAL_ERROR" },
      );
    }
  });

  return router;
}

const xaa = createXaaRouter({
  issuerBasePath: "/api/mcp",
  httpsOnlyProxy: false,
});

export default xaa;
