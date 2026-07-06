import { describe, it, expect, beforeAll } from "vitest";
import { verifyHarnessProxyToken } from "../harness-proxy-token.js";
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
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "a-different-secret-1234567890";
    expect(verifyHarnessProxyToken(token, "srv-a")).toBeNull();
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET; // restore
  });
});
