import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyHarnessProxyToken,
  verifyHarnessSessionHandle,
} from "../harness-proxy-token.js";
import { signTestProxyToken } from "./sign-test-token.js";

const SECRET = "test-harness-proxy-secret-32-chars-min";

beforeAll(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET;
});

describe("verifyHarnessProxyToken (verifies Convex-minted HS256 tokens)", () => {
  it("returns claims for a valid token, scoped to its serverId", () => {
    const token = signTestProxyToken({
      serverId: "srv-a",
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
    });
    expect(verifyHarnessProxyToken(token, "srv-a")).toEqual({
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
      serverId: "srv-a",
    });
    // Wrong server → rejected.
    expect(verifyHarnessProxyToken(token, "srv-b")).toBeNull();
  });

  it("fails closed for missing / garbage tokens", () => {
    expect(verifyHarnessProxyToken(undefined, "srv-a")).toBeNull();
    expect(verifyHarnessProxyToken("", "srv-a")).toBeNull();
    expect(verifyHarnessProxyToken("not.a.jwt", "srv-a")).toBeNull();
    expect(verifyHarnessProxyToken("a.b.c.d", "srv-a")).toBeNull();
  });

  it("rejects a missing required identity claim", () => {
    const noExt = signTestProxyToken({ serverId: "srv-a", externalId: "" });
    expect(verifyHarnessProxyToken(noExt, "srv-a")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signTestProxyToken(
      { serverId: "srv-a" },
      { nowS: 1000, expS: 2000 },
    );
    expect(verifyHarnessProxyToken(token, "srv-a", { nowMs: 2_001_000 })).toBeNull();
    expect(
      verifyHarnessProxyToken(token, "srv-a", { nowMs: 1_500_000 }),
    ).not.toBeNull();
  });

  it("rejects a token AT its exp second (JWT NumericDate: expired at exp, not after)", () => {
    const token = signTestProxyToken(
      { serverId: "srv-a" },
      { nowS: 1000, expS: 2000 },
    );
    expect(verifyHarnessProxyToken(token, "srv-a", { nowMs: 2_000_000 })).toBeNull();
    // The final second BEFORE exp is still valid.
    expect(
      verifyHarnessProxyToken(token, "srv-a", { nowMs: 1_999_999 }),
    ).not.toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signTestProxyToken({ serverId: "srv-a" });
    const [h, p] = token.split(".");
    expect(verifyHarnessProxyToken(`${h}.${p}.deadbeef`, "srv-a")).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signTestProxyToken({ serverId: "srv-a" });
    try {
      process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
        "a-different-secret-1234567890";
      expect(verifyHarnessProxyToken(token, "srv-a")).toBeNull();
    } finally {
      process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET;
    }
  });
});

/** A lane's session handle, as the backend's `bind-turn` mints it. */
function sessionHandle(overrides: Record<string, unknown> = {}, secret = SECRET) {
  const payload = {
    iss: "https://api.mcpjam.com/harness-mcp-proxy",
    purpose: "harness-mcp-session",
    sub: "u_convex",
    ext: "u_ext",
    org: "o1",
    projectId: "p1",
    serverId: "srv-a",
    lane: "lane-1",
    iat: 1_700_000_000,
    ...overrides,
  };
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

describe("verifyHarnessSessionHandle (a lane's identity, never a turn's authority)", () => {
  it("returns the lane identity for its server, with no expiry", () => {
    expect(verifyHarnessSessionHandle(sessionHandle(), "srv-a")).toEqual({
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
      serverId: "srv-a",
      laneId: "lane-1",
    });
    expect(
      verifyHarnessSessionHandle(sessionHandle({ acct: "connection-1" }), "srv-a"),
    ).toMatchObject({ connectionId: "connection-1" });
    expect(verifyHarnessSessionHandle(sessionHandle(), "srv-b")).toBeNull();
  });

  it("is a different population from per-turn proxy tokens", () => {
    const perTurn = signTestProxyToken({ serverId: "srv-a" });
    expect(verifyHarnessSessionHandle(perTurn, "srv-a")).toBeNull();
    expect(verifyHarnessProxyToken(sessionHandle(), "srv-a")).toBeNull();
  });

  it("refuses a handle with no lane, a bad account, or another secret", () => {
    expect(verifyHarnessSessionHandle(sessionHandle({ lane: "" }), "srv-a")).toBeNull();
    expect(verifyHarnessSessionHandle(sessionHandle({ acct: 7 }), "srv-a")).toBeNull();
    expect(
      verifyHarnessSessionHandle(
        sessionHandle({}, "another-secret-another-secret-32"),
        "srv-a",
      ),
    ).toBeNull();
  });
});
