import { describe, expect, it } from "vitest";
import type { EvalSuite } from "../../evals/types";
import {
  hostsForPreflight,
  type PreflightModel,
  type PreflightOrgConfig,
} from "../suite-run-preflight-org-keys";
import {
  hasBlockingPreflight,
  preflightTargets,
  readEnvironmentResolutions,
  runPreflight,
} from "../suite-run-preflight";

const azureConnection = {
  id: "orgprov_azure",
  providerKey: "azure",
  enabled: true,
  hasSecret: true,
  policyEligibility: { eligible: true },
};
const config: PreflightOrgConfig = { providers: [azureConnection] };
const policyConfig: PreflightOrgConfig = {
  aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
  providers: [azureConnection],
};

const missing = (model: string) =>
  `${model} has no Azure deployment. Pick a deployment for it, or add one in Organization → AI providers.`;

function azureModel(modelId: string, nativeModelId?: string): PreflightModel {
  return {
    model: modelId,
    provider: "azure",
    selection: {
      modelId,
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_azure" },
      ...(nativeModelId !== undefined ? { nativeModelId } : {}),
    },
  };
}

function preflight(
  models: PreflightModel[],
  orgConfig: PreflightOrgConfig = config,
  judge?: Parameters<typeof runPreflight>[0]["judge"],
) {
  return runPreflight({
    serverRefs: [],
    servers: {},
    models,
    orgConfig,
    judge,
  });
}

describe("preflight for an Azure OpenAI model with no deployment", () => {
  it.each([
    ["without the key policy", config],
    ["under the key policy", policyConfig],
  ])("blocks Start and names the fix %s", (_label, orgConfig) => {
    const result = preflight(
      [azureModel("azure/gpt-5.1-codex-mini")],
      orgConfig,
    );
    expect(result.orgKeyProblems).toEqual([
      missing("azure/gpt-5.1-codex-mini"),
    ]);
    expect(hasBlockingPreflight(result)).toBe(true);
  });

  it("names each model once, however many cells run it", () => {
    const result = preflight([
      azureModel("azure/gpt-5.1"),
      azureModel("azure/gpt-5.1"),
      azureModel("azure/gpt-5.1-codex"),
    ]);
    expect(result.orgKeyProblems).toEqual([
      missing("azure/gpt-5.1"),
      missing("azure/gpt-5.1-codex"),
    ]);
  });

  it.each([
    ["an explicit deployment", azureModel("azure/prod-gpt51", "prod-gpt51")],
    ["a bare deployment id", azureModel("prod-gpt51")],
    [
      "a model on another provider",
      {
        model: "openai/gpt-5",
        provider: "openai",
        selection: {
          modelId: "openai/gpt-5",
          source: "org",
          connectionRef: { kind: "orgProvider", id: "orgprov_openai" },
        },
      },
    ],
    [
      "a selection the browser can't resolve",
      { ...azureModel("azure/gpt-5.1"), selectionKnown: false },
    ],
  ])("leaves %s alone", (_label, model) => {
    expect(preflight([model]).orgKeyProblems).toBeUndefined();
  });

  it("checks a judge saved without a deployment", () => {
    const result = preflight([], config, {
      kind: "explicit",
      modelId: "azure/gpt-5.1",
      selection: azureModel("azure/gpt-5.1").selection,
    });
    expect(result.orgKeyProblems).toEqual([missing("azure/gpt-5.1")]);
  });

  it("checks a model a client passes to its environment", () => {
    const modelId = "azure/gpt-5.1-codex";
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
    const resolved = readEnvironmentResolutions({
      env: {
        hostId: "client",
        modelSource: "host",
        effectiveModelId: modelId,
        effectiveModelSelection: azureModel(modelId).selection,
      },
    });
    const plan = preflightTargets({
      suite,
      cases: [],
      environments: [{ environmentId: "env", hostId: "client", modelId: null }],
      hosts: hostsForPreflight(
        [{ hostId: "client", modelId }],
        resolved.hostModelSelections,
      ),
      environmentServerRefs: [],
    });
    const result = runPreflight({ ...plan, servers: {}, orgConfig: config });
    expect(result.orgKeyProblems).toEqual([missing(modelId)]);
  });
});
