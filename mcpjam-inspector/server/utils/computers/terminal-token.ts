/**
 * Computer terminal token verification (data-plane side).
 *
 * Convex mints these (mcpjam-backend `projectComputers.mintTerminalToken`,
 * lib `computerTerminalToken.ts`) and the browser presents one when opening
 * the terminal WebSocket. We verify locally with the shared
 * `COMPUTERS_TERMINAL_TOKEN_SECRET` (HS256) — no Convex round trip on the
 * hot handshake path. The claim contract is owned by the backend lib; this
 * file is its verify-only mirror and must stay in lockstep:
 *   iss      'https://api.mcpjam.com/computer-terminal'
 *   purpose  'computer-terminal'  (REQUIRED — rejects every other JWT population)
 *   sub      Convex users id (owner)   computerId / projectId   exp ~60s
 *
 * The token deliberately carries only MCPJam row ids. The vendor sandbox id
 * is resolved server-side via the secret-gated `/computers/sandbox-info`
 * Convex route, so a browser holding this token learns nothing vendor-side.
 */

const ISSUER = "https://api.mcpjam.com/computer-terminal";
const PURPOSE = "computer-terminal";
const MIN_SECRET_LENGTH = 16;

export interface ComputerTerminalClaims {
  userId: string;
  computerId: string;
  projectId: string;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padLen = (4 - (input.length % 4)) % 4;
  const base64 =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Verify a terminal token: HMAC-SHA256 signature, issuer, required purpose
 * claim, and expiry. Returns the claims or `null`; never throws on malformed
 * input. Fails closed (null) when the shared secret is unconfigured.
 */
export async function verifyComputerTerminalToken(
  token: string
): Promise<ComputerTerminalClaims | null> {
  const secret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;

  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = base64UrlToBytes(s);
    // Copy into a standalone ArrayBuffer — the server tsconfig has no DOM
    // lib, so subtle.verify's BufferSource parameter needs an exact match.
    const signature = sigBytes.buffer.slice(
      sigBytes.byteOffset,
      sigBytes.byteOffset + sigBytes.byteLength
    ) as ArrayBuffer;
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`${h}.${p}`)
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p)));
  } catch {
    return null;
  }
  if (payload.iss !== ISSUER) return null;
  if (payload.purpose !== PURPOSE) return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (
    typeof payload.computerId !== "string" ||
    payload.computerId.length === 0
  ) {
    return null;
  }
  if (typeof payload.projectId !== "string" || payload.projectId.length === 0) {
    return null;
  }
  if (typeof payload.exp !== "number") return null;
  // JWT NumericDate semantics: the token is expired AT `exp`, not after it.
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;

  return {
    userId: payload.sub,
    computerId: payload.computerId,
    projectId: payload.projectId,
  };
}
