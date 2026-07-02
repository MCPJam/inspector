/**
 * Test-only signer that mints a harness MCP proxy token exactly as Convex does
 * (`mcpjam-backend/convex/lib/harnessMcpProxyToken.ts`), so tests can exercise
 * the inspector's verifier without a live backend. NOT a *.test.ts file → not
 * run as a suite; imported by the route/token tests. Requires
 * `COMPUTERS_TERMINAL_TOKEN_SECRET` to be set.
 */
import { createHmac } from "node:crypto";

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
