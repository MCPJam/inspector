import { describe, expect, it, vi } from "vitest";
import { HARNESS_MCP_AT_TURN_LIMITS } from "@mcpjam/sdk/host-config/internal";
import {
  HARNESS_MCP_PLANNER_VERSION,
  type HarnessMcpPlan,
} from "../harness-mcp-plan";
import {
  LOCAL_MCP_PROFILE_REASON,
  buildHarnessMcpAtTurn,
  type HarnessMcpConnectionFacts,
} from "../harness-mcp-receipt";

const DIGEST = "c".repeat(64);

function plan(overrides: Partial<HarnessMcpPlan> = {}): HarnessMcpPlan {
  return {
    upstream: "mcpjam",
    delivery: "host-tools",
    surface: true,
    candidate: false,
    gaps: [],
    reasons: ["forwarding flag off"],
    ...overrides,
  };
}

function receipt(
  routePlan: HarnessMcpPlan,
  connection: Partial<HarnessMcpConnectionFacts> = {},
  extra: Partial<Parameters<typeof buildHarnessMcpAtTurn>[0]> = {},
) {
  return buildHarnessMcpAtTurn({
    plan: routePlan,
    connection: {
      plane: "web-authorized",
      serverCount: 1,
      profileDigest: () => DIGEST,
      ...connection,
    },
    pinnedRuntimeVersion: "2.1.245",
    observedRuntimeVersion: undefined,
    adapterVersion: "tool-search-auto-v1",
    requireNativeToolDiscovery: false,
    ...extra,
  });
}

describe("whose handshake the receipt names", () => {
  it.each([
    ["host tools on the turn's manager", plan(), {}],
    [
      "the hosted rebuild proxy, which replays the sealed profile",
      plan({ delivery: "mcp-endpoint" }),
      { plane: "web-authorized" as const },
    ],
    [
      "the local loopback plane, which serves this manager",
      plan({ delivery: "mcp-endpoint" }),
      { plane: "local-loopback" as const },
    ],
    [
      "profiled forwarding, sealed from this manager",
      plan({ delivery: "mcp-endpoint", forwardingKind: "profiled" }),
      {},
    ],
  ])("names the client profile for %s", (_route, routePlan, connection) => {
    expect(receipt(routePlan, connection)).toMatchObject({
      profile: "client",
      profileDigest: DIGEST,
    });
  });

  it("names no profile on pass-through forwarding: the harness did its own handshake", () => {
    const pass = receipt(
      plan({
        upstream: "harness",
        delivery: "mcp-endpoint",
        forwardingKind: "pass-through",
        reasons: [],
      }),
    );
    expect(pass).toMatchObject({
      upstream: "harness",
      forwarding: { kind: "pass-through" },
    });
    expect(pass).not.toHaveProperty("profile");
    expect(pass).not.toHaveProperty("profileDigest");
  });

  it("refuses to guess on the local-mcp plane and says why", () => {
    const local = receipt(plan({ delivery: "mcp-endpoint" }), {
      plane: "local-mcp",
    });
    expect(local).not.toHaveProperty("profile");
    expect(local?.reasons).toContain(LOCAL_MCP_PROFILE_REASON);
  });

  it("names no profile with no servers, without repeating the planner's reason", () => {
    const none = receipt(plan({ reasons: ["no servers selected"] }), {
      serverCount: 0,
    });
    expect(none).not.toHaveProperty("profile");
    expect(none?.reasons).toEqual(["no servers selected"]);
  });

  it("keeps the profile when the digest cannot be computed", () => {
    const digest = vi.fn((): string => {
      throw new Error("The selected MCP connection is unavailable.");
    });
    const kept = receipt(plan(), { profileDigest: digest });
    expect(kept).toMatchObject({ profile: "client" });
    expect(kept).not.toHaveProperty("profileDigest");
  });
});

describe("the rest of the receipt", () => {
  it("copies the planner's gaps and reasons and names the planner", () => {
    const retained = receipt(
      plan({
        delivery: "mcp-endpoint",
        candidate: true,
        gaps: ["unqualified-protocol"],
        reasons: ["forwarding not admitted; configured route retained"],
      }),
    );
    expect(retained).toMatchObject({
      version: 1,
      gaps: ["unqualified-protocol"],
      reasons: ["forwarding not admitted; configured route retained"],
      plannerVersion: HARNESS_MCP_PLANNER_VERSION,
      pinnedRuntimeVersion: "2.1.245",
      adapterVersion: "tool-search-auto-v1",
    });
  });

  it("records versions only when they are known", () => {
    const unknown = receipt(
      plan(),
      {},
      {
        pinnedRuntimeVersion: undefined,
        adapterVersion: undefined,
      },
    );
    expect(unknown?.pinnedRuntimeVersion).toBe("");
    expect(unknown).not.toHaveProperty("adapterVersion");
    expect(unknown).not.toHaveProperty("observedRuntimeVersion");
    expect(
      receipt(plan(), {}, { observedRuntimeVersion: "2026.11.05-86047df" }),
    ).toMatchObject({ observedRuntimeVersion: "2026.11.05-86047df" });
  });

  it("records whether discovery was required", () => {
    expect(receipt(plan())?.qualification).toEqual({ status: "not-required" });
    expect(
      receipt(plan(), {}, { requireNativeToolDiscovery: true })?.qualification,
    ).toEqual({ status: "supported" });
  });

  it("sends nothing rather than a receipt the readers would drop", () => {
    const tooMany = Array.from(
      { length: HARNESS_MCP_AT_TURN_LIMITS.gaps + 1 },
      (_, index) => `gap-${index}`,
    );
    expect(receipt(plan({ gaps: tooMany }))).toBeUndefined();
  });
});
