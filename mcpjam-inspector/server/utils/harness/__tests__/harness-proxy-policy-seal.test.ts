import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  HarnessProxyPolicySealTooLargeError,
  MAX_SEALED_DENIED_TOOL_NAMES,
  isHarnessProxyPolicySealAvailable,
  isSealedHarnessProxyToken,
  sealHarnessProxyToken,
  unsealHarnessProxyToken,
} from "../harness-proxy-policy-seal.js";
import { verifyHarnessProxyToken } from "../harness-proxy-token.js";
import { signTestProxyToken } from "./sign-test-token.js";

const SECRET = "test-harness-proxy-secret-32-chars-min";

const snapshot: ToolPolicySnapshot = {
  mode: "readOnly",
  denied: {
    delete_everything: {
      reason: "denyList",
      classification: "destructive",
    },
  },
  known: ["delete_everything", "read_thing"],
  unknownTool: "deny",
};

const seal = (
  overrides: Partial<Parameters<typeof sealHarnessProxyToken>[0]>
) =>
  sealHarnessProxyToken({
    token: "inner-convex-token",
    serverId: "srv-a",
    policy: snapshot,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  });

beforeEach(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET;
});

afterEach(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = SECRET;
});

describe("harness proxy policy seal", () => {
  it("round-trips the inner token and the decision snapshot", () => {
    const sealed = seal({});
    expect(isSealedHarnessProxyToken(sealed)).toBe(true);
    // The inner credential must not be readable off the wire value: that is
    // what makes stripping the policy strip access.
    expect(sealed).not.toContain("inner-convex-token");
    expect(unsealHarnessProxyToken(sealed, "srv-a")).toEqual({
      token: "inner-convex-token",
      serverId: "srv-a",
      policy: snapshot,
    });
  });

  it("rejects a snapshot that parsed but is shaped wrong, rather than passing it on", () => {
    // The route hands the opened snapshot straight to
    // `decideToolPolicyFromSnapshot`, which reads `known` as an array and each
    // denied entry's `reason`. A wrong shape must die here, not as a 500 inside
    // the very `tools/call` the policy exists to guard.
    for (const broken of [
      { ...snapshot, known: undefined },
      { ...snapshot, known: ["ok", 7] },
      {
        ...snapshot,
        denied: { t: { reason: "nope", classification: "safe" } },
      },
      { ...snapshot, denied: { t: null } },
    ]) {
      const sealed = seal({
        policy: broken as unknown as ToolPolicySnapshot,
      });
      expect(unsealHarnessProxyToken(sealed, "srv-a")).toBeNull();
    }
  });

  it("fails closed on a tampered byte, the wrong server, and expiry", () => {
    const sealed = seal({});
    const parts = sealed.split(".");
    const body = Buffer.from(parts[2] as string, "base64url");
    body[0] = body[0]! ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${body.toString("base64url")}`;
    expect(unsealHarnessProxyToken(tampered, "srv-a")).toBeNull();

    expect(unsealHarnessProxyToken(sealed, "srv-b")).toBeNull();

    const shortLived = seal({ expiresAtMs: 2_000_000 });
    expect(
      unsealHarnessProxyToken(shortLived, "srv-a", { nowMs: 1_000_000 })
    ).not.toBeNull();
    expect(
      unsealHarnessProxyToken(shortLived, "srv-a", { nowMs: 2_000_000 })
    ).toBeNull();
  });

  it("refuses to seal without a usable secret, rather than degrading to a bare token", () => {
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    expect(isHarnessProxyPolicySealAvailable()).toBe(false);
    expect(() => seal({})).toThrow(/COMPUTERS_TERMINAL_TOKEN_SECRET/);

    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "too-short";
    expect(isHarnessProxyPolicySealAvailable()).toBe(false);
    expect(() => seal({})).toThrow(/at least/);
  });

  it("unseals to null when the deployment cannot open the envelope", () => {
    const sealed = seal({});
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = `${SECRET}-different`;
    expect(unsealHarnessProxyToken(sealed, "srv-a")).toBeNull();
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    expect(unsealHarnessProxyToken(sealed, "srv-a")).toBeNull();
  });

  it("refuses an over-cap deny list instead of truncating it", () => {
    const denied: ToolPolicySnapshot["denied"] = {};
    for (let i = 0; i <= MAX_SEALED_DENIED_TOOL_NAMES; i++) {
      denied[`tool_${i}`] = {
        reason: "denyList",
        classification: "unknown",
      };
    }
    expect(() =>
      seal({ policy: { ...snapshot, denied, known: Object.keys(denied) } })
    ).toThrow(HarnessProxyPolicySealTooLargeError);
  });

  it("leaves a BARE Convex token untouched (swarm / UT / playground regression)", () => {
    const bare = signTestProxyToken({
      serverId: "srv-a",
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
    });
    expect(isSealedHarnessProxyToken(bare)).toBe(false);
    expect(unsealHarnessProxyToken(bare, "srv-a")).toBeNull();
    // …and the identity path the route falls back to still accepts it.
    expect(verifyHarnessProxyToken(bare, "srv-a")).toMatchObject({
      externalId: "u_ext",
      orgId: "o1",
    });
  });

  it("verifies the sealed inner token through the unchanged identity verifier", () => {
    const inner = signTestProxyToken({
      serverId: "srv-a",
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
    });
    const sealed = seal({ token: inner });
    const opened = unsealHarnessProxyToken(sealed, "srv-a");
    expect(opened).not.toBeNull();
    expect(verifyHarnessProxyToken(opened!.token, "srv-a")).toMatchObject({
      externalId: "u_ext",
    });
  });
});
