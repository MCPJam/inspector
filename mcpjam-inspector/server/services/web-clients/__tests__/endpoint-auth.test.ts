import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetAuthKitJwksCacheForTests } from "../../authkit-jwt.js";
import { createStaticConnectorResolver } from "../connectors.js";
import {
  createWebConnectorEndpoint,
  mountWebConnectorEndpoint,
} from "../forwarding-endpoint.js";
import { createInMemoryToolCallLedger } from "../tool-call-ledger.js";
import { createInMemoryTurnWindowStore } from "../turn-windows.js";
import {
  ORIGIN,
  startFixtureServer,
  vendorClient,
} from "./forwarding-fixtures.js";

const recorder = { frame: () => undefined, client: () => undefined };
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("default AuthKit verifier", () => {
  const ISSUER = "https://auth.example.test";
  const PATH = "/mcp/conn_oauth_1";

  it("accepts an AuthKit token issued for this connector and refuses one for another resource", async () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_web_clients_test");
    vi.stubEnv("AUTHKIT_DOMAIN", "auth.example.test");
    resetAuthKitJwksCacheForTests();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${ISSUER}/oauth2/jwks`
        ? Promise.resolve(Response.json({ keys: [jwk] }))
        : realFetch(input, init),
    );
    const token = (audience: string, subject = "user_01TEST") =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setSubject(subject)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    const mayUse = vi.fn(async () => true);
    const connector = {
      connectorId: "conn_oauth_1",
      projectId: "proj_1",
      serverId: "srv_1",
      auth: "oauth" as const,
    };
    const app = new Hono();
    mountWebConnectorEndpoint(
      app,
      createWebConnectorEndpoint({
        resolver: {
          ...createStaticConnectorResolver([
            { connector, upstream: { url: fixture.url, headers: {} } },
          ]),
          mayUse,
        },
        turns: createInMemoryTurnWindowStore(),
        ledger: createInMemoryToolCallLedger(),
        recorder,
        isEnabled: async () => true,
      }),
    );

    const metadata = await app.request(
      `${ORIGIN}/.well-known/oauth-protected-resource${PATH}`,
    );
    expect((await metadata.json()).authorization_servers).toEqual([ISSUER]);

    const valid = await token(`${ORIGIN}${PATH}`);
    expect((await vendorClient(app, { path: PATH, token: valid }).initialize()).status).toBe(200);
    expect(mayUse).toHaveBeenCalledWith(connector, "user_01TEST");

    for (const refused of [
      await token("https://mcp.example.test/mcp"),
      await token(`${ORIGIN}${PATH}`, "agent_reg_01TEST"),
    ]) {
      const response = await vendorClient(app, { path: PATH, token: refused }).initialize();
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
  });
});
