import { describe, expect, it } from "vitest";
import type { EvalSuite } from "../../evals/types";
import {
  hostsForPreflight,
  type PreflightOrgConfig,
} from "../suite-run-preflight-org-keys";
import {
  preflightTargets,
  readEnvironmentResolutions,
  runPreflight,
} from "../suite-run-preflight";

const modelId = "openai/gpt-5";
const suite = {
  _id: "suite",
  createdBy: "user",
  name: "Checkout",
  description: "",
  configRevision: "1",
  environment: { servers: [] },
  environmentIds: ["env"],
  createdAt: 0,
  updatedAt: 0,
} satisfies EvalSuite;
const config: PreflightOrgConfig = {
  aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
  providers: [
    {
      id: "approved",
      providerKey: "openai",
      enabled: true,
      hasSecret: true,
      policyEligibility: { eligible: true },
    },
  ],
};

function preflightFor(
  resolution: unknown,
  targets?: Parameters<typeof preflightTargets>[0]["targets"],
) {
  const resolved = readEnvironmentResolutions({ env: resolution });
  const plan = preflightTargets({
    suite,
    cases: [],
    environments: [{ environmentId: "env", hostId: "client", modelId: null }],
    hosts: hostsForPreflight(
      [{ hostId: "client", modelId }],
      resolved.hostModelSelections,
    ),
    environmentServerRefs: [],
    targets,
  });
  return {
    plan,
    result: runPreflight({ ...plan, servers: {}, orgConfig: config }),
  };
}

describe("preflight for a client-inherited organization model", () => {
  it.each([
    undefined,
    new Error("environment subscription failed"),
    { hostId: "client", modelSource: "host", effectiveModelId: modelId },
  ])(
    "leaves an unresolved selection to the backend launch check (%s)",
    (resolution) => {
      const { plan, result } = preflightFor(resolution);
      expect(plan.models[0]?.selectionKnown).toBe(false);
      expect(result.orgKeyProblems).toBeUndefined();
    },
  );

  it("uses the resolved eligible organization selection", () => {
    const selection = {
      modelId,
      source: "org",
      connectionRef: { kind: "orgProvider", id: "approved" },
    };
    const { plan, result } = preflightFor({
      hostId: "client",
      modelSource: "host",
      effectiveModelId: modelId,
      effectiveModelSelection: selection,
    });
    expect(plan.models[0]?.selection).toEqual(selection);
    expect(plan.models[0]?.selectionKnown).not.toBe(false);
    expect(result.orgKeyProblems).toBeUndefined();
  });

  it("blocks a resolved hosted selection of the same model", () => {
    const { result } = preflightFor({
      hostId: "client",
      modelSource: "host",
      effectiveModelId: modelId,
      effectiveModelSelection: { modelId, source: "hosted" },
    });
    expect(result.orgKeyProblems?.[0]).toMatch(/is an MCPJam-provided model/);
  });

  it("names a known legacy selection as missing an organization connection", () => {
    const { result } = preflightFor({
      hostId: "client",
      modelSource: "host",
      effectiveModelId: modelId,
      effectiveModelSelection: null,
    });
    expect(result.orgKeyProblems?.[0]).toMatch(
      /isn't saved with an organization provider connection/,
    );
    expect(result.orgKeyProblems?.[0]).not.toMatch(/personal or local/);
  });

  it("does not carry a stale resolution onto the client's new model", () => {
    const { result } = preflightFor({
      hostId: "client",
      modelSource: "host",
      effectiveModelId: "openai/gpt-5-mini",
      effectiveModelSelection: {
        modelId: "openai/gpt-5-mini",
        source: "hosted",
      },
    });
    expect(result.orgKeyProblems).toBeUndefined();
  });

  it("still checks an explicit cell override while the client is unresolved", () => {
    const { result } = preflightFor(undefined, [
      {
        hostId: "client",
        modelId,
        modelSelection: { modelId, source: "hosted" },
      },
    ]);
    expect(result.orgKeyProblems?.[0]).toMatch(/is an MCPJam-provided model/);
  });
});
