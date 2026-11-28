/**
 * The backend's token exchange (`POST /web/token-exchange`, mcpjam-backend
 * `convex/tokenExchangeRoutes.ts`), for `sk_` keys.
 *
 * The backend validates the key with WorkOS, checks its organization binding,
 * expiry and owner, and answers with a delegated token for the key's user in
 * the key's organization, for at most 10 minutes. This server never picks the
 * user: it forwards the caller's own credential.
 *
 * Behind `MCPJAM_TOKEN_EXCHANGE`. Off, `bearer-auth.ts` validates keys itself
 * and calls the backend with acting-as, exactly as before, so turning the
 * switch off is the rollback.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { AgentSurface } from "../utils/agent-attribution.js";
import { getInternalBackendConfig } from "./internal-backend.js";
import {
  INSPECTOR_SERVICE_TOKEN_HEADER,
  WORKOS_API_KEY_FEATURE,
} from "./service-credential.js";

const EXCHANGE_PATH = "/web/token-exchange";
const EXCHANGE_TIMEOUT_MS = 10_000;
/** A cached token is reused until this close to its expiry. */
const REFRESH_BEFORE_EXPIRY_MS = 60_000;

/** Whether `sk_` keys go through the exchange. Read per call, like `config.ts`. */
export function isTokenExchangeEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const value = env.MCPJAM_TOKEN_EXCHANGE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export type ExchangedApiKey = {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  apiKeyId: string;
  /** The key's MCPJam user (Convex id) and WorkOS user id. */
  userId: string;
  externalId: string;
  organizationId: string;
};

export type ApiKeyExchange =
  | { kind: "exchanged"; value: ExchangedApiKey }
  /** The backend refused the key: 401 unusable, 403 its user may not act. */
  | { kind: "refused"; status: 401 | 403; reason?: string; message?: string }
  /** The backend predates the exchange (no route), so keys are validated here. */
  | { kind: "unsupported" };

/**
 * Exchanged tokens by a keyed digest of the key and the surface. The raw key
 * is never stored: it lives only for the request that carried it and the
 * exchange call it makes. The digest is an HMAC under a random key made at
 * startup, so a digest means nothing outside this process. API keys are
 * long random values, so a fast keyed hash is the right tool here; a slow
 * password hash would only add latency to every request.
 */
const CACHE_DIGEST_KEY = randomBytes(32);
const exchangedByDigest = new Map<string, ExchangedApiKey>();
const inflightByDigest = new Map<string, Promise<ApiKeyExchange>>();

setInterval(() => {
  const now = Date.now();
  for (const [digest, entry] of exchangedByDigest) {
    if (entry.expiresAt <= now) exchangedByDigest.delete(digest);
  }
}, 5 * 60_000).unref();

function cacheKey(apiKey: string, surface: AgentSurface): string {
  return `${surface}:${createHmac("sha256", CACHE_DIGEST_KEY).update(apiKey).digest("hex")}`;
}

/**
 * The token for this key: cached until a minute before it expires, else
 * exchanged once however many requests ask at the same moment. Refusals are
 * never cached, so a fixed key works on its next request. Throws
 * `ServiceCredentialUnavailableError` on a server without the service
 * credential, and an `Error` when the backend can't be reached or fails.
 */
export async function exchangeApiKey(
  apiKey: string,
  surface: AgentSurface,
): Promise<ApiKeyExchange> {
  const key = cacheKey(apiKey, surface);
  const cached = exchangedByDigest.get(key);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
    return { kind: "exchanged", value: cached };
  }
  const inflight = inflightByDigest.get(key);
  if (inflight) return inflight;
  const exchange = requestExchange(apiKey, surface)
    .then((result) => {
      if (result.kind === "exchanged") exchangedByDigest.set(key, result.value);
      else exchangedByDigest.delete(key);
      return result;
    })
    .finally(() => inflightByDigest.delete(key));
  inflightByDigest.set(key, exchange);
  return exchange;
}

async function requestExchange(
  apiKey: string,
  surface: AgentSurface,
): Promise<ApiKeyExchange> {
  const { convexUrl, serviceToken } = getInternalBackendConfig(
    WORKOS_API_KEY_FEATURE,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${convexUrl}${EXCHANGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: serviceToken,
      },
      body: JSON.stringify({
        subject_token_type: "api_key",
        subject_token: apiKey,
        surface,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  // The exchange route never answers 404 itself; Convex routing does when
  // the backend predates it.
  if (response.status === 404) return { kind: "unsupported" };
  const body = await readJson(response);
  if (response.status === 401 || response.status === 403) {
    return {
      kind: "refused",
      status: response.status,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(typeof body.error === "string" ? { message: body.error } : {}),
    };
  }
  const exchanged = response.ok ? parseExchanged(body) : null;
  if (!exchanged) throw new Error(`Token exchange failed (${response.status})`);
  return { kind: "exchanged", value: exchanged };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {}; // Judged by its status, like any answer without a body.
  }
}

function parseExchanged(body: Record<string, unknown>): ExchangedApiKey | null {
  const { token, expiresAt, apiKeyId, userId, externalId, organizationId } =
    body;
  if (
    body.ok !== true ||
    typeof token !== "string" ||
    typeof expiresAt !== "number" ||
    typeof apiKeyId !== "string" ||
    typeof userId !== "string" ||
    typeof externalId !== "string" ||
    typeof organizationId !== "string"
  ) {
    return null;
  }
  return { token, expiresAt, apiKeyId, userId, externalId, organizationId };
}

/** Test-only: what the cache holds, to prove no raw key is kept. */
export function tokenExchangeCacheForTests(): {
  keys: string[];
  values: ExchangedApiKey[];
} {
  return {
    keys: [...exchangedByDigest.keys()],
    values: [...exchangedByDigest.values()],
  };
}

/** Test-only: forget every exchanged token. */
export function resetTokenExchangeCacheForTests(): void {
  exchangedByDigest.clear();
  inflightByDigest.clear();
}
