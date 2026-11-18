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
    expect(result.orgConfigProblems).toEqual([
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
    expect(result.orgConfigProblems).toEqual([
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
    expect(preflight([model]).orgConfigProblems).toBeUndefined();
  });

  it.each([
    ["an unlabelled row", { model: "azure/gpt-5.1", provider: "azure" }],
    [
      "a legacy row",
      {
        model: "azure/gpt-5.1",
        provider: "azure",
        selection: { modelId: "azure/gpt-5.1", source: "legacy" },
      },
    ],
  ] satisfies [string, PreflightModel][])(
    "checks %s the organization's Azure connection runs",
    (_label, model) => {
      expect(preflight([model]).orgConfigProblems).toEqual([
        missing("azure/gpt-5.1"),
      ]);
      expect(
        preflight([{ ...model, model: "prod-gpt51" }]).orgConfigProblems,
      ).toBeUndefined();
      expect(preflight([model], { providers: [] }).orgConfigProblems).toBeUndefined();
    },
  );

  it("leaves an unlabelled row alone when the Azure connection is disabled", () => {
    const disabled = { providers: [{ ...azureConnection, enabled: false }] };
    expect(
      preflight([{ model: "azure/gpt-5.1", provider: "azure" }], disabled)
        .orgConfigProblems,
    ).toBeUndefined();
  });

  it.each([
    ["deleted", { providers: [] }],
    ["disabled", { providers: [{ ...azureConnection, enabled: false }] }],
  ] satisfies [string, PreflightOrgConfig][])(
    "names no deployment for an org selection whose Azure connection was %s",
    (_label, orgConfig) => {
      // The runner refuses the missing connection (`credential_missing`)
      // first, so "add a deployment" would point at the wrong fix.
      expect(
        preflight([azureModel("azure/gpt-5.1")], orgConfig).orgConfigProblems,
      ).toBeUndefined();
    },
  );

  it("still names the deployment when another Azure connection is enabled", () => {
    const orgConfig = {
      providers: [
        { ...azureConnection, enabled: false },
        { ...azureConnection, id: "orgprov_azure_2" },
      ],
    };
    expect(
      preflight([azureModel("azure/gpt-5.1")], orgConfig).orgConfigProblems,
    ).toEqual([missing("azure/gpt-5.1")]);
  });

  it("gives a legacy row only the key-policy problem under the policy", () => {
    // The runner checks the policy first: adding a deployment wouldn't let
    // this row run, so the sheet doesn't ask for one.
    const problems = preflight(
      [
        {
          model: "azure/gpt-5.1",
          provider: "azure",
          selection: { modelId: "azure/gpt-5.1", source: "legacy" },
        },
      ],
      policyConfig,
    ).orgConfigProblems;
    expect(problems).toHaveLength(1);
    expect(problems?.[0]).toMatch(
      /^azure\/gpt-5\.1 isn't saved with an organization provider connection/,
    );
  });

  it("checks a judge saved without a deployment", () => {
    const result = preflight([], config, {
      kind: "explicit",
      modelId: "azure/gpt-5.1",
      selection: azureModel("azure/gpt-5.1").selection,
    });
    expect(result.orgConfigProblems).toEqual([missing("azure/gpt-5.1")]);
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
    expect(result.orgConfigProblems).toEqual([missing(modelId)]);
  });
});
