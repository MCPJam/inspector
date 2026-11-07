import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_VIEWER_TOKEN_TTL_SECONDS,
  ViewerTokenConfigError,
  issueViewerToken,
  signViewerToken,
} from "../viewer-token.js";

/**
 * The PINNED vector. The inbox Worker verifies these tokens
 * (`mcpjam-backend/events-inbox/src/viewer-token.ts`); its tests use the same
 * key and claims, and must assert this exact literal — a drift in encoding,
 * key handling or MAC input fails on whichever side moved.
 */
const KEY = "viewer-key-for-tests-0123456789abcdef";
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const CLAIMS = {
  inboxId: "abcdefghijklmnopqrstuvwxyz",
  projectId: "proj_1",
  userId: "user_1",
  epoch: 3,
  exp: Math.floor(NOW / 1000) + 600,
  scope: "feed:read" as const,
};
const PINNED_TOKEN =
  "v1.eyJpbmJveElkIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoiLCJwcm9qZWN0SWQiOiJwcm9qXzEiLCJ1c2VySWQiOiJ1c2VyXzEiLCJlcG9jaCI6MywiZXhwIjoxNzkwNzcwMjAwLCJzY29wZSI6ImZlZWQ6cmVhZCJ9.99oOfJU104Yvz9bv4X3wowxMXWZX29tJQ5v3mKOMO9E";

describe("viewer tokens (C7)", () => {
  it("signs the pinned vector exactly", () => {
    expect(CLAIMS.exp).toBe(1790770200);
    expect(signViewerToken(CLAIMS, KEY)).toBe(PINNED_TOKEN);
  });

  it("is v1.<b64url(payload)>.<b64url(HMAC(key, 'v1.' + payload))>, unpadded", () => {
    const [version, payload, mac] = PINNED_TOKEN.split(".");
    expect(version).toBe("v1");
    expect(PINNED_TOKEN).not.toMatch(/[=+/]/);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toEqual(CLAIMS);
    const expected = createHmac("sha256", Buffer.from(KEY, "utf8"))
      .update(`v1.${payload}`)
      .digest("base64url");
    expect(mac).toBe(expected);
  });

  it("issues with exp in SECONDS, at most ten minutes ahead", () => {
    const issued = issueViewerToken({
      inboxId: CLAIMS.inboxId,
      projectId: CLAIMS.projectId,
      userId: CLAIMS.userId,
      epoch: 3,
      nowMs: NOW,
      key: KEY,
    });
    expect(issued.claims.exp).toBe(Math.floor(NOW / 1000) + MAX_VIEWER_TOKEN_TTL_SECONDS);
    expect(issued.expiresAt).toBe(issued.claims.exp * 1000);
    expect(issued.token).toBe(PINNED_TOKEN);
  });

  it("refuses a TTL beyond ten minutes at issue", () => {
    expect(() =>
      issueViewerToken({
        inboxId: CLAIMS.inboxId,
        projectId: CLAIMS.projectId,
        userId: CLAIMS.userId,
        epoch: 1,
        ttlSeconds: MAX_VIEWER_TOKEN_TTL_SECONDS + 1,
        key: KEY,
      }),
    ).toThrow(RangeError);
  });

  it("refuses an unconfigured or short key", () => {
    expect(() => signViewerToken(CLAIMS, "short")).toThrow(ViewerTokenConfigError);
    const saved = process.env.EVENTS_INBOX_VIEWER_KEY;
    delete process.env.EVENTS_INBOX_VIEWER_KEY;
    try {
      expect(() =>
        issueViewerToken({ inboxId: "i", projectId: "p", userId: "u", epoch: 1 }),
      ).toThrow(ViewerTokenConfigError);
    } finally {
      if (saved !== undefined) process.env.EVENTS_INBOX_VIEWER_KEY = saved;
    }
  });
});
