import { createPublicKey, createVerify, type KeyObject } from "crypto";

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

export type VerifiedHostedJwtPayload = {
  sub: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
};

type VerifierConfig = {
  jwksUrl: string;
  issuer: string;
  audiences: string[];
  jwksCacheTtlMs: number;
  requestTimeoutMs: number;
  clockSkewSeconds: number;
};

type CachedJwks = {
  expiresAt: number;
  keysByKid: Map<string, KeyObject>;
};

export class HostedJwtVerificationError extends Error {
  code:
    | "misconfigured"
    | "invalid_token"
    | "invalid_claims"
    | "token_expired"
    | "jwks_unavailable";
  status: number;

  constructor(
    code: HostedJwtVerificationError["code"],
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "HostedJwtVerificationError";
    this.code = code;
    this.status = status;
  }
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseRequiredConfig(): VerifierConfig {
  const jwksUrl = process.env.MCPJAM_JWKS_URL?.trim();
  const issuer = process.env.MCPJAM_JWT_ISSUER?.trim();
  const audiences = (process.env.MCPJAM_JWT_AUDIENCE || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!jwksUrl) {
    throw new HostedJwtVerificationError(
      "misconfigured",
      "MCPJAM_JWKS_URL is required in hosted mode.",
      500,
    );
  }

  if (!issuer) {
    throw new HostedJwtVerificationError(
      "misconfigured",
      "MCPJAM_JWT_ISSUER is required in hosted mode.",
      500,
    );
  }

  if (audiences.length === 0) {
    throw new HostedJwtVerificationError(
      "misconfigured",
      "MCPJAM_JWT_AUDIENCE is required in hosted mode.",
      500,
    );
  }

  return {
    jwksUrl,
    issuer: normalizeIssuer(issuer),
    audiences,
    jwksCacheTtlMs: Number(process.env.MCPJAM_JWKS_CACHE_TTL_MS || 300_000),
    requestTimeoutMs: Number(process.env.MCPJAM_JWKS_TIMEOUT_MS || 5_000),
    clockSkewSeconds: Number(process.env.MCPJAM_JWT_CLOCK_SKEW_SECONDS || 30),
  };
}

function decodeBase64Url(input: string): Buffer {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function parseJsonPart<T>(input: string, partName: string): T {
  try {
    return JSON.parse(decodeBase64Url(input).toString("utf8")) as T;
  } catch {
    throw new HostedJwtVerificationError(
      "invalid_token",
      `Invalid JWT ${partName}`,
      401,
    );
  }
}

function ensureAudience(
  payloadAud: unknown,
  acceptedAudiences: string[],
): boolean {
  if (typeof payloadAud === "string") {
    return acceptedAudiences.includes(payloadAud);
  }

  if (Array.isArray(payloadAud)) {
    return payloadAud.some(
      (value) => typeof value === "string" && acceptedAudiences.includes(value),
    );
  }

  return false;
}

export class HostedJwtVerifier {
  private cache: CachedJwks | null = null;

  async verify(token: string): Promise<VerifiedHostedJwtPayload> {
    const config = parseRequiredConfig();
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new HostedJwtVerificationError(
        "invalid_token",
        "JWT must have exactly 3 parts.",
        401,
      );
    }

    const header = parseJsonPart<JwtHeader>(parts[0], "header");
    const payload = parseJsonPart<VerifiedHostedJwtPayload>(
      parts[1],
      "payload",
    );
    const signature = decodeBase64Url(parts[2]);
    const signingInput = `${parts[0]}.${parts[1]}`;

    if (header.alg !== "RS256") {
      throw new HostedJwtVerificationError(
        "invalid_token",
        "Unsupported JWT alg. Expected RS256.",
        401,
      );
    }

    if (!header.kid || typeof header.kid !== "string") {
      throw new HostedJwtVerificationError(
        "invalid_token",
        "JWT kid is required.",
        401,
      );
    }

    let key = await this.getKey(header.kid, config, false);
    if (!key) {
      key = await this.getKey(header.kid, config, true);
    }

    if (!key) {
      throw new HostedJwtVerificationError(
        "invalid_token",
        "Unable to resolve signing key for JWT kid.",
        401,
      );
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();

    const validSignature = verifier.verify(key, signature);
    if (!validSignature) {
      throw new HostedJwtVerificationError(
        "invalid_token",
        "JWT signature verification failed.",
        401,
      );
    }

    this.validateClaims(payload, config);
    return payload;
  }

  private validateClaims(
    payload: VerifiedHostedJwtPayload,
    config: VerifierConfig,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const skew = config.clockSkewSeconds;

    if (!payload.sub || typeof payload.sub !== "string") {
      throw new HostedJwtVerificationError(
        "invalid_claims",
        "JWT subject (sub) is required.",
        401,
      );
    }

    if (!payload.iss || typeof payload.iss !== "string") {
      throw new HostedJwtVerificationError(
        "invalid_claims",
        "JWT issuer (iss) is required.",
        401,
      );
    }

    if (normalizeIssuer(payload.iss) !== config.issuer) {
      throw new HostedJwtVerificationError(
        "invalid_claims",
        "JWT issuer does not match expected issuer.",
        401,
      );
    }

    if (!ensureAudience(payload.aud, config.audiences)) {
      throw new HostedJwtVerificationError(
        "invalid_claims",
        "JWT audience does not match expected audience.",
        401,
      );
    }

    if (typeof payload.exp !== "number") {
      throw new HostedJwtVerificationError(
        "invalid_claims",
        "JWT expiration (exp) is required.",
        401,
      );
    }

    if (now - skew >= payload.exp) {
      throw new HostedJwtVerificationError(
        "token_expired",
        "JWT is expired.",
        401,
      );
    }

    if (typeof payload.nbf === "number" && now + skew < payload.nbf) {
      throw new HostedJwtVerificationError(
        "invalid_claims",
        "JWT is not valid yet (nbf).",
        401,
      );
    }
  }

  private async getKey(
    kid: string,
    config: VerifierConfig,
    forceRefresh: boolean,
  ): Promise<KeyObject | undefined> {
    const now = Date.now();
    const cacheExpired = !this.cache || this.cache.expiresAt <= now;

    if (forceRefresh || cacheExpired) {
      this.cache = await this.fetchJwks(config);
    }

    return this.cache.keysByKid.get(kid);
  }

  private async fetchJwks(config: VerifierConfig): Promise<CachedJwks> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.requestTimeoutMs,
    );

    try {
      const response = await fetch(config.jwksUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new HostedJwtVerificationError(
          "jwks_unavailable",
          `Failed to fetch JWKS (${response.status}).`,
          503,
        );
      }

      const data = (await response.json()) as {
        keys?: Array<Record<string, unknown>>;
      };

      if (!Array.isArray(data.keys)) {
        throw new HostedJwtVerificationError(
          "jwks_unavailable",
          "JWKS response missing keys array.",
          503,
        );
      }

      const keysByKid = new Map<string, KeyObject>();

      for (const key of data.keys) {
        const kid = typeof key.kid === "string" ? key.kid : null;
        const kty = typeof key.kty === "string" ? key.kty : null;
        const n = typeof key.n === "string" ? key.n : null;
        const e = typeof key.e === "string" ? key.e : null;
        if (!kid || kty !== "RSA" || !n || !e) continue;

        const publicKey = createPublicKey({
          key: {
            kty,
            n,
            e,
          },
          format: "jwk",
        });
        keysByKid.set(kid, publicKey);
      }

      if (keysByKid.size === 0) {
        throw new HostedJwtVerificationError(
          "jwks_unavailable",
          "No usable RSA keys found in JWKS.",
          503,
        );
      }

      return {
        expiresAt: Date.now() + Math.max(1_000, config.jwksCacheTtlMs),
        keysByKid,
      };
    } catch (error) {
      if (error instanceof HostedJwtVerificationError) {
        throw error;
      }
      throw new HostedJwtVerificationError(
        "jwks_unavailable",
        error instanceof Error
          ? `Failed to fetch JWKS: ${error.message}`
          : "Failed to fetch JWKS",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

let sharedVerifier: HostedJwtVerifier | null = null;

export function resetHostedJwtVerifierForTests(): void {
  sharedVerifier = null;
}

export async function verifyHostedJwt(
  token: string,
): Promise<VerifiedHostedJwtPayload> {
  if (!sharedVerifier) {
    sharedVerifier = new HostedJwtVerifier();
  }
  return sharedVerifier.verify(token);
}
