/**
 * The MCP route a harness turn takes, as one table.
 *
 * Every row is a literal expectation, first pinned against the inline decision
 * the runner used to spell out before it moved into `resolveHarnessMcpPlan`.
 * The runner-level cases live in `run-harness-turn-mcp-plan.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HARNESS_MCP_AT_TURN_DELIVERIES,
  HARNESS_MCP_AT_TURN_FORWARDING_KINDS,
  HARNESS_MCP_AT_TURN_LIMITS,
  HARNESS_MCP_AT_TURN_UPSTREAMS,
} from "@mcpjam/sdk/host-config/internal";
import type { ForwardingRuntimeContract } from "../forwarding/runtime-contract";
import {
  HARNESS_MCP_PLAN_REASONS,
  harnessDiscoveryRoute,
  hostedForwardingSurface,
  resolveHarnessMcpPlan,
  toDiscoveryDeliveryLabel,
  type HarnessForwardingAdmission as Admission,
  type HarnessMcpPlan,
  type HarnessMcpPlanFacts as Facts,
  type HarnessMcpPlanReason,
} from "../harness-mcp-plan";

type Observed = {
  candidate: boolean;
  surface: boolean;
  useNativeForwarding: boolean;
  enhancedApps: boolean;
  nativeMcpDelivery: boolean;
  label:
    "forwarded-native" | "forwarded-bridge" | "native-proxy" | "host-tools";
  gaps: string[];
};

const RUNTIME: ForwardingRuntimeContract = {
  runtimeVersion: "pinned",
  configurationVersion: "config-v1",
  refresh: (runtime) => runtime,
};

/** The values the runner reads off a plan, named as the runner names them. */
function observed(plan: HarnessMcpPlan): Observed {
  return {
    candidate: plan.candidate,
    surface: plan.surface,
    useNativeForwarding: plan.forwardingKind !== undefined,
    enhancedApps: plan.forwardingKind === "profiled",
    nativeMcpDelivery: plan.delivery === "mcp-endpoint",
    label: toDiscoveryDeliveryLabel(plan),
    gaps: plan.gaps,
  };
}

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    dispatch: { mcpClient: "harness" },
    forwardingRuntime: RUNTIME,
    forwardingOrganization: true,
    accountRouting: false,
    forwardingEnabled: true,
    plane: "web-authorized",
    selectedServerCount: 1,
    hostId: "host-1",
    localExecution: false,
    admit: () => ({ delivery: "native", gaps: [] }),
    ...overrides,
  };
}

const NATIVE = (): Admission => ({ delivery: "native", gaps: [] });
const BRIDGE = (): Admission => ({
  delivery: "bridge",
  gaps: ["app-host-capabilities", "unqualified-protocol"],
});
const RETAINED = (): Admission => ({ gaps: ["unqualified-protocol"] });

type Row = {
  name: string;
  facts: Partial<Facts>;
  expected: Omit<Observed, "gaps"> & { gaps?: string[] };
  reasons: HarnessMcpPlanReason[];
  admitCalls: number;
};

const forwarded = (label: "forwarded-native" | "forwarded-bridge") => ({
  candidate: true,
  surface: true,
  useNativeForwarding: true,
  enhancedApps: label === "forwarded-bridge",
  nativeMcpDelivery: true,
  label,
});
const notCandidate = (
  configured: "native-proxy" | "host-tools",
  surface: boolean,
) => ({
  candidate: false,
  surface,
  useNativeForwarding: false,
  enhancedApps: false,
  nativeMcpDelivery: configured === "native-proxy",
  label: configured,
});

const ROUTE_ROWS: Row[] = [
  {
    name: "ready, pass-through admitted",
    facts: { admit: NATIVE },
    expected: forwarded("forwarded-native"),
    reasons: [],
    admitCalls: 1,
  },
  {
    name: "ready, profiled forwarding admitted",
    facts: { admit: BRIDGE },
    expected: {
      ...forwarded("forwarded-bridge"),
      gaps: ["app-host-capabilities", "unqualified-protocol"],
    },
    reasons: [],
    admitCalls: 1,
  },
  {
    name: "ready, not admitted, harness client retained",
    facts: { admit: RETAINED },
    expected: {
      ...notCandidate("native-proxy", true),
      candidate: true,
      gaps: ["unqualified-protocol"],
    },
    reasons: ["forwarding not admitted; configured route retained"],
    admitCalls: 1,
  },
  {
    name: "ready, not admitted, MCPJam client retained",
    facts: { admit: RETAINED, dispatch: { mcpClient: "mcpjam" } },
    expected: {
      ...notCandidate("host-tools", true),
      candidate: true,
      gaps: ["unqualified-protocol"],
    },
    reasons: ["forwarding not admitted; configured route retained"],
    admitCalls: 1,
  },
  {
    name: "MCPJam client, pass-through admitted",
    facts: { admit: NATIVE, dispatch: { mcpClient: "mcpjam" } },
    expected: forwarded("forwarded-native"),
    reasons: [],
    admitCalls: 1,
  },
  {
    name: "forwarding flag off",
    facts: { forwardingEnabled: false },
    expected: notCandidate("native-proxy", false),
    reasons: ["forwarding flag off"],
    admitCalls: 0,
  },
  {
    name: "organization not enrolled",
    facts: { forwardingOrganization: false },
    expected: notCandidate("native-proxy", false),
    reasons: ["organization not enrolled"],
    admitCalls: 0,
  },
  {
    name: "no qualified forwarding runtime",
    facts: { forwardingRuntime: undefined },
    expected: notCandidate("native-proxy", false),
    reasons: ["runtime contract unqualified"],
    admitCalls: 0,
  },
  {
    name: "no qualified forwarding runtime, MCPJam client",
    facts: { forwardingRuntime: undefined, dispatch: { mcpClient: "mcpjam" } },
    expected: notCandidate("host-tools", false),
    reasons: ["runtime contract unqualified"],
    admitCalls: 0,
  },
  {
    name: "local-mcp plane",
    facts: { plane: "local-mcp" },
    expected: notCandidate("native-proxy", false),
    reasons: ["plane is not web-authorized"],
    admitCalls: 0,
  },
  {
    name: "local-loopback plane",
    facts: { plane: "local-loopback" },
    expected: notCandidate("native-proxy", false),
    reasons: ["plane is not web-authorized"],
    admitCalls: 0,
  },
  {
    name: "no plane",
    facts: { plane: undefined },
    expected: notCandidate("native-proxy", false),
    reasons: ["plane is not web-authorized"],
    admitCalls: 0,
  },
  {
    name: "scenario turn",
    facts: { scenarioId: "scenario-1" },
    expected: notCandidate("native-proxy", false),
    reasons: ["scenario turn"],
    admitCalls: 0,
  },
  {
    name: "eval iteration",
    facts: { evalIterationId: "iteration-1" },
    expected: notCandidate("native-proxy", false),
    reasons: ["eval iteration"],
    admitCalls: 0,
  },
  {
    name: "journey run",
    facts: { journeyRunId: "journey-1" },
    expected: notCandidate("native-proxy", false),
    reasons: ["journey run"],
    admitCalls: 0,
  },
  {
    name: "local execution target",
    facts: { localExecution: true },
    expected: notCandidate("native-proxy", false),
    reasons: ["local execution target"],
    admitCalls: 0,
  },
  {
    name: "no host id",
    facts: { hostId: undefined },
    expected: notCandidate("native-proxy", false),
    reasons: ["no host id"],
    admitCalls: 0,
  },
  {
    name: "empty host id",
    facts: { hostId: "" },
    expected: notCandidate("native-proxy", false),
    reasons: ["no host id"],
    admitCalls: 0,
  },
  // The surface stays open with no servers: the retained-resource executor
  // reads the surface, not the candidate.
  {
    name: "no servers selected",
    facts: { selectedServerCount: 0 },
    expected: notCandidate("native-proxy", true),
    reasons: ["no servers selected"],
    admitCalls: 0,
  },
  {
    name: "account routing on the MCPJam client",
    facts: { accountRouting: true, dispatch: { mcpClient: "mcpjam" } },
    expected: notCandidate("host-tools", true),
    reasons: ["account routing"],
    admitCalls: 0,
  },
  // `resolveAgentLoop` never pairs account routing with the harness client;
  // the row pins the literal expression the runner evaluates anyway.
  {
    name: "account routing on the harness client",
    facts: { accountRouting: true, admit: NATIVE },
    expected: forwarded("forwarded-native"),
    reasons: [],
    admitCalls: 1,
  },
  {
    name: "several refusals at once, in the planner's order",
    facts: {
      forwardingEnabled: false,
      scenarioId: "scenario-1",
      selectedServerCount: 0,
    },
    expected: notCandidate("native-proxy", false),
    reasons: ["forwarding flag off", "scenario turn", "no servers selected"],
    admitCalls: 0,
  },
];

function withAdmitSpy(row: Row) {
  const admit = vi.fn(row.facts.admit ?? NATIVE);
  return { admit, facts: facts({ ...row.facts, admit }) };
}

describe("harness MCP route table", () => {
  it.each(ROUTE_ROWS)("$name", (row) => {
    const { admit, facts: input } = withAdmitSpy(row);
    const plan = resolveHarnessMcpPlan(input);
    expect(observed(plan)).toEqual({ gaps: [], ...row.expected });
    expect(plan.reasons).toEqual(row.reasons);
    expect(admit).toHaveBeenCalledTimes(row.admitCalls);
  });
});

describe("the dedicated GitHub Copilot CLI client", () => {
  // Its own MCP client either way: forwarded where forwarding opens,
  // MCPJam's per-server proxy everywhere else. Never refused for the route.
  const copilot = (overrides: Partial<Facts> = {}) =>
    facts({
      dispatch: { mcpClient: "harness" },
      forwardingRuntime: RUNTIME,
      ...overrides,
    });

  it("forwards on pass-through when admitted", () => {
    const plan = resolveHarnessMcpPlan(copilot({ admit: NATIVE }));
    expect(plan).toMatchObject({
      upstream: "harness",
      delivery: "mcp-endpoint",
      forwardingKind: "pass-through",
    });
  });

  it("takes the profiled bridge when admission bridges the turn", () => {
    const plan = resolveHarnessMcpPlan(copilot({ admit: BRIDGE }));
    expect(plan).toMatchObject({
      upstream: "mcpjam",
      delivery: "mcp-endpoint",
      forwardingKind: "profiled",
      reasons: [],
    });
  });

  it.each([
    ["no admission", { admit: RETAINED }, "forwarding not admitted; configured route retained"],
    ["the flag off", { forwardingEnabled: false }, "forwarding flag off"],
    ["an unenrolled organization", { forwardingOrganization: false }, "organization not enrolled"],
    ["an eval", { evalIterationId: "e" }, "eval iteration"],
    ["a User Testing session", { scenarioId: "s" }, "scenario turn"],
    ["a v1 API turn", { hostId: undefined }, "no host id"],
    ["a member's computer", { localExecution: true, plane: "local-loopback" }, "local execution target"],
  ] as const)("bridges through MCPJam's proxy on %s", (_name, overrides, reason) => {
    const plan = resolveHarnessMcpPlan(copilot(overrides));
    expect(plan).toMatchObject({ upstream: "mcpjam", delivery: "mcp-endpoint" });
    expect(plan.forwardingKind).toBeUndefined();
    expect(plan.reasons).toContain(reason);
    expect(toDiscoveryDeliveryLabel(plan)).toBe("native-proxy");
  });

  it("keeps MCPJam's client when the turn routes between accounts", () => {
    // `resolveAgentLoop` hands account routing to MCPJam's client.
    const plan = resolveHarnessMcpPlan(
      copilot({ dispatch: { mcpClient: "mcpjam" }, accountRouting: true }),
    );
    expect(plan).toMatchObject({ upstream: "mcpjam", delivery: "host-tools" });
    expect(plan.reasons).toContain("account routing");
  });
});

describe("the three route fields", () => {
  it.each([
    ["forwarded-native", NATIVE, "harness", "mcp-endpoint", "pass-through"],
    ["forwarded-bridge", BRIDGE, "mcpjam", "mcp-endpoint", "profiled"],
    ["native-proxy", RETAINED, "mcpjam", "mcp-endpoint", undefined],
  ] as const)(
    "describes %s by who talks to the server and how tools arrive",
    (label, admit, upstream, delivery, forwardingKind) => {
      const plan = resolveHarnessMcpPlan(facts({ admit }));
      expect(plan).toMatchObject({ upstream, delivery });
      expect(plan.forwardingKind).toBe(forwardingKind);
      expect(toDiscoveryDeliveryLabel(plan)).toBe(label);
    },
  );

  it("describes host tools on MCPJam's client", () => {
    const plan = resolveHarnessMcpPlan(
      facts({ dispatch: { mcpClient: "mcpjam" }, forwardingEnabled: false }),
    );
    expect(plan).toMatchObject({ upstream: "mcpjam", delivery: "host-tools" });
    expect(plan).not.toHaveProperty("forwardingKind");
    expect(toDiscoveryDeliveryLabel(plan)).toBe("host-tools");
  });

  it("speaks the receipt's vocabulary and stays inside its limits", () => {
    expect(HARNESS_MCP_AT_TURN_UPSTREAMS).toEqual(["mcpjam", "harness"]);
    expect(HARNESS_MCP_AT_TURN_DELIVERIES).toEqual([
      "host-tools",
      "mcp-endpoint",
    ]);
    expect(HARNESS_MCP_AT_TURN_FORWARDING_KINDS).toEqual([
      "pass-through",
      "profiled",
    ]);
    expect(HARNESS_MCP_PLAN_REASONS.length).toBeLessThanOrEqual(
      HARNESS_MCP_AT_TURN_LIMITS.reasons,
    );
    for (const reason of HARNESS_MCP_PLAN_REASONS) {
      expect(reason.length).toBeLessThanOrEqual(
        HARNESS_MCP_AT_TURN_LIMITS.string,
      );
    }
  });

  it("puts the route label on the discovery evidence key", () => {
    const route = {
      runtimeVersion: "pinned",
      adapterVersion: "config-v1",
      protocolVersion: "2025-11-25",
      modelId: "model",
      venue: "hosted",
      surface: "chat",
      funding: "platform",
      upstreamProfile: "gateway",
    } as const;
    expect(
      harnessDiscoveryRoute(
        resolveHarnessMcpPlan(facts({ admit: BRIDGE })),
        route,
      ),
    ).toEqual({ ...route, delivery: "forwarded-bridge" });
  });
});

describe("the hosted forwarding surface", () => {
  it.each([
    [{ hostId: "host-1", localExecution: false }, true],
    [{ hostId: "", localExecution: false }, false],
    [{ hostId: "host-1", scenarioId: "s", localExecution: false }, false],
    [{ hostId: "host-1", evalIterationId: "e", localExecution: false }, false],
    [{ hostId: "host-1", journeyRunId: "j", localExecution: false }, false],
    [{ hostId: "host-1", localExecution: true }, false],
  ])("reads %j as %s", (input, open) => {
    expect(hostedForwardingSurface(input)).toBe(open);
  });
});

describe("what the planner must not know", () => {
  const source = (file: string) =>
    readFileSync(join(__dirname, "..", file), "utf8");
  it.each([
    "harness-mcp-plan.ts",
    "harness-mcp-discovery-gate.ts",
    "agent-loop-dispatch.ts",
  ])("%s names no harness, so a new adapter needs no edit there", (file) => {
    expect(source(file)).not.toMatch(/claude-code|codex|cursor/i);
  });
  it("reads no environment: the runner passes the forwarding switch in", () => {
    expect(source("harness-mcp-plan.ts")).not.toContain("process.env");
  });
});

describe("a web client's own route (E4)", () => {
  /** Every exclusion the planner checks, each on its own and all at once. */
  const EXCLUSIONS: Array<[string, Partial<Facts>]> = [
    ["forwarding off", { forwardingEnabled: false }],
    ["organization not enrolled", { forwardingOrganization: false }],
    ["no runtime contract", { forwardingRuntime: undefined }],
    ["local loopback plane", { plane: "local-loopback" }],
    ["scenario turn", { scenarioId: "scenario-1" }],
    ["eval iteration", { evalIterationId: "iteration-1" }],
    ["journey run", { journeyRunId: "journey-run-1" }],
    ["local execution", { localExecution: true }],
    ["no host id", { hostId: undefined }],
    ["account routing", { dispatch: { mcpClient: "mcpjam" }, accountRouting: true }],
    [
      "all of them",
      {
        forwardingEnabled: false,
        forwardingOrganization: false,
        forwardingRuntime: undefined,
        plane: undefined,
        scenarioId: "s",
        evalIterationId: "e",
        journeyRunId: "j",
        localExecution: true,
        hostId: undefined,
        accountRouting: true,
      },
    ],
  ];

  it.each(EXCLUSIONS)("forwards past %s without asking admission", (_name, overrides) => {
    const admit = vi.fn(RETAINED);
    const plan = resolveHarnessMcpPlan(
      facts({ ...overrides, webConnector: true, admit }),
    );
    expect(plan).toEqual({
      upstream: "harness",
      delivery: "mcp-endpoint",
      forwardingKind: "pass-through",
      surface: true,
      candidate: true,
      gaps: [],
      reasons: [],
    });
    expect(admit).not.toHaveBeenCalled();
    expect(toDiscoveryDeliveryLabel(plan)).toBe("forwarded-native");
  });

  it("leaves every other runtime on the exclusion list", () => {
    const plan = resolveHarnessMcpPlan(
      facts({ evalIterationId: "iteration-1", webConnector: false }),
    );
    expect(plan.forwardingKind).toBeUndefined();
    expect(plan.reasons).toContain("eval iteration");
  });

  it("hands each turn its own plan, so a caller cannot edit the next one's", () => {
    const first = resolveHarnessMcpPlan(facts({ webConnector: true }));
    first.reasons.push("eval iteration");
    first.gaps.push("client-tools");
    const second = resolveHarnessMcpPlan(facts({ webConnector: true }));
    expect(second.reasons).toEqual([]);
    expect(second.gaps).toEqual([]);
  });
});
