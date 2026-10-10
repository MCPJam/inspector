import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

import type { ModelDefinition } from "@/shared/types";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  AI_SCOPE_UNRESOLVED_REASON,
  composeAvailableModels,
  isJudgeEligibleModel,
  judgeModelOptions,
  JUDGE_INELIGIBLE_REASON,
  ORG_DEFAULT_JUDGE_LABEL,
  ORG_KEYS_MODEL_REASON,
  ORG_POLICY_LOADING_REASON,
} from "../available-models";
import {
  buildAvailableModelsFromOrgConfig,
  isOrgConnectionEligible,
  orgKeysRequired,
  type OrgVisibleConfig,
} from "../model-helpers";

const hostedHaiku: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
};

const anthropic: OrgModelProvider = {
  id: "orgprov_anthropic",
  providerKey: "anthropic",
  enabled: true,
  hasSecret: true,
};
const openRouter: OrgModelProvider = {
  id: "orgprov_openrouter",
  providerKey: "openrouter",
  enabled: true,
  hasSecret: true,
  selectedModels: ["openai/gpt-4o"],
};
const localOllama: OrgModelProvider = {
  id: "orgprov_ollama",
  providerKey: "ollama",
  enabled: true,
  hasSecret: false,
  baseUrl: "http://localhost:11434",
  modelIds: ["llama3.2:latest"],
};
const cloudCustom: OrgModelProvider = {
  id: "orgprov_custom",
  providerKey: "custom:acme",
  enabled: true,
  hasSecret: true,
  baseUrl: "https://llm.example.com/v1",
  modelIds: ["acme-large"],
  runtimeLocation: "cloud",
};

function policyConfig(
  providers: OrgModelProvider[],
  extra: Partial<OrgVisibleConfig> = {},
): OrgVisibleConfig {
  return {
    providers,
    aiKeyPolicy: { requireOrgKeys: true, revision: 2 },
    ...extra,
  };
}

function compose(
  orgConfig: OrgVisibleConfig | undefined,
  extra: Partial<Parameters<typeof composeAvailableModels>[0]> = {},
) {
  return composeAvailableModels({
    orgConfig,
    isAuthenticated: true,
    isOllamaRunning: true,
    ollamaModels: [
      { id: "local-llama", name: "local-llama", provider: "ollama" },
    ],
    hasToken: () => true,
    getOpenRouterSelectedModels: () => ["openai/gpt-4o"],
    getAzureBaseUrl: () => "",
    customProviders: [],
    hostedCatalog: [hostedHaiku],
    ...extra,
  });
}

describe("org connection eligibility", () => {
  it("admits direct cloud connections only", () => {
    expect(isOrgConnectionEligible(anthropic)).toBe(true);
    expect(isOrgConnectionEligible(openRouter)).toBe(false);
    expect(isOrgConnectionEligible(localOllama)).toBe(false);
    expect(isOrgConnectionEligible(cloudCustom)).toBe(true);
    expect(isOrgConnectionEligible({ ...anthropic, enabled: false })).toBe(
      false,
    );
    expect(
      isOrgConnectionEligible({ ...anthropic, runtimeLocation: "local" }),
    ).toBe(false);
  });

  it("follows the backend's eligibleConnectionIds when present", () => {
    const readiness = {
      requireOrgKeys: true,
      features: [],
      operations: [],
      eligibleConnectionIds: ["orgprov_custom"],
    };
    expect(isOrgConnectionEligible(anthropic, { aiReadiness: readiness })).toBe(
      false,
    );
    expect(
      isOrgConnectionEligible(cloudCustom, { aiReadiness: readiness }),
    ).toBe(true);
  });

  it("reads the policy from either field", () => {
    expect(orgKeysRequired(undefined)).toBe(false);
    expect(orgKeysRequired({ aiKeyPolicy: { requireOrgKeys: false } })).toBe(
      false,
    );
    expect(orgKeysRequired({ aiKeyPolicy: { requireOrgKeys: true } })).toBe(
      true,
    );
  });
});

describe("buildAvailableModelsFromOrgConfig under the policy", () => {
  it("offers only eligible org rows, never hosted ones", () => {
    const rows = buildAvailableModelsFromOrgConfig(
      policyConfig([anthropic, openRouter, localOllama, cloudCustom]),
      [hostedHaiku],
    );
    expect(rows.some((row) => row.hosted)).toBe(false);
    expect(rows.some((row) => row.provider === "openrouter")).toBe(false);
    expect(rows.some((row) => row.provider === "ollama")).toBe(false);
    expect(rows.some((row) => row.provider === "anthropic")).toBe(true);
    expect(rows.some((row) => row.customProviderName === "acme")).toBe(true);
    expect(rows.every((row) => row.judgeEligible === true)).toBe(true);
  });

  it("off the policy keeps every connection but stamps only eligible rows as judges", () => {
    const rows = buildAvailableModelsFromOrgConfig(
      { providers: [anthropic, openRouter] },
      [hostedHaiku],
    );
    const router = rows.find((row) => row.provider === "openrouter")!;
    const direct = rows.find(
      (row) => row.provider === "anthropic" && !row.hosted,
    )!;
    expect(router.judgeEligible).toBeUndefined();
    expect(direct.judgeEligible).toBe(true);
    expect(rows.some((row) => row.hosted)).toBe(true);
  });
});

describe("composeAvailableModels under the policy", () => {
  it("drops hosted rows, personal keys and local runtimes, with no hosted floor", () => {
    const models = compose(policyConfig([anthropic, openRouter, localOllama]));
    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every((model) => model.orgProvider?.id === "orgprov_anthropic"),
    ).toBe(true);
    expect(models.some((model) => String(model.id) === "local-llama")).toBe(
      false,
    );
  });

  it("returns an empty list when no eligible provider is configured", () => {
    expect(compose(policyConfig([]))).toEqual([]);
    expect(compose(policyConfig([openRouter, localOllama]))).toEqual([]);
  });

  it("keeps a saved selection the policy no longer offers, disabled", () => {
    const models = compose(policyConfig([anthropic]), {
      savedModelIds: ["anthropic/claude-haiku-4.5", null, ""],
    });
    const saved = models.find(
      (model) => String(model.id) === "anthropic/claude-haiku-4.5",
    );
    expect(saved).toMatchObject({
      name: "Claude Haiku 4.5",
      hosted: true,
      disabled: true,
      disabledReason: ORG_KEYS_MODEL_REASON,
    });
    expect(models.filter((model) => model.disabled)).toHaveLength(1);
  });

  it("keeps an unknown saved id as a synthetic disabled row even when nothing else is offered", () => {
    expect(compose(policyConfig([]), { savedModelIds: ["acme/old"] })).toEqual([
      {
        id: "acme/old",
        name: "acme/old",
        provider: "acme",
        disabled: true,
        disabledReason: ORG_KEYS_MODEL_REASON,
      },
    ]);
  });

  it("does not lock a saved selection that is still offered", () => {
    const offered = compose(policyConfig([anthropic]));
    const id = String(offered[0]!.id);
    const models = compose(policyConfig([anthropic]), { savedModelIds: [id] });
    expect(models.filter((model) => model.disabled)).toHaveLength(0);
  });

  it("is unchanged when the policy is off", () => {
    const models = compose({
      providers: [anthropic],
      aiKeyPolicy: { requireOrgKeys: false, revision: 1 },
    });
    expect(models.some((model) => model.hosted)).toBe(true);
    expect(models.every((model) => !model.disabled)).toBe(true);
  });

  it("locks every row while the organization's settings load", () => {
    const models = compose({ providers: [], pending: true });
    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every(
        (model) =>
          model.disabled && model.disabledReason === ORG_POLICY_LOADING_REASON,
      ),
    ).toBe(true);
  });

  it("locks every row for a project no organization owns", () => {
    const models = compose({ providers: [], unresolved: true });
    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every(
        (model) => model.disabledReason === AI_SCOPE_UNRESOLVED_REASON,
      ),
    ).toBe(true);
  });
});

describe("judge rows with organization providers", () => {
  const orgRow: ModelDefinition = {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    hosted: false,
    orgProvider: { providerKey: "anthropic", id: "orgprov_anthropic" },
    judgeEligible: true,
  };
  const routerRow: ModelDefinition = {
    id: "openai/gpt-4o",
    name: "openai/gpt-4o",
    provider: "openrouter",
    hosted: false,
    orgProvider: { providerKey: "openrouter", id: "orgprov_openrouter" },
  };

  it("admits org rows from eligible connections as judges", () => {
    expect(isJudgeEligibleModel(orgRow)).toBe(true);
    expect(isJudgeEligibleModel(routerRow)).toBe(false);
    expect(
      isJudgeEligibleModel({
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        hosted: false,
      }),
    ).toBe(false);
  });

  it("offers hosted and eligible org rows off the policy", () => {
    const { models } = judgeModelOptions([hostedHaiku, orgRow, routerRow], {
      currentModelId: "",
      managedDefaultModelId: "anthropic/claude-haiku-4.5",
    });
    expect(models.map((model) => String(model.id))).toEqual([
      "anthropic/claude-haiku-4.5",
      "claude-sonnet-4-5",
    ]);
  });

  it("offers only org rows under the policy, with the default on the org's Smart model", () => {
    const { models } = judgeModelOptions([orgRow, routerRow], {
      currentModelId: "",
      managedDefaultModelId: "anthropic/claude-haiku-4.5",
      requireOrgKeys: true,
    });
    expect(models.map((model) => model.name)).toEqual([
      "Claude Sonnet 4.5",
      ORG_DEFAULT_JUDGE_LABEL,
    ]);
  });

  it("shows a saved hosted judge as no longer allowed under the policy", () => {
    const { models, currentIneligible, current } = judgeModelOptions(
      [orgRow, { ...hostedHaiku, id: "openai/gpt-5-mini", name: "GPT-5 mini" }],
      {
        currentModelId: "openai/gpt-5-mini",
        managedDefaultModelId: "anthropic/claude-haiku-4.5",
        requireOrgKeys: true,
      },
    );
    expect(currentIneligible).toBe(true);
    expect(current).toMatchObject({
      name: "GPT-5 mini",
      disabled: true,
      disabledReason: ORG_KEYS_MODEL_REASON,
    });
    expect(models.at(-1)).toBe(current);
  });

  it("keeps the old reason for an ineligible judge off the policy", () => {
    const { current } = judgeModelOptions([hostedHaiku, routerRow], {
      currentModelId: "openai/gpt-4o",
      managedDefaultModelId: "anthropic/claude-haiku-4.5",
    });
    expect(current?.disabledReason).toBe(JUDGE_INELIGIBLE_REASON);
  });

  it("resolves an org judge saved under its canonical id through its selection", () => {
    const { current, currentIneligible } = judgeModelOptions([orgRow], {
      currentModelId: "anthropic/claude-sonnet-4.5",
      currentSelection: {
        modelId: "anthropic/claude-sonnet-4.5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_anthropic" },
        nativeModelId: "claude-sonnet-4-5",
        fallback: { provider: "none", model: "none" },
      },
      managedDefaultModelId: "anthropic/claude-haiku-4.5",
    });
    expect(currentIneligible).toBe(false);
    expect(current).toBe(orgRow);
  });
});
