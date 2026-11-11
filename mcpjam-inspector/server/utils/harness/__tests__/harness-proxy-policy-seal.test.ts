import { createDecipheriv, hkdfSync } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  HarnessProxyPolicySealTooLargeError,
  MAX_SEALED_DENIED_TOOL_NAMES,
  isHarnessProxyPolicySealAvailable,
  isSealedHarnessProxyToken,
  sealHarnessProxyToken,
  sealHarnessSessionEnvelope,
  unsealHarnessProxyToken,
} from "../harness-proxy-policy-seal.js";
import { verifyHarnessProxyToken } from "../harness-proxy-token.js";
import { harnessConnectionProfileSchema } from "../harness-connection-profile.js";
import { sessionPolicyDigest } from "../session-mcp-config.js";
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
  it("binds a versioned connection profile without exposing it or changing v1 reads", () => {
    const profile = {
      clientCapabilities: {
        extensions: { "future.test/capability": { marker: "original" } },
      },
      clientInfo: { name: "saved-client", version: "1", title: "Saved" },
      timeout: 17_000,
      firstPageOnly: true,
    };
    const sealed = seal({ profile });
    expect(sealed.startsWith("mcpjps2.")).toBe(true);
    expect(sealed).not.toContain("saved-client");
    expect(unsealHarnessProxyToken(sealed, "srv-a")?.profile).toEqual(profile);
    expect(unsealHarnessProxyToken(seal({}), "srv-a")?.profile).toBeUndefined();
    expect(
      unsealHarnessProxyToken(sealed.replace("mcpjps2.", "mcpjps1."), "srv-a"),
    ).toBeNull();
    const credentialProfile = Object.assign({}, profile, {
      headers: { authorization: "secret" },
    });
    expect(() => seal({ profile: credentialProfile })).toThrow();
  });
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

describe("sealHarnessSessionEnvelope (one value for a whole session)", () => {
  const session = (overrides: Partial<Parameters<typeof sealHarnessSessionEnvelope>[0]> = {}) =>
    sealHarnessSessionEnvelope({
      handle: "lane-session-handle",
      serverId: "srv-a",
      policy: snapshot,
      profile: { clientCapabilities: {}, timeout: 60_000 },
      ...overrides,
    });

  it("is deterministic, so a fingerprinting runtime sees no change between turns", () => {
    expect(session()).toBe(session());
    expect(session()).toMatch(/^mcpjps4\./);
    expect(isSealedHarnessProxyToken(session())).toBe(true);
  });

  it("changes whenever the handle, policy or profile does", () => {
    const base = session();
    expect(session({ handle: "another-handle" })).not.toBe(base);
    expect(session({ policy: { ...snapshot, unknownTool: "allow" } })).not.toBe(base);
    expect(session({ profile: { clientCapabilities: {}, timeout: 10_000 } })).not.toBe(base);
  });

  it("opens as a session with no expiry, for its server only", () => {
    const opened = unsealHarnessProxyToken(session(), "srv-a", {
      nowMs: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    expect(opened).toMatchObject({
      session: true,
      token: "lane-session-handle",
      serverId: "srv-a",
      policy: snapshot,
      profile: { clientCapabilities: {}, timeout: 60_000 },
    });
    expect(unsealHarnessProxyToken(session(), "srv-b")).toBeNull();
  });

  it("refuses a tampered envelope", () => {
    const [prefix, iv, body] = session().split(".");
    const flipped = body!.slice(0, -2) + (body!.endsWith("A") ? "BB" : "AA");
    expect(unsealHarnessProxyToken(`${prefix}.${iv}.${flipped}`, "srv-a")).toBeNull();
    // A per-turn envelope cannot be relabelled as a session one.
    const perTurn = seal({}).split(".");
    expect(unsealHarnessProxyToken(`mcpjps4.${perTurn[1]}.${perTurn[2]}`, "srv-a")).toBeNull();
  });
});

describe("a profile's negotiation across a mixed fleet", () => {
  /** The profile schema of an instance that predates the negotiation. */
  const preNegotiationSchema = harnessConnectionProfileSchema.omit({
    versionNegotiation: true,
  });
  /** The plaintext an instance opens, with the seal's own key derivation. */
  const plaintext = (sealed: string) => {
    const [, iv, body] = sealed.split(".");
    const bytes = Buffer.from(body!, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(
        hkdfSync(
          "sha256",
          SECRET,
          "mcpjam-harness-mcp-proxy-policy-seal",
          "harness-mcp-proxy-policy-seal.v1",
          32,
        ),
      ),
      Buffer.from(iv!, "base64url"),
    );
    decipher.setAuthTag(bytes.subarray(bytes.byteLength - 16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.byteLength - 16)),
        decipher.final(),
      ]).toString("utf8"),
    ) as { profile?: unknown; vn?: unknown };
  };
  const profile = {
    clientCapabilities: {},
    timeout: 300_000,
    versionNegotiation: "legacy-first" as const,
  };

  it.each([
    [
      "a session envelope",
      () =>
        sealHarnessSessionEnvelope({
          handle: "lane-handle",
          serverId: "srv-a",
          policy: snapshot,
          profile,
        }),
    ],
    ["a per-turn token", () => seal({ profile })],
  ])("keeps %s open under the older schema, and whole here", (_kind, make) => {
    const sealed = make();
    const opened = plaintext(sealed);
    expect(preNegotiationSchema.safeParse(opened.profile).success).toBe(true);
    expect(opened.vn).toBe("legacy-first");
    expect(unsealHarnessProxyToken(sealed, "srv-a")?.profile).toEqual(profile);
  });

  it("binds the turn to the digest an older instance computes", () => {
    const { versionNegotiation: _outside, ...older } = profile;
    expect(sessionPolicyDigest("srv-a", snapshot, profile)).toBe(
      sessionPolicyDigest("srv-a", snapshot, older),
    );
    expect(sessionPolicyDigest("srv-a", snapshot, profile)).not.toBe(
      sessionPolicyDigest("srv-a", snapshot, { ...older, timeout: 60_000 }),
    );
  });
});
