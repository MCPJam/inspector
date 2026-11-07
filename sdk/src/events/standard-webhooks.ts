/**
 * Standard Webhooks primitives, as profiled by the MCP Events draft
 * (*Webhook Security → Signature scheme*).
 *
 *   signature = base64( HMAC-SHA256( key, `${webhook-id}.${webhook-timestamp}.${body}` ) )
 *   header    = "v1,<signature>"  (space-delimited list during rotation)
 *   key       = base64-decode(secret without the `whsec_` prefix)
 *
 * `body` is the RAW request bytes exactly as sent/received — never a
 * re-serialized object — which is why every function here takes the body as
 * a string or bytes and none takes a parsed value.
 *
 * Web Crypto only, so this runs unchanged in Node, the browser and a Worker.
 * Correctness is pinned against the published Standard Webhooks / Svix test
 * vector and cross-checked against an independent `node:crypto` HMAC (see
 * `__tests__/standard-webhooks.test.ts`); the inbox Worker verifies with the
 * maintained `standardwebhooks` library, and the two meet on the same vector.
 */

import { decodeWebhookSecret } from "../mcp-client-manager/events-ext.js";

/** The receiver's freshness window (draft: SHOULD reject > 5 minutes). */
export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

const encoder = new TextEncoder();

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? encoder.encode(body) : body;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    data as BufferSource
  );
  return new Uint8Array(signature);
}

function signedContent(
  webhookId: string,
  timestampSeconds: number,
  body: Uint8Array
): Uint8Array {
  const prefix = encoder.encode(`${webhookId}.${timestampSeconds}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

function requireKey(secret: string): Uint8Array {
  const key = decodeWebhookSecret(secret);
  if (!key) {
    throw new TypeError(
      "Not a Standard Webhooks secret: expected `whsec_` + base64 of 24–64 bytes"
    );
  }
  return key;
}

/** One `v1,<base64>` signature for one secret. */
export async function signWebhookPayload(args: {
  secret: string;
  webhookId: string;
  timestampSeconds: number;
  body: string | Uint8Array;
}): Promise<string> {
  const mac = await hmacSha256(
    requireKey(args.secret),
    signedContent(args.webhookId, args.timestampSeconds, toBytes(args.body))
  );
  return `v1,${bytesToBase64(mac)}`;
}

/**
 * The full `webhook-signature` header for one or more secrets — several
 * during a rotation grace window, space-delimited per Standard Webhooks.
 */
export async function buildWebhookSignatureHeader(args: {
  secrets: string[];
  webhookId: string;
  timestampSeconds: number;
  body: string | Uint8Array;
}): Promise<string> {
  const parts = await Promise.all(
    args.secrets.map((secret) =>
      signWebhookPayload({
        secret,
        webhookId: args.webhookId,
        timestampSeconds: args.timestampSeconds,
        body: args.body,
      })
    )
  );
  return parts.join(" ");
}

/** Headers a conforming sender puts on every delivery. */
export async function buildWebhookHeaders(args: {
  secrets: string[];
  webhookId: string;
  timestampSeconds: number;
  body: string | Uint8Array;
  subscriptionId: string;
}): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "webhook-id": args.webhookId,
    "webhook-timestamp": String(args.timestampSeconds),
    "webhook-signature": await buildWebhookSignatureHeader(args),
    "x-mcp-subscription-id": args.subscriptionId,
  };
}

export type WebhookVerifyFailure =
  | "missing_headers"
  | "bad_timestamp"
  | "stale_timestamp"
  | "bad_signature";

export type WebhookVerifyResult =
  | { ok: true; webhookId: string; timestampSeconds: number; secretIndex: number }
  | { ok: false; reason: WebhookVerifyFailure };

/** Constant-time comparison of two ASCII strings. */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const length = Math.max(ab.length, bb.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function headerValue(
  headers: Headers | Record<string, string | undefined>,
  name: string
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Verify a delivery against one or more candidate secrets (current + the
 * previous one during a rotation overlap). Accepts if ANY listed `v1,`
 * signature verifies under ANY candidate secret; `v1a,` (asymmetric) entries
 * are ignored, as the draft allows for receivers that do not enforce server
 * identity.
 */
export async function verifyWebhookDelivery(args: {
  secrets: string[];
  headers: Headers | Record<string, string | undefined>;
  body: string | Uint8Array;
  nowSeconds: number;
  toleranceSeconds?: number;
}): Promise<WebhookVerifyResult> {
  const webhookId = headerValue(args.headers, "webhook-id");
  const timestampRaw = headerValue(args.headers, "webhook-timestamp");
  const signatureHeader = headerValue(args.headers, "webhook-signature");
  if (!webhookId || !timestampRaw || !signatureHeader) {
    return { ok: false, reason: "missing_headers" };
  }
  if (!/^\d{1,12}$/.test(timestampRaw)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  const timestampSeconds = Number(timestampRaw);
  const tolerance = args.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(args.nowSeconds - timestampSeconds) > tolerance) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const candidates = signatureHeader
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"));
  const body = toBytes(args.body);
  for (let index = 0; index < args.secrets.length; index += 1) {
    const secret = args.secrets[index]!;
    if (!decodeWebhookSecret(secret)) continue;
    const expected = await signWebhookPayload({
      secret,
      webhookId,
      timestampSeconds,
      body,
    });
    if (candidates.some((candidate) => timingSafeEqualString(candidate, expected))) {
      return { ok: true, webhookId, timestampSeconds, secretIndex: index };
    }
  }
  return { ok: false, reason: "bad_signature" };
}
