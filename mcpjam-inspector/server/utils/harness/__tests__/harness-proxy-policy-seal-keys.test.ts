/**
 * Which secret seals an envelope follows the credential inside it. A lane's
 * runtime refuses to resume a configuration whose sealed handle changed, so
 * an HS256 lane's envelope must keep the bytes it had before the seal secret
 * existed, and an RS256 lane's must not depend on the old secret at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  isHarnessProxyPolicySealAvailable,
  sealHarnessProxyToken,
  sealHarnessSessionEnvelope,
  unsealHarnessProxyToken,
} from "../harness-proxy-policy-seal.js";
import { signTestRs256Credential, testHarnessKey } from "./sign-test-token.js";

const LEGACY = "test-terminal-secret-32-chars-minimum";
const SEAL = "test-seal-secret-at-least-32-characters-long";
const key = testHarnessKey();
const policy: ToolPolicySnapshot = {
  mode: "default",
  denied: {},
  known: [],
  unknownTool: "allow",
};
const profile = { clientInfo: { name: "client", version: "1" } };

function handle(alg: "HS256" | "RS256") {
  const payload = {
    purpose: "harness-mcp-session",
    serverId: "srv-a",
    lane: "lane-1",
  };
  if (alg === "RS256") return signTestRs256Credential(payload, key);
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  // Only the header matters to the seal; the route verifies the signature.
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

const sealSession = (alg: "HS256" | "RS256") =>
  sealHarnessSessionEnvelope({
    handle: handle(alg),
    serverId: "srv-a",
    policy,
    profile,
  });

function secrets(values: {
  legacy?: string;
  seal?: string;
  acceptHs256?: string;
}) {
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", values.legacy ?? "");
  vi.stubEnv("HARNESS_PROXY_SEAL_SECRET", values.seal ?? "");
  vi.stubEnv("HARNESS_PROXY_ACCEPT_HS256", values.acceptHs256 ?? "");
}

beforeEach(() => secrets({ legacy: LEGACY, seal: SEAL }));
afterEach(() => vi.unstubAllEnvs());

describe("the seal key follows the enclosed credential's algorithm", () => {
  it("keeps an HS256 lane's envelope on the old secret, so the new one changes nothing", () => {
    const withBoth = sealSession("HS256");
    secrets({ legacy: LEGACY });
    expect(sealSession("HS256")).toBe(withBoth);
    secrets({ legacy: LEGACY, seal: `${SEAL}-rotated` });
    expect(sealSession("HS256")).toBe(withBoth);
  });

  it("seals an RS256 lane's envelope under the seal secret alone", () => {
    const withBoth = sealSession("RS256");
    secrets({ seal: SEAL });
    expect(sealSession("RS256")).toBe(withBoth);
    expect(unsealHarnessProxyToken(withBoth, "srv-a")).toMatchObject({
      session: true,
      token: handle("RS256"),
    });
    secrets({ legacy: LEGACY, seal: `${SEAL}-rotated` });
    expect(sealSession("RS256")).not.toBe(withBoth);
  });

  it("refuses to seal an RS256 credential without the seal secret", () => {
    secrets({ legacy: LEGACY });
    expect(() => sealSession("RS256")).toThrow(/HARNESS_PROXY_SEAL_SECRET/);
    expect(() =>
      sealHarnessProxyToken({
        token: handle("RS256"),
        serverId: "srv-a",
        policy,
        expiresAtMs: Date.now() + 60_000,
      }),
    ).toThrow(/HARNESS_PROXY_SEAL_SECRET/);
  });

  it("opens an envelope only under the secret its credential calls for", () => {
    const rs256 = sealSession("RS256");
    // The same bytes as the old secret: the tag passes, the binding doesn't.
    secrets({ legacy: SEAL, seal: `${SEAL}-other` });
    expect(unsealHarnessProxyToken(rs256, "srv-a")).toBeNull();
  });

  it("stops using the old secret once HS256 is turned off", () => {
    const hs256 = sealSession("HS256");
    expect(unsealHarnessProxyToken(hs256, "srv-a")).toMatchObject({
      session: true,
    });
    secrets({ legacy: LEGACY, seal: SEAL, acceptHs256: "false" });
    expect(unsealHarnessProxyToken(hs256, "srv-a")).toBeNull();
    expect(() => sealSession("HS256")).toThrow();
  });
});

describe("isHarnessProxyPolicySealAvailable", () => {
  it("is true with the seal secret, or the old one while HS256 is accepted", () => {
    expect(isHarnessProxyPolicySealAvailable()).toBe(true);
    secrets({ seal: SEAL });
    expect(isHarnessProxyPolicySealAvailable()).toBe(true);
    secrets({ legacy: LEGACY });
    expect(isHarnessProxyPolicySealAvailable()).toBe(true);
  });

  it("refuses policied runs with no secret it may seal with", () => {
    secrets({});
    expect(isHarnessProxyPolicySealAvailable()).toBe(false);
    secrets({ legacy: LEGACY, acceptHs256: "false" });
    expect(isHarnessProxyPolicySealAvailable()).toBe(false);
    secrets({ seal: "too-short" });
    expect(isHarnessProxyPolicySealAvailable()).toBe(false);
  });
});
