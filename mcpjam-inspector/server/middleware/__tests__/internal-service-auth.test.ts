/**
 * Inbound `INSPECTOR_SERVICE_TOKEN` verification.
 *
 * The cases worth pinning are the fail-closed ones. A guard that admits when
 * it is unconfigured, or that accepts the token in the bearer slot it was
 * never meant to occupy, fails in the direction where nobody notices.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalServiceAuthMiddleware } from "../internal-service-auth.js";

const TOKEN = "svc_test_token_value";

function createApp() {
  const app = new Hono();
  app.use("*", internalServiceAuthMiddleware());
  app.get("/guarded", (c) => c.json({ ok: true }));
  return app;
}

describe("internalServiceAuthMiddleware", () => {
  const originalToken = process.env.INSPECTOR_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.INSPECTOR_SERVICE_TOKEN = TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = originalToken;
    }
  });

  it("admits a request presenting the configured token", async () => {
    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": TOKEN },
    });

    expect(response.status).toBe(200);
  });

  it("rejects a request with no token", async () => {
    const response = await createApp().request("/guarded");

    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": "svc_wrong_token_value" },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a token that is a prefix of the configured one", async () => {
    // Length is compared over digests, so a truncated token is no closer to
    // admission than an unrelated one.
    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": TOKEN.slice(0, -1) },
    });

    expect(response.status).toBe(401);
  });

  it("fails closed when the deployment has no token configured", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;

    // Unconfigured must mean "nobody is authorized", never "no guard".
    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": TOKEN },
    });

    expect(response.status).toBe(401);
  });

  it("fails closed when the configured token is empty", async () => {
    process.env.INSPECTOR_SERVICE_TOKEN = "";

    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": "" },
    });

    expect(response.status).toBe(401);
  });

  it("does not accept the token in the Authorization bearer slot", async () => {
    // The backend offers a header-or-bearer mode for one legacy flow and says
    // new routes must not adopt it. This side does not implement it at all.
    const response = await createApp().request("/guarded", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(401);
  });

  it("tolerates surrounding whitespace in the presented header", async () => {
    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": `  ${TOKEN}  ` },
    });

    expect(response.status).toBe(200);
  });

  it("admits the token when the configured value carries stray whitespace", async () => {
    // A secret pasted into a dashboard or read from a file routinely picks up
    // a trailing newline. The presented header is trimmed, so leaving the
    // configured value untrimmed made the two sides asymmetric and rejected
    // every correctly presented token — a total, fail-closed outage that reads
    // as a credential mismatch rather than a stray byte.
    process.env.INSPECTOR_SERVICE_TOKEN = `  ${TOKEN}\n`;

    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": TOKEN },
    });

    expect(response.status).toBe(200);
  });

  it("treats a whitespace-only configured token as unset", async () => {
    process.env.INSPECTOR_SERVICE_TOKEN = "   ";

    // A GENUINE token is presented on purpose: if the header were also
    // whitespace, the presented-token guard would reject it too and the test
    // would still pass with the whitespace-only configuration check deleted —
    // which is the fail-open regression it exists to catch. This way the 401
    // can only come from the configuration side.
    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": TOKEN },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a whitespace-only presented token against a real config", async () => {
    // The other guard, exercised on its own.
    const response = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": "   " },
    });

    expect(response.status).toBe(401);
  });

  it("does not disclose why authorization failed", async () => {
    const missing = await createApp().request("/guarded");
    const wrong = await createApp().request("/guarded", {
      headers: { "x-inspector-service-token": "svc_wrong_token_value" },
    });

    // A caller learns only that it could not authenticate — never whether the
    // token was absent, malformed, or simply wrong.
    expect(await missing.json()).toEqual(await wrong.json());
  });
});
