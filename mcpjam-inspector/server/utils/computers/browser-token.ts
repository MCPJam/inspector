/**
 * Computer browser token verification (Browser Panel side).
 *
 * Convex mints these (mcpjam-backend `projectComputers.mintBrowserToken`, lib
 * `computerBrowserToken.ts`) and the browser presents one when opening the
 * Browser Panel. The claim contract is owned by the backend lib; this file is
 * its verify-only mirror and must stay in lockstep:
 *   iss      'https://api.mcpjam.com/computer-browser'
 *   purpose  'computer-browser'   (REQUIRED — rejects every other JWT
 *                                  population, terminal tokens included)
 *   sub      Convex users id (owner)   computerId / projectId   exp ~60s
 *
 * RS256 only, verified against `GET {CONVEX_HTTP_URL}/computers/browser-jwks`
 * (kid `computer-browser-1`). The inspector holds verify-only material and can
 * never mint. Fails closed (`null`) whenever the key material is unavailable.
 *
 * Why the `purpose` claim carries real weight here: the panel exposes a live
 * view of someone's desktop over a public E2B host. A terminal token replayed
 * against this surface — same issuer family, same row ids, same signing
 * infrastructure — would otherwise open a screen its holder was never granted.
 */
import {
  createComputerJwksVerifier,
  type ComputerTokenClaims,
} from "./jwks-verifier.js";

export type ComputerBrowserClaims = ComputerTokenClaims;

const verifier = createComputerJwksVerifier({
  issuer: "https://api.mcpjam.com/computer-browser",
  purpose: "computer-browser",
  jwksPath: "/computers/browser-jwks",
  label: "browser",
});

/**
 * Verify a browser token (RS256 only). Returns the claims or `null`; never
 * throws on malformed input.
 */
export async function verifyComputerBrowserToken(
  token: string,
): Promise<ComputerBrowserClaims | null> {
  return verifier.verify(token);
}

export function resetComputerBrowserJwksCacheForTests(): void {
  verifier.resetCacheForTests();
}
