import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { getConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

// Stand up a tiny IdP that plays MCPJam: serves openid-config + jwks and mints
// a signed ID-JAG. Returns the issuer URL, a minter, and a close fn.
async function startFakeIdp() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "xaa-idp-1",
    alg: "RS256",
    use: "sig",
  };
  let issuer = "";
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
        }),
      );
    }
    if (req.url === "/.well-known/jwks.json") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  issuer = `http://localhost:${(server.address() as { port: number }).port}`;
  const mint = (claims: {
    sub: string;
    aud: string;
    resource: string;
    client_id: string;
  }) =>
    new SignJWT({ resource: claims.resource, client_id: claims.client_id })
      .setProtectedHeader({ alg: "RS256", typ: "oauth-id-jag+jwt", kid: "xaa-idp-1" })
      .setIssuer(issuer)
      .setSubject(claims.sub)
      .setAudience(claims.aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return {
    issuer,
    mint,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function getKeycard(
  app: { url: string },
  idp: Awaited<ReturnType<typeof startFakeIdp>>,
) {
  const assertion = await idp.mint({
    sub: "user-12345",
    aud: app.url,
    resource: `${app.url}/mcp`,
    client_id: "demo-client",
  });
  const res = await fetch(`${app.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
      resource: `${app.url}/mcp`,
      client_id: "demo-client",
    }),
  });
  return (await res.json()).access_token as string;
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "1",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
  });
}

test("getConfig defaults the canonical URL to the rigged (wrong) value", () => {
  delete process.env.CANONICAL_URL;
  const cfg = getConfig();
  assert.equal(cfg.canonicalUrl, "https://demo.example.com/mcp");
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.trustedIssuer, null);
});

test("advertises its real resource and the jwt-bearer grant", async () => {
  const app = await startServer({ PORT: "0" });
  try {
    const prm = await fetch(
      `${app.url}/.well-known/oauth-protected-resource`,
    ).then((r) => r.json());
    assert.equal(prm.resource, `${app.url}/mcp`);
    assert.deepEqual(prm.authorization_servers, [app.url]);

    const as = await fetch(
      `${app.url}/.well-known/oauth-authorization-server`,
    ).then((r) => r.json());
    assert.equal(as.token_endpoint, `${app.url}/token`);
    assert.ok(
      as.grant_types_supported.includes(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ),
    );
  } finally {
    await app.close();
  }
});

test("/token verifies the pass and mints a keycard bound to the requested resource", async () => {
  const idp = await startFakeIdp();
  const app = await startServer({ PORT: "0", TRUSTED_ISSUER: "" });
  try {
    const assertion = await idp.mint({
      sub: "user-12345",
      aud: app.url, // the ID-JAG audience is the authorization server (this server)
      resource: `${app.url}/mcp`,
      client_id: "demo-client",
    });
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
      resource: `${app.url}/mcp`,
      client_id: "demo-client",
    });
    const res = await fetch(`${app.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(typeof json.access_token, "string");
    assert.equal(json.token_type, "Bearer");
  } finally {
    await app.close();
    await idp.close();
  }
});

test("the door returns 401 when the keycard audience does not match (the rigged bug)", async () => {
  const idp = await startFakeIdp();
  const app = await startServer({
    PORT: "0",
    CANONICAL_URL: "https://demo.example.com/mcp",
  });
  try {
    const token = await getKeycard(app, idp); // aud = http://localhost:.../mcp
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
    await idp.close();
  }
});

test("the door opens (200) when CANONICAL_URL matches the real address (the fix)", async () => {
  const idp = await startFakeIdp();
  const app = await startServer({ PORT: "0" });
  try {
    // Match the guard to the address the token is actually bound to.
    process.env.CANONICAL_URL = `${app.url}/mcp`;
    const token = await getKeycard(app, idp);
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody(),
    });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
    await idp.close();
  }
});
