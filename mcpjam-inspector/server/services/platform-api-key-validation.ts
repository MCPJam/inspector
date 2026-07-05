import { createHash } from "node:crypto";
import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "./internal-backend.js";

/**
 * Validation client for Convex-native platform API keys (`sk_mcpjam_…`), the
 * successor to WorkOS key validation + org-binding lookup.
 *
 * The inspector hashes the presented key locally and asks the backend's
 * service-token-gated validate route whether that hash maps to a live key.
 * The backend re-checks org membership and revocation, so a single round trip
 * replaces the old WorkOS validate + binding lookup pair.
 */

/**
 * SHA-256 hex of the full `sk_…` value. MUST match the backend's `sha256Hex`
 * (Web Crypto SHA-256, lowercase hex) so a key minted there validates here.
 */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface ValidatedPlatformApiKey {
  keyId: string;
  userId: string;
  /** WorkOS `sub` — carried on `x-mcpjam-acting-as` for delegated `/api/v1/*`. */
  externalId: string;
  organizationId: string;
}

const VALIDATE_PATH = "/internal/v1/api-keys/validate";
const VALIDATE_TIMEOUT_MS = 15_000;

/**
 * Returns the key's identity, or `null` when the key is unknown / revoked /
 * its owner lost org membership (all collapsed to the backend's single
 * "Key not found" 404). Throws on transport failure or a routing-level 404
 * (route not deployed / wrong `CONVEX_HTTP_URL`) so a config error can't be
 * mistaken for an invalid key.
 */
export async function validatePlatformApiKey(
  tokenHash: string
): Promise<ValidatedPlatformApiKey | null> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const response = await fetch(`${convexUrl}${VALIDATE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inspector-service-token": serviceToken,
    },
    body: JSON.stringify({ tokenHash }),
    signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
  });

  if (response.status === 404) {
    if (await isEntityNotFound(response, "Key not found")) {
      return null;
    }
    throw new Error(
      `Platform API key validate route returned a routing 404 — is it deployed at ${convexUrl}${VALIDATE_PATH}?`
    );
  }
  if (!response.ok) {
    throw new Error(
      `Platform API key validate failed with status ${response.status}`
    );
  }

  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    keyId?: unknown;
    userId?: unknown;
    externalId?: unknown;
    organizationId?: unknown;
  } | null;
  if (
    !body ||
    body.ok !== true ||
    typeof body.keyId !== "string" ||
    typeof body.userId !== "string" ||
    typeof body.externalId !== "string" ||
    typeof body.organizationId !== "string"
  ) {
    throw new Error("Platform API key validate returned a malformed body");
  }
  return {
    keyId: body.keyId,
    userId: body.userId,
    externalId: body.externalId,
    organizationId: body.organizationId,
  };
}
