import { describe, expect, it } from "vitest";
import {
  assertNativeDiscovery,
  enforceNativeDiscoverySessionPin,
} from "../native-discovery.js";
import {
  harnessModelSupport,
  type HarnessDiscoveryRoute,
} from "@/shared/harness-model-support";

const route: HarnessDiscoveryRoute = {
  runtimeVersion: "0.163.0",
  modelId: "openai/gpt-5.5",
  delivery: "forwarded-bridge",
  adapterVersion: "native-mcp-v1",
  protocolVersion: "2026-07-28",
  venue: "hosted",
  surface: "chat",
  funding: "platform",
  upstreamProfile: "gateway",
};

describe("native discovery admission", () => {
  it.each([undefined, false])(
    "does not change ordinary execution (%s)",
    (required) => {
      expect(() => assertNativeDiscovery({ required })).not.toThrow();
    },
  );
  it("accepts the observed route", () => {
    expect(() =>
      assertNativeDiscovery({ required: true, harnessId: "codex", route }),
    ).not.toThrow();
  });
  it.each([
    { runtimeVersion: "0.163.1" },
    { modelId: "openai/gpt-5.4" },
    { adapterVersion: "future-adapter" },
    { protocolVersion: "2027-01-01" },
    { delivery: "forwarded-native" as const },
    { delivery: "host-tools" as const },
    { delivery: "native-proxy" as const },
    { venue: "local" as const },
    { surface: "eval" as const },
    { surface: "swarm" as const },
    { funding: "organization" as const },
    { upstreamProfile: "openai-native" as const },
  ])("refuses an unqualified route dimension: %j", (changed) => {
    expect(() =>
      assertNativeDiscovery({
        required: true,
        harnessId: "codex",
        route: { ...route, ...changed },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        status: 409,
        details: { reason: "native_discovery_unqualified" },
      }),
    );
  });
  it("does not confuse general model support with discovery qualification", () => {
    expect(
      harnessModelSupport({
        harnessId: "codex",
        runtimeVersion: route.runtimeVersion,
        modelId: "openai/gpt-5.4",
      }).status,
    ).toBe("supported");
    expect(() =>
      assertNativeDiscovery({
        required: true,
        harnessId: "codex",
        route: { ...route, modelId: "openai/gpt-5.4" },
      }),
    ).toThrow("not qualified");
  });
  it("refuses a missing or emulated route", () => {
    expect(() => assertNativeDiscovery({ required: true })).toThrow(
      "requires a qualified harness",
    );
  });
});

describe("conversation discovery requirement", () => {
  it.each([undefined, false])(
    "preserves ordinary client policy (%s)",
    (required) => {
      const host = { requireNativeToolDiscovery: false };
      enforceNativeDiscoverySessionPin(host, required);
      expect(host.requireNativeToolDiscovery).toBe(false);
    },
  );
  it("enforces a saved requirement after the client is edited", () => {
    const host = { requireNativeToolDiscovery: false };
    enforceNativeDiscoverySessionPin(host, true);
    expect(host.requireNativeToolDiscovery).toBe(true);
  });
  it("refuses removing the client from a required conversation", () => {
    expect(() => enforceNativeDiscoverySessionPin(undefined, true)).toThrow(
      "requires a qualified harness",
    );
  });
});
