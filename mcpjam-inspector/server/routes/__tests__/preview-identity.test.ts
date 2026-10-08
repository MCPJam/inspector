import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  PREVIEW_IDENTITY_PATH,
  PREVIEW_NONCE_HEADER,
  previewIdentityProof,
  registerPreviewIdentityRoute,
} from "../preview-identity";

// The preview router (preview-router/src/index.ts) computes the same HMAC
// with WebCrypto and forwards only on an exact match. These pins keep the two
// halves in agreement.

const SECRET = "test-preview-edge-secret";
const DOMAIN = "mcp-inspector-pr-123.up.railway.app";
const NONCE = "3f2c3fa1-2e3d-4dc3-ab0b-70d9c78fa0b9";

function buildApp(env: NodeJS.ProcessEnv) {
  const app = new Hono();
  registerPreviewIdentityRoute(app, env);
  return app;
}

describe("preview identity route", () => {
  it("answers HMAC-SHA256(secret, `${nonce}:${domain}`) in hex", async () => {
    const response = await buildApp({
      PREVIEW_EDGE_SECRET: SECRET,
      RAILWAY_PUBLIC_DOMAIN: DOMAIN,
    }).request(PREVIEW_IDENTITY_PATH, {
      headers: { [PREVIEW_NONCE_HEADER]: NONCE },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const expected = createHmac("sha256", SECRET)
      .update(`${NONCE}:${DOMAIN}`)
      .digest("hex");
    expect(await response.text()).toBe(expected);
    expect(previewIdentityProof(SECRET, NONCE, DOMAIN)).toBe(expected);
  });

  it("binds the answer to this preview's own Railway domain", () => {
    expect(previewIdentityProof(SECRET, NONCE, DOMAIN)).not.toBe(
      previewIdentityProof(
        SECRET,
        NONCE,
        "mcp-inspector-pr-124.up.railway.app",
      ),
    );
  });

  it("lower-cases the Railway domain it signs", async () => {
    const response = await buildApp({
      PREVIEW_EDGE_SECRET: SECRET,
      RAILWAY_PUBLIC_DOMAIN: DOMAIN.toUpperCase(),
    }).request(PREVIEW_IDENTITY_PATH, {
      headers: { [PREVIEW_NONCE_HEADER]: NONCE },
    });
    expect(await response.text()).toBe(
      previewIdentityProof(SECRET, NONCE, DOMAIN),
    );
  });

  it.each([
    ["missing", undefined],
    ["too short", "abc"],
    ["not a token", "../../etc/passwd-abcdefgh"],
  ])("refuses a %s nonce", async (_label, nonce) => {
    const response = await buildApp({
      PREVIEW_EDGE_SECRET: SECRET,
      RAILWAY_PUBLIC_DOMAIN: DOMAIN,
    }).request(PREVIEW_IDENTITY_PATH, {
      headers: nonce ? { [PREVIEW_NONCE_HEADER]: nonce } : {},
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ["no secret", { RAILWAY_PUBLIC_DOMAIN: DOMAIN }],
    ["no Railway domain", { PREVIEW_EDGE_SECRET: SECRET }],
    ["neither", {}],
  ])("isn't mounted with %s", async (_label, env) => {
    const response = await buildApp(env).request(PREVIEW_IDENTITY_PATH, {
      headers: { [PREVIEW_NONCE_HEADER]: NONCE },
    });
    expect(response.status).toBe(404);
  });
});
