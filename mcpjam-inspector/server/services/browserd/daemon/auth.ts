/**
 * Per-request bearer authentication for browserd.
 *
 * EVERY `getHost(port)` E2B exposes is a public HTTPS endpoint (M0 finding), so
 * the daemon cannot rely on network isolation: it self-authenticates every
 * request against a per-boot token passed in `envs`. This mirrors the plugin
 * shim's posture (`shim/mcpjam-plugin-shim.mjs`); the helpers are re-expressed
 * in TypeScript here so the daemon control plane can import and test them.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The bearer credential a request presents, or "" when it presents none. */
export function presentedBearer(headerValue: string | undefined): string {
  if (typeof headerValue !== "string") return "";
  const separator = headerValue.indexOf(" ");
  if (separator === -1) return "";
  if (headerValue.slice(0, separator).toLowerCase() !== "bearer") return "";
  return headerValue.slice(separator + 1).trim();
}

/**
 * Per-process key so the digests below cannot be precomputed by an attacker who
 * knows the algorithm.
 */
const AUTH_DIGEST_KEY = randomBytes(32);

/**
 * Constant-time string comparison that is also constant-time in LENGTH.
 *
 * `timingSafeEqual` throws on unequal lengths, and the obvious length guard
 * returns early, leaking the token's length through response timing. Hashing
 * both sides to a fixed 32 bytes makes every comparison do identical work.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHmac("sha256", AUTH_DIGEST_KEY).update(a, "utf8").digest();
  const digestB = createHmac("sha256", AUTH_DIGEST_KEY).update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
