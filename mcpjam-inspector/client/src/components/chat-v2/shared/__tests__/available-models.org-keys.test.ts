import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

import type { ModelDefinition } from "@/shared/types";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  composeAvailableModels,
  isJudgeEligibleModel,
  isOrgKeysDisallowedRow,
  judgeModelOptions,
  JUDGE_INELIGIBLE_REASON,
  ORG_KEYS_MODEL_REASON,
  ORG_POLICY_LOADING_REASON,
  orgKeysDisallowedNotice,
  savedModelRow,
} from "../available-models";
import {
  buildAvailableModelsFromOrgConfig,
  type OrgVisibleConfig,
} from "../model-helpers";
import { isUsableOrgConnection } from "../org-ai-policy";
import { harnessPickerModels } from "@/lib/harness-model-locks";

const hostedHaiku: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
};

// Each connection carries the backend's verdict (`policyEligibility`), as
// the visible config sends it. The picker only reads it.
const anthropic: OrgModelProvider = {
  id: "orgprov_anthropic",
  providerKey: "anthropic",
  enabled: true,
  hasSecret: true,
  policyEligibility: { eligible: true },
};
const openRouter: OrgModelProvider = {
  id: "orgprov_openrouter",
  providerKey: "openrouter",
  enabled: true,
  hasSecret: true,
  selectedModels: ["openai/gpt-4o"],
  policyEligibility: {
    eligible: false,
    code: "org_keys_required",
    message: "Use a direct provider connection.",
  },
};
const localOllama: OrgModelProvider = {
  id: "orgprov_ollama",
  providerKey: "ollama",
  enabled: true,
  hasSecret: false,
  baseUrl: "http://localhost:11434",
  modelIds: ["llama3.2:latest"],
  policyEligibility: { eligible: false, code: "org_keys_required" },
};
const cloudCustom: OrgModelProvider = {
  id: "orgprov_custom",
  providerKey: "custom:acme",
  enabled: true,
  hasSecret: true,
  baseUrl: "https://llm.example.com/v1",
  modelIds: ["acme-large"],
  runtimeLocation: "cloud",
  policyEligibility: { eligible: true },
};
// The same connection from a backend that sends no verdict.
const anthropicNoVerdict: OrgModelProvider = {
  id: "orgprov_anthropic",
  providerKey: "anthropic",
  enabled: true,
  hasSecret: true,
};
const openAi: OrgModelProvider = {
  id: "orgprov_openai",
  providerKey: "openai",
  enabled: true,
  hasSecret: true,
  policyEligibility: { eligible: true },
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

describe("org connection eligibility comes from the backend", () => {
  it("offers a connection the backend calls eligible, whatever its provider", () => {
    // A custom connection the backend admits is offered; an Anthropic one it
    // refuses is not. Nothing is worked out from the provider key.
    const rows = buildAvailableModelsFromOrgConfig(
      policyConfig([
        { ...anthropic, policyEligibility: { eligible: false } },
        cloudCustom,
      ]),
      [hostedHaiku],
    );
    expect(rows.some((row) => row.provider === "anthropic")).toBe(false);
    expect(rows.some((row) => row.customProviderName === "acme")).toBe(true);
  });

  it("offers no connection the backend sent no verdict for (an older backend)", () => {
    expect(
      buildAvailableModelsFromOrgConfig(policyConfig([anthropicNoVerdict]), [
        hostedHaiku,
      ]),
    ).toEqual([]);
    expect(compose(policyConfig([anthropicNoVerdict]))).toEqual([]);
  });

  it("off the policy, offers a connection without a verdict but never as a judge", () => {
    const rows = buildAvailableModelsFromOrgConfig(
      { providers: [anthropicNoVerdict] },
      [hostedHaiku],
    );
    const direct = rows.filter((row) => row.orgProvider);
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every((row) => row.judgeEligible === undefined)).toBe(true);
  });

  it("needs a saved key as well as the verdict", () => {
    // The verdict never looks at keys: an eligible connection with no saved
    // key is still unusable, unless its provider runs without one.
    const keyless = { ...anthropic, hasSecret: false };
    const keylessCustom = { ...cloudCustom, hasSecret: false };
    expect(isUsableOrgConnection(keyless, true)).toBe(false);
    expect(isUsableOrgConnection(keyless, false)).toBe(false);
    expect(isUsableOrgConnection(keylessCustom, true)).toBe(true);
    expect(isUsableOrgConnection(anthropic, true)).toBe(true);
    expect(isUsableOrgConnection(anthropicNoVerdict, true)).toBe(false);
    expect(isUsableOrgConnection(anthropicNoVerdict, false)).toBe(true);
    expect(isUsableOrgConnection({ ...anthropic, enabled: false }, true)).toBe(
      false,
    );

    const rows = buildAvailableModelsFromOrgConfig(
      policyConfig([keyless, keylessCustom]),
      [hostedHaiku],
    );
    expect(rows.some((row) => row.provider === "anthropic")).toBe(false);
    expect(rows.some((row) => row.customProviderName === "acme")).toBe(true);
    // Off the policy a keyless connection lists no rows and grades nothing.
    expect(
      buildAvailableModelsFromOrgConfig({ providers: [keyless] }, [
        hostedHaiku,
      ]).some((row) => row.orgProvider),
    ).toBe(false);
  });

  it("never offers a disabled connection", () => {
    expect(
      buildAvailableModelsFromOrgConfig(
        policyConfig([{ ...anthropic, enabled: false }]),
        [hostedHaiku],
      ),
    ).toEqual([]);
  });
});

describe("a harness host under the policy", () => {
  it("offers only connections the backend calls eligible AND on the harness's vendor", () => {
    const rows = buildAvailableModelsFromOrgConfig(
      policyConfig([anthropic, openAi, openRouter]),
      [hostedHaiku],
    );
    const claudeCode = harnessPickerModels(
      rows,
      { harnessId: "claude-code" },
      { requireOrgKeys: true },
    );
    expect(claudeCode.length).toBeGreaterThan(0);
    expect(
      claudeCode.every((row) => row.orgProvider?.id === "orgprov_anthropic"),
    ).toBe(true);
  });

  it("offers nothing when the vendor's connection is not eligible", () => {
    const rows = buildAvailableModelsFromOrgConfig(
      policyConfig([
        {
          ...anthropic,
          policyEligibility: { eligible: false, code: "org_keys_required" },
        },
        openAi,
      ]),
      [hostedHaiku],
    );
    expect(
      harnessPickerModels(
        rows,
        { harnessId: "claude-code" },
        { requireOrgKeys: true },
      ),
    ).toEqual([]);
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

  it("gives each row its own connection's verdict when two connections share a provider", () => {
    const cloudOllama: OrgModelProvider = {
      id: "orgprov_ollama_cloud",
      providerKey: "ollama",
      enabled: true,
      hasSecret: false,
      baseUrl: "https://ollama.example.com",
      modelIds: ["qwen3:latest"],
      policyEligibility: { eligible: true },
    };
    const rows = buildAvailableModelsFromOrgConfig(
      { providers: [localOllama, cloudOllama] },
      [hostedHaiku],
    );
    const local = rows.find((row) => row.id === "llama3.2:latest")!;
    const cloud = rows.find((row) => row.id === "qwen3:latest")!;
    expect(local.orgProvider).toEqual({
      providerKey: "ollama",
      id: "orgprov_ollama",
    });
    expect(local.judgeEligible).toBeUndefined();
    expect(cloud.orgProvider).toEqual({
      providerKey: "ollama",
      id: "orgprov_ollama_cloud",
    });
    expect(cloud.judgeEligible).toBe(true);
  });

  it("judges a row by the connection it names, not by another one with the same key", () => {
    // Both connections are enabled; the static Anthropic rows name the first.
    const refusedAnthropic: OrgModelProvider = {
      ...anthropic,
      id: "orgprov_anthropic_refused",
      policyEligibility: { eligible: false, code: "org_keys_required" },
    };
    const rows = buildAvailableModelsFromOrgConfig(
      { providers: [refusedAnthropic, anthropic] },
      [hostedHaiku],
    );
    const direct = rows.filter(
      (row) => row.provider === "anthropic" && !row.hosted,
    );
    expect(direct.length).toBeGreaterThan(0);
    expect(
      direct.every(
        (row) =>
          row.orgProvider?.id === "orgprov_anthropic_refused" &&
          row.judgeEligible === undefined,
      ),
    ).toBe(true);
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

  it("names a saved hosted id from the hosted catalog when the composition has no row for it", () => {
    // Under the policy the composition's own hosted catalog is not loaded
    // into the list; the snapshot still names the model.
    const models = compose(policyConfig([anthropic]), {
      hostedCatalog: [],
      savedModelIds: ["anthropic/claude-haiku-4.5"],
    });
    const saved = models.find(
      (model) => String(model.id) === "anthropic/claude-haiku-4.5",
    );
    expect(saved?.name).toBe("Claude Haiku 4.5");
    expect(isOrgKeysDisallowedRow(saved)).toBe(true);
    expect(orgKeysDisallowedNotice(saved!)).toBe(
      "Claude Haiku 4.5 isn't allowed here. Choose an organization model.",
    );
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

  it("compares a saved id exactly as the surface holds it", () => {
    // The surface finds its saved model by exact id, so a padded id that
    // only matches an offered row once trimmed still gets its own row.
    const offered = compose(policyConfig([anthropic]));
    const padded = ` ${String(offered[0]!.id)}`;
    const models = compose(policyConfig([anthropic]), {
      savedModelIds: [padded],
    });
    expect(models.some((model) => String(model.id) === padded)).toBe(true);
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

  it("composes a project no organization owns as today", () => {
    // No organization's policy applies to it, so nothing is locked: the
    // backend runs it unless an organization that requires its own keys is
    // involved, and then refuses it.
    const models = compose({ providers: [], unresolved: true });
    expect(models.length).toBeGreaterThan(0);
    expect(models).toEqual(compose(undefined));
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

  it("offers only org rows under the policy, with no default judge", () => {
    const { models, current } = judgeModelOptions([orgRow, routerRow], {
      currentModelId: "",
      managedDefaultModelId: "anthropic/claude-haiku-4.5",
      requireOrgKeys: true,
    });
    expect(models.map((model) => model.name)).toEqual(["Claude Sonnet 4.5"]);
    expect(current).toBeUndefined();
  });

  it("reads the managed default's id as no judge under the policy", () => {
    const { models, current, currentIneligible } = judgeModelOptions([orgRow], {
      currentModelId: "anthropic/claude-haiku-4.5",
      managedDefaultModelId: "anthropic/claude-haiku-4.5",
      requireOrgKeys: true,
    });
    expect(models).toEqual([orgRow]);
    expect(current).toBeUndefined();
    expect(currentIneligible).toBe(false);
  });

  it("keeps the managed default row off the policy", () => {
    const { models } = judgeModelOptions([orgRow], {
      currentModelId: "",
      managedDefaultModelId: "anthropic/claude-haiku-4.5",
    });
    expect(models.map((model) => String(model.id))).toEqual([
      "claude-sonnet-4-5",
      "anthropic/claude-haiku-4.5",
    ]);
  });

  it("shows a saved hosted judge only as the current value under the policy, never as a row", () => {
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
    expect(isOrgKeysDisallowedRow(current)).toBe(true);
    expect(models).toEqual([orgRow]);
  });

  it("names a saved hosted judge from the hosted catalog, not its raw id", () => {
    // The org-only list has no row for it at all.
    const { current } = judgeModelOptions([orgRow], {
      currentModelId: "anthropic/claude-haiku-4.5",
      managedDefaultModelId: "openai/gpt-5-mini",
      requireOrgKeys: true,
    });
    expect(current?.name).toBe("Claude Haiku 4.5");
    expect(savedModelRow("acme/unknown").name).toBe("acme/unknown");
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

  it("does not stand in the same model on another connection for a saved org judge under the policy", () => {
    // The judge grades on its saved connection. When that one is gone, a row
    // of the same model on another connection is not the saved judge.
    const otherConnection: ModelDefinition = {
      ...orgRow,
      id: "anthropic/claude-sonnet-4.5",
      orgProvider: { providerKey: "anthropic", id: "orgprov_other" },
    };
    const { current, currentIneligible } = judgeModelOptions(
      [otherConnection],
      {
        currentModelId: "anthropic/claude-sonnet-4.5",
        currentSelection: {
          modelId: "anthropic/claude-sonnet-4.5",
          source: "org",
          connectionRef: { kind: "orgProvider", id: "orgprov_removed" },
          fallback: { provider: "none", model: "none" },
        },
        managedDefaultModelId: "anthropic/claude-haiku-4.5",
        requireOrgKeys: true,
      },
    );
    expect(currentIneligible).toBe(true);
    expect(isOrgKeysDisallowedRow(current)).toBe(true);
  });
});

describe("pending organization policy", () => {
  it("offers no usable hosted, personal or organization model before policy loads", () => {
    const orgConfig = { providers: [], pending: true };
    expect(buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku])).toEqual(
      [],
    );
    const rows = composeAvailableModels({
      orgConfig,
      isAuthenticated: true,
      isOllamaRunning: false,
      ollamaModels: [],
      hasToken: () => true,
      getOpenRouterSelectedModels: () => [],
      getAzureBaseUrl: () => "",
      customProviders: [],
      hostedCatalog: [hostedHaiku],
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (row) =>
          row.disabled && row.disabledReason === ORG_POLICY_LOADING_REASON,
      ),
    ).toBe(true);
  });
});
