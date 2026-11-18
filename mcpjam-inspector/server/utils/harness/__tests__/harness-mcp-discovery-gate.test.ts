import { beforeEach, describe, expect, it, vi } from "vitest";

const discovery = vi.hoisted(() => ({ assert: vi.fn() }));
vi.mock("../native-discovery.js", () => ({
  assertNativeDiscovery: discovery.assert,
}));

import { assertHarnessMcpDiscoveryGate } from "../harness-mcp-discovery-gate";

function manager(clientCapabilities: Record<string, unknown> = {}) {
  return {
    getServerConfig: vi.fn(() => ({ url: "https://server.test/mcp" })),
    getInitializationInfo: vi.fn(() => ({
      protocolVersion: "2025-11-25",
      clientCapabilities,
    })),
  };
}

const APPS = { extensions: { "io.modelcontextprotocol/ui": {} } };

type GateArgs = Parameters<typeof assertHarnessMcpDiscoveryGate>[0];

/** The manager is a two-method stub, so the literal is cast once here. */
function gate(overrides: Record<string, unknown> = {}): GateArgs {
  return {
    required: true,
    plan: { delivery: "mcp-endpoint", forwardingKind: "profiled", gaps: [] },
    harnessId: "test-harness",
    pinnedRuntimeVersion: "1.2.3",
    adapterVersion: "config-v1",
    manager: manager(),
    serverIds: ["srv-a", "srv-b"],
    hostCapabilities: undefined,
    scenarioParticipant: undefined,
    modelId: "model",
    sourceType: "direct",
    plane: "web-authorized",
    localExecution: false,
    brokeredEndpoint: "platform",
    upstreamProfile: "gateway",
    ...overrides,
  } as never;
}

beforeEach(() => discovery.assert.mockReset());

describe("required native discovery", () => {
  it.each([undefined, false])(
    "never reaches the discovery check when required is %s",
    (required) => {
      assertHarnessMcpDiscoveryGate(
        gate({
          required,
          plan: { delivery: "host-tools", gaps: ["server-capability:logging"] },
          manager: manager(APPS),
          serverIds: [],
          scenarioParticipant: { personaId: "p" },
        }),
      );
      expect(discovery.assert).not.toHaveBeenCalled();
    },
  );

  it("refuses unqualified server capabilities", () => {
    assertHarnessMcpDiscoveryGate(
      gate({
        plan: {
          delivery: "mcp-endpoint",
          gaps: ["server-capabilities-unavailable"],
        },
      }),
    );
    expect(discovery.assert.mock.calls[0]).toEqual([{ required: true }]);
  });

  it("refuses an Apps server without qualified host capabilities", () => {
    assertHarnessMcpDiscoveryGate(gate({ manager: manager(APPS) }));
    expect(discovery.assert.mock.calls[0]).toEqual([{ required: true }]);
    discovery.assert.mockReset();
    assertHarnessMcpDiscoveryGate(
      gate({
        manager: manager(APPS),
        hostCapabilities: { capabilities: {}, gaps: [] },
      }),
    );
    expect(discovery.assert.mock.calls[0]?.[0]).toHaveProperty("route");
  });

  it.each([
    ["no servers", { serverIds: [] }],
    ["a scenario participant", { scenarioParticipant: { personaId: "p" } }],
  ])("refuses %s", (_case, overrides) => {
    assertHarnessMcpDiscoveryGate(gate(overrides));
    expect(discovery.assert.mock.calls[0]).toEqual([{ required: true }]);
  });

  it("checks every server against the planner's route label", () => {
    assertHarnessMcpDiscoveryGate(gate());
    expect(discovery.assert.mock.calls).toEqual(
      ["srv-a", "srv-b"].map(() => [
        {
          required: true,
          harnessId: "test-harness",
          route: {
            runtimeVersion: "1.2.3",
            adapterVersion: "config-v1",
            protocolVersion: "2025-11-25",
            modelId: "model",
            delivery: "forwarded-bridge",
            venue: "hosted",
            surface: "chat",
            funding: "platform",
            upstreamProfile: "gateway",
          },
        },
      ]),
    );
  });

  it.each([
    [{ localExecution: true }, { venue: "local" }],
    [{ plane: "local-mcp" }, { venue: "local" }],
    [{ sourceType: "eval" }, { surface: "eval" }],
    [{ sourceType: "swarm" }, { surface: "swarm" }],
    [{ brokeredEndpoint: "byok_hosted" }, { funding: "organization" }],
    [
      { brokeredEndpoint: "customer_hosted", upstreamProfile: "org-gateway" },
      { funding: "organization", upstreamProfile: "org-gateway" },
    ],
    [
      { pinnedRuntimeVersion: undefined, adapterVersion: undefined },
      { runtimeVersion: "", adapterVersion: "" },
    ],
  ])(
    "keys the evidence by the turn's venue, surface and funding (%j)",
    (overrides, expected) => {
      assertHarnessMcpDiscoveryGate(
        gate({ serverIds: ["srv-a"], ...overrides }),
      );
      expect(discovery.assert.mock.calls[0]?.[0].route).toMatchObject(expected);
    },
  );
});
