/**
 * Model endpoint URLs get the hosted egress guard's verdict, the same one MCP
 * server URLs get: an operator's private allowlist opens a listed model
 * endpoint, and nothing it lists opens cloud metadata.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlockedEgressTargetError,
  setEgressHostResolverForTests,
} from "../hosted-egress-guard.js";
import {
  assertSafeHostedOutboundUrl,
  isUnsafeHostedOutboundUrl,
} from "../org-resolve-request.js";

afterEach(() => {
  vi.unstubAllEnvs();
  setEgressHostResolverForTests(null);
});

describe("model endpoint URLs in hosted mode", () => {
  it("refuses private endpoints when nothing is listed", async () => {
    setEgressHostResolverForTests(async () => ["10.96.0.20"]);
    expect(isUnsafeHostedOutboundUrl("http://10.0.0.7:11434")).toBe(true);
    await expect(
      assertSafeHostedOutboundUrl("http://vllm.ai.svc.cluster.local:8000/v1"),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("allows the endpoints an operator lists, by range and by suffix", async () => {
    vi.stubEnv("MCPJAM_PRIVATE_EGRESS_ALLOWLIST", "10.0.0.0/8,svc.cluster.local");
    setEgressHostResolverForTests(async (hostname) =>
      hostname === "vllm.ai.svc.cluster.local" ? ["172.20.4.4"] : [],
    );
    expect(isUnsafeHostedOutboundUrl("http://10.0.0.7:11434")).toBe(false);
    await expect(
      assertSafeHostedOutboundUrl("http://10.0.0.7:11434"),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeHostedOutboundUrl("http://vllm.ai.svc.cluster.local:8000/v1"),
    ).resolves.toBeUndefined();
    // Listed neither by range nor by suffix.
    expect(isUnsafeHostedOutboundUrl("http://192.168.0.7:11434")).toBe(true);
  });

  it("keeps metadata refused under any list", async () => {
    vi.stubEnv("MCPJAM_PRIVATE_EGRESS_ALLOWLIST", "0.0.0.0/0,internal");
    setEgressHostResolverForTests(async () => ["169.254.169.254"]);
    expect(isUnsafeHostedOutboundUrl("http://169.254.169.254/latest")).toBe(
      true,
    );
    expect(isUnsafeHostedOutboundUrl("http://metadata.google.internal/")).toBe(
      true,
    );
    await expect(
      assertSafeHostedOutboundUrl("http://models.internal/v1"),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("refuses non-http schemes and unparseable URLs", () => {
    expect(isUnsafeHostedOutboundUrl("file:///etc/passwd")).toBe(true);
    expect(isUnsafeHostedOutboundUrl("not a url")).toBe(true);
  });
});
