import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildWebhookSignatureHeader,
  signWebhookPayload,
  verifyWebhookDelivery,
} from "../standard-webhooks.js";
import {
  decodeWebhookSecret,
  generateWebhookSecret,
  isValidWebhookSecret,
} from "../../mcp-client-manager/events-ext.js";

/**
 * The published Standard Webhooks test vector (the one the reference
 * libraries — Svix's and `standardwebhooks` — test against). Pinned here so
 * our Web Crypto signer is checked against bytes we did not produce.
 */
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  webhookId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestampSeconds: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

/** An independent implementation: node:crypto, not Web Crypto. */
function nodeSign(secret: string, id: string, ts: number, body: string) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

describe("Standard Webhooks primitives", () => {
  it("reproduces the published test vector", async () => {
    await expect(
      signWebhookPayload({
        secret: VECTOR.secret,
        webhookId: VECTOR.webhookId,
        timestampSeconds: VECTOR.timestampSeconds,
        body: VECTOR.body,
      })
    ).resolves.toBe(VECTOR.signature);
  });

  it("agrees with an independent node:crypto HMAC on random inputs", async () => {
    for (let i = 0; i < 20; i += 1) {
      const secret = generateWebhookSecret(24 + i * 2);
      const body = JSON.stringify({ n: i, text: "héllo ✓", nested: { i } });
      const ours = await signWebhookPayload({
        secret,
        webhookId: `evt_${i}`,
        timestampSeconds: 1_700_000_000 + i,
        body,
      });
      expect(ours).toBe(nodeSign(secret, `evt_${i}`, 1_700_000_000 + i, body));
    }
  });

  it("verifies the published vector and rejects a tampered body", async () => {
    const headers = {
      "webhook-id": VECTOR.webhookId,
      "webhook-timestamp": String(VECTOR.timestampSeconds),
      "webhook-signature": VECTOR.signature,
    };
    await expect(
      verifyWebhookDelivery({
        secrets: [VECTOR.secret],
        headers,
        body: VECTOR.body,
        nowSeconds: VECTOR.timestampSeconds + 10,
      })
    ).resolves.toMatchObject({ ok: true, secretIndex: 0 });
    await expect(
      verifyWebhookDelivery({
        secrets: [VECTOR.secret],
        headers,
        // Re-serialized JSON is NOT the signed body.
        body: JSON.stringify(JSON.parse(VECTOR.body)),
        nowSeconds: VECTOR.timestampSeconds + 10,
      })
    ).resolves.toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp and missing headers", async () => {
    const headers = {
      "webhook-id": VECTOR.webhookId,
      "webhook-timestamp": String(VECTOR.timestampSeconds),
      "webhook-signature": VECTOR.signature,
    };
    await expect(
      verifyWebhookDelivery({
        secrets: [VECTOR.secret],
        headers,
        body: VECTOR.body,
        nowSeconds: VECTOR.timestampSeconds + 301,
      })
    ).resolves.toEqual({ ok: false, reason: "stale_timestamp" });
    await expect(
      verifyWebhookDelivery({
        secrets: [VECTOR.secret],
        headers: { "webhook-id": "x" },
        body: VECTOR.body,
        nowSeconds: VECTOR.timestampSeconds,
      })
    ).resolves.toEqual({ ok: false, reason: "missing_headers" });
  });

  it("accepts a rotation header where only the second signature verifies", async () => {
    const oldSecret = generateWebhookSecret();
    const newSecret = generateWebhookSecret();
    const body = '{"eventId":"evt_1"}';
    const header = await buildWebhookSignatureHeader({
      secrets: [oldSecret, newSecret],
      webhookId: "evt_1",
      timestampSeconds: 1000,
      body,
    });
    expect(header.split(" ")).toHaveLength(2);
    await expect(
      verifyWebhookDelivery({
        secrets: [newSecret],
        headers: {
          "webhook-id": "evt_1",
          "webhook-timestamp": "1000",
          "webhook-signature": header,
        },
        body,
        nowSeconds: 1000,
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it("validates whsec_ secrets by decoded length (24–64 bytes)", () => {
    expect(isValidWebhookSecret(generateWebhookSecret())).toBe(true);
    expect(decodeWebhookSecret(generateWebhookSecret(64))?.length).toBe(64);
    expect(isValidWebhookSecret(`whsec_${Buffer.alloc(23).toString("base64")}`)).toBe(false);
    expect(isValidWebhookSecret(`whsec_${Buffer.alloc(65).toString("base64")}`)).toBe(false);
    expect(isValidWebhookSecret("sk_live_abc")).toBe(false);
    expect(isValidWebhookSecret("whsec_***")).toBe(false);
    expect(() => generateWebhookSecret(8)).toThrow(RangeError);
  });
});
