import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

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
