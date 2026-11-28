/**
 * Test-only signer that mints a harness MCP proxy token exactly as Convex does
 * (`mcpjam-backend/convex/lib/harnessMcpProxyToken.ts`), so tests can exercise
 * the inspector's verifier without a live backend. NOT a *.test.ts file → not
 * run as a suite; imported by the route/token tests. Requires
 * `COMPUTERS_TERMINAL_TOKEN_SECRET` to be set.
 */
import {
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

export function signTestProxyToken(
  claims: {
    serverId: string;
    userId?: string;
    externalId?: string;
    orgId?: string;
    projectId?: string;
  },
  opts: { nowS?: number; expS?: number } = {},
): string {
  const secret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
  if (!secret) throw new Error("set COMPUTERS_TERMINAL_TOKEN_SECRET in the test");
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://api.mcpjam.com/harness-mcp-proxy",
    purpose: "harness-mcp-proxy",
    sub: claims.userId ?? "user_convex_1",
    ext: claims.externalId ?? "user_ext_1",
    org: claims.orgId ?? "org_1",
    projectId: claims.projectId ?? "proj_1",
    serverId: claims.serverId,
    iat: now,
    exp: opts.expS ?? now + 3600,
  };
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const sig = createHmac("sha256", secret).update(input).digest("base64url");
  return `${input}.${sig}`;
}

/** An RS256 harness key, as the backend holds it, with its published JWKS. */
export function testHarnessKey(kid = "harness-test-1") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    jwks: {
      keys: [
        {
          ...publicKey.export({ format: "jwk" }),
          kid,
          alg: "RS256",
          use: "sig",
        },
      ],
    },
  };
}

/** A harness credential signed as the backend signs one under its RS256 key. */
export function signTestRs256Credential(
  payload: Record<string, unknown>,
  key: { kid: string; privateKey: KeyObject },
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: key.kid },
): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), key.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

/** Proxy-token claims as Convex mints them, for either signature. */
export function testProxyTokenPayload(
  claims: { serverId: string; projectId?: string },
  opts: { nowS?: number; expS?: number } = {},
): Record<string, unknown> {
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  return {
    iss: "https://api.mcpjam.com/harness-mcp-proxy",
    purpose: "harness-mcp-proxy",
    sub: "user_convex_1",
    ext: "user_ext_1",
    org: "org_1",
    projectId: claims.projectId ?? "proj_1",
    serverId: claims.serverId,
    iat: now,
    exp: opts.expS ?? now + 3600,
  };
}
