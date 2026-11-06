/**
 * The MCP route a harness turn takes, as one table.
 *
 * Every row is a literal expectation. `legacyPlan` is the decision exactly as
 * `run-harness-turn.ts` spells it inline today; the agreement test proves the
 * rows describe that code before anything moves out of it.
 */
import { describe, expect, it, vi } from "vitest";
import type { ForwardingRuntimeContract } from "../forwarding/runtime-contract";
import type { HarnessMcpProxyStrategy } from "../harness-proxy-strategy";

type Admission = { delivery?: "native" | "bridge"; gaps: string[] };

type Facts = {
  dispatch: { mcpClient: "mcpjam" | "harness" };
  forwardingRuntime: ForwardingRuntimeContract | undefined;
  forwardingOrganization: boolean;
  accountRouting: boolean;
  forwardingEnabled: boolean;
  plane: HarnessMcpProxyStrategy["plane"] | undefined;
  selectedServerCount: number;
  hostId?: string;
  scenarioId?: string;
  evalIterationId?: string;
  journeyRunId?: string;
  localExecution: boolean;
  admit: () => Admission;
};

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

/** Lines 1565–1566, 1632–1641, 1669–1671, 1682 and 1713–1719 of the runner. */
function legacyPlan(f: Facts): Observed {
  let nativeMcpDelivery = f.dispatch.mcpClient === "harness";
  const forwardingRuntime = f.forwardingRuntime;
  const nativeCandidate =
    f.forwardingEnabled &&
    f.forwardingOrganization &&
    (nativeMcpDelivery ||
      (forwardingRuntime !== undefined && !f.accountRouting)) &&
    forwardingRuntime !== undefined &&
    f.plane === "web-authorized" &&
    !f.scenarioId &&
    !f.evalIterationId &&
    !f.journeyRunId &&
    !f.localExecution &&
    !!f.hostId &&
    f.selectedServerCount > 0;
  const admission: Admission = nativeCandidate
    ? f.admit()
    : { delivery: undefined, gaps: [] };
  const enhancedApps = admission.delivery === "bridge";
  const useNativeForwarding = admission.delivery !== undefined;
  const label = useNativeForwarding
    ? enhancedApps
      ? "forwarded-bridge"
      : "forwarded-native"
    : nativeMcpDelivery
      ? "native-proxy"
      : "host-tools";
  nativeMcpDelivery ||= useNativeForwarding;
  const surface =
    forwardingRuntime !== undefined &&
    !f.localExecution &&
    f.plane === "web-authorized" &&
    f.forwardingEnabled &&
    f.forwardingOrganization &&
    !f.scenarioId &&
    !f.evalIterationId &&
    !f.journeyRunId &&
    !!f.hostId;
  return {
    candidate: nativeCandidate,
    surface,
    useNativeForwarding,
    enhancedApps,
    nativeMcpDelivery,
    label,
    gaps: admission.gaps,
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
    admitCalls: 1,
  },
  {
    name: "ready, profiled forwarding admitted",
    facts: { admit: BRIDGE },
    expected: {
      ...forwarded("forwarded-bridge"),
      gaps: ["app-host-capabilities", "unqualified-protocol"],
    },
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
    admitCalls: 1,
  },
  {
    name: "MCPJam client, pass-through admitted",
    facts: { admit: NATIVE, dispatch: { mcpClient: "mcpjam" } },
    expected: forwarded("forwarded-native"),
    admitCalls: 1,
  },
  {
    name: "forwarding flag off",
    facts: { forwardingEnabled: false },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "organization not enrolled",
    facts: { forwardingOrganization: false },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "no qualified forwarding runtime",
    facts: { forwardingRuntime: undefined },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "no qualified forwarding runtime, MCPJam client",
    facts: { forwardingRuntime: undefined, dispatch: { mcpClient: "mcpjam" } },
    expected: notCandidate("host-tools", false),
    admitCalls: 0,
  },
  {
    name: "local-mcp plane",
    facts: { plane: "local-mcp" },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "local-loopback plane",
    facts: { plane: "local-loopback" },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "no plane",
    facts: { plane: undefined },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "scenario turn",
    facts: { scenarioId: "scenario-1" },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "eval iteration",
    facts: { evalIterationId: "iteration-1" },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "journey run",
    facts: { journeyRunId: "journey-1" },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "local execution target",
    facts: { localExecution: true },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "no host id",
    facts: { hostId: undefined },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  {
    name: "empty host id",
    facts: { hostId: "" },
    expected: notCandidate("native-proxy", false),
    admitCalls: 0,
  },
  // The surface stays open with no servers: the retained-resource executor
  // reads the surface, not the candidate.
  {
    name: "no servers selected",
    facts: { selectedServerCount: 0 },
    expected: notCandidate("native-proxy", true),
    admitCalls: 0,
  },
  {
    name: "account routing on the MCPJam client",
    facts: { accountRouting: true, dispatch: { mcpClient: "mcpjam" } },
    expected: notCandidate("host-tools", true),
    admitCalls: 0,
  },
  // `resolveAgentLoop` never pairs account routing with the harness client;
  // the row pins the literal expression the runner evaluates anyway.
  {
    name: "account routing on the harness client",
    facts: { accountRouting: true, admit: NATIVE },
    expected: forwarded("forwarded-native"),
    admitCalls: 1,
  },
];

function withAdmitSpy(row: Row) {
  const admit = vi.fn(row.facts.admit ?? NATIVE);
  return { admit, facts: facts({ ...row.facts, admit }) };
}

describe("harness MCP route table", () => {
  it.each(ROUTE_ROWS)("$name", (row) => {
    const { admit, facts: input } = withAdmitSpy(row);
    expect(legacyPlan(input)).toEqual({ gaps: [], ...row.expected });
    expect(admit).toHaveBeenCalledTimes(row.admitCalls);
  });
});
