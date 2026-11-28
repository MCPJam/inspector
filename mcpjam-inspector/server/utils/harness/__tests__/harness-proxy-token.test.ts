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
  it("returns claims for a valid token, scoped to its serverId", async () => {
    const token = signTestProxyToken({
      serverId: "srv-a",
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
    });
    expect(await verifyHarnessProxyToken(token, "srv-a")).toEqual({
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
      serverId: "srv-a",
      alg: "HS256",
    });
    // Wrong server → rejected.
    expect(await verifyHarnessProxyToken(token, "srv-b")).toBeNull();
  });

  it("fails closed for missing / garbage tokens", async () => {
    expect(await verifyHarnessProxyToken(undefined, "srv-a")).toBeNull();
    expect(await verifyHarnessProxyToken("", "srv-a")).toBeNull();
    expect(await verifyHarnessProxyToken("not.a.jwt", "srv-a")).toBeNull();
    expect(await verifyHarnessProxyToken("a.b.c.d", "srv-a")).toBeNull();
  });

  it("rejects a missing required identity claim", async () => {
    const noExt = signTestProxyToken({ serverId: "srv-a", externalId: "" });
    expect(await verifyHarnessProxyToken(noExt, "srv-a")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = signTestProxyToken(
      { serverId: "srv-a" },
      { nowS: 1000, expS: 2000 },
    );
    expect(
      await verifyHarnessProxyToken(token, "srv-a", { nowMs: 2_001_000 }),
    ).toBeNull();
    expect(
      await verifyHarnessProxyToken(token, "srv-a", { nowMs: 1_500_000 }),
    ).not.toBeNull();
  });

  it("rejects a token AT its exp second (JWT NumericDate: expired at exp, not after)", async () => {
    const token = signTestProxyToken(
      { serverId: "srv-a" },
      { nowS: 1000, expS: 2000 },
    );
    expect(
      await verifyHarnessProxyToken(token, "srv-a", { nowMs: 2_000_000 }),
    ).toBeNull();
    // The final second BEFORE exp is still valid.
    expect(
      await verifyHarnessProxyToken(token, "srv-a", { nowMs: 1_999_999 }),
    ).not.toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = signTestProxyToken({ serverId: "srv-a" });
    const [h, p] = token.split(".");
    expect(
      await verifyHarnessProxyToken(`${h}.${p}.deadbeef`, "srv-a"),
    ).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = signTestProxyToken({ serverId: "srv-a" });
    try {
      process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
        "a-different-secret-1234567890";
      expect(await verifyHarnessProxyToken(token, "srv-a")).toBeNull();
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
  it("returns the lane identity for its server, with no expiry", async () => {
    expect(await verifyHarnessSessionHandle(sessionHandle(), "srv-a")).toEqual({
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
      serverId: "srv-a",
      laneId: "lane-1",
      alg: "HS256",
    });
    expect(
      await verifyHarnessSessionHandle(
        sessionHandle({ acct: "connection-1" }),
        "srv-a",
      ),
    ).toMatchObject({ connectionId: "connection-1" });
    expect(
      await verifyHarnessSessionHandle(sessionHandle(), "srv-b"),
    ).toBeNull();
  });

  it("is a different population from per-turn proxy tokens", async () => {
    const perTurn = signTestProxyToken({ serverId: "srv-a" });
    expect(await verifyHarnessSessionHandle(perTurn, "srv-a")).toBeNull();
    expect(await verifyHarnessProxyToken(sessionHandle(), "srv-a")).toBeNull();
  });

  it("refuses a handle with no lane, a bad account, or another secret", async () => {
    expect(
      await verifyHarnessSessionHandle(sessionHandle({ lane: "" }), "srv-a"),
    ).toBeNull();
    expect(
      await verifyHarnessSessionHandle(sessionHandle({ acct: 7 }), "srv-a"),
    ).toBeNull();
    expect(
      await verifyHarnessSessionHandle(
        sessionHandle({}, "another-secret-another-secret-32"),
        "srv-a",
      ),
    ).toBeNull();
  });
});
