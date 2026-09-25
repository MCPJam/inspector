import { describe, expect, it } from "vitest";
import { isModelSelection, selectionKey } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import type { OrgVisibleConfig } from "../model-helpers";
import { buildAvailableModelsFromOrgConfig } from "../model-helpers";
import {
  canonicalSelectionModelId,
  caseModelEntry,
  findModelForStoredChoice,
  modelSelectionFromDefinition,
  storedModelChoice,
} from "../model-selection";

const hostedHaiku: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
};

const orgConfig: OrgVisibleConfig = {
  providers: [
    {
      id: "orgprov_openrouter_1",
      providerKey: "openrouter",
      enabled: true,
      hasSecret: true,
      selectedModels: ["anthropic/claude-haiku-4.5"],
    },
    {
      id: "orgprov_openai_1",
      providerKey: "openai",
      enabled: true,
      hasSecret: true,
    },
    {
      id: "orgprov_custom_acme",
      providerKey: "custom:acme",
      enabled: true,
      hasSecret: true,
      baseUrl: "https://models.example/v1",
      modelIds: ["llama-3"],
    },
    {
      id: "orgprov_ollama",
      providerKey: "ollama",
      enabled: true,
      hasSecret: false,
      baseUrl: "http://ollama.internal:11434",
      modelIds: ["llama3"],
    },
  ],
};

/** Every key the selection shape allows, at any depth. */
const ALLOWED_KEYS = new Set([
  "modelId",
  "source",
  "connectionRef",
  "nativeModelId",
  "settings",
  "fallback",
  "kind",
  "id",
  "providerKey",
  "customProviderName",
  "provider",
  "model",
  "reasoningEffort",
  "temperature",
]);
const KEY_LIKE = /key|secret|token|password|auth|header|credential/i;

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

describe("canonicalSelectionModelId", () => {
  it.each([
    [{ id: "gpt-4o", provider: "openai" }, "openai/gpt-4o"],
    [
      { id: "claude-haiku-4-5", provider: "anthropic" },
      "anthropic/claude-haiku-4-5",
    ],
    [{ id: "grok-3", provider: "xai" }, "x-ai/grok-3"],
    [
      { id: "mistral-large-latest", provider: "mistral" },
      "mistralai/mistral-large-latest",
    ],
    [{ id: "llama3.2:latest", provider: "ollama" }, "ollama/llama3.2:latest"],
    [{ id: "openai/gpt-4o", provider: "openrouter" }, "openai/gpt-4o"],
    [{ id: "xai/grok-4", provider: "openrouter" }, "x-ai/grok-4"],
    [{ id: "azure/gpt-5.1", provider: "azure" }, "azure/gpt-5.1"],
    [
      {
        id: "custom:acme:llama-3",
        provider: "custom",
        customProviderName: "acme",
      },
      "custom:acme/llama-3",
    ],
  ])("%j → %s", (row, expected) => {
    expect(
      canonicalSelectionModelId({ name: "x", hosted: false, ...row }),
    ).toBe(expected);
  });

  it("keeps hosted catalog ids verbatim", () => {
    expect(canonicalSelectionModelId(hostedHaiku)).toBe(
      "anthropic/claude-haiku-4.5",
    );
  });
});

describe("modelSelectionFromDefinition", () => {
  it("hosted row → source hosted, no connection, purpose fallback", () => {
    expect(
      modelSelectionFromDefinition(hostedHaiku, undefined, "evalTarget"),
    ).toEqual({
      modelId: "anthropic/claude-haiku-4.5",
      source: "hosted",
      fallback: { provider: "none", model: "none" },
    });
    expect(
      modelSelectionFromDefinition(hostedHaiku, undefined, "chat")?.fallback,
    ).toEqual({ provider: "openrouter", model: "none" });
  });

  it("org OpenRouter row with the SAME id as a hosted row → source org with that connection", () => {
    const models = buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku]);
    const rows = models.filter(
      (m) => String(m.id) === "anthropic/claude-haiku-4.5",
    );
    expect(rows).toHaveLength(2);
    const byok = rows.find((m) => m.hosted === false)!;
    const hosted = rows.find((m) => m.hosted === true)!;

    const orgSelection = modelSelectionFromDefinition(
      byok,
      orgConfig,
      "evalTarget",
    );
    expect(orgSelection).toEqual({
      modelId: "anthropic/claude-haiku-4.5",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_openrouter_1" },
      fallback: { provider: "none", model: "none" },
    });
    const hostedSelection = modelSelectionFromDefinition(
      hosted,
      orgConfig,
      "evalTarget",
    );
    expect(hostedSelection?.source).toBe("hosted");
    expect(selectionKey(orgSelection!)).not.toBe(
      selectionKey(hostedSelection!),
    );
  });

  it("org first-party BYOK row → canonical id + nativeModelId", () => {
    const row: ModelDefinition = {
      id: "gpt-4-turbo",
      name: "GPT-4 Turbo",
      provider: "openai",
      hosted: false,
    };
    expect(modelSelectionFromDefinition(row, orgConfig, "judge")).toEqual({
      modelId: "openai/gpt-4-turbo",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_openai_1" },
      nativeModelId: "gpt-4-turbo",
      fallback: { provider: "none", model: "none" },
    });
  });

  it("org custom provider row → org connection of that slug", () => {
    const row: ModelDefinition = {
      id: "custom:acme:llama-3",
      name: "Acme / llama-3",
      provider: "custom",
      customProviderName: "acme",
      hosted: false,
    };
    expect(
      modelSelectionFromDefinition(row, orgConfig, "evalTarget"),
    ).toMatchObject({
      modelId: "custom:acme/llama-3",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_custom_acme" },
      nativeModelId: "custom:acme:llama-3",
    });
  });

  it("locally detected Ollama model on an org list stays local", () => {
    const row: ModelDefinition = {
      id: "qwen2.5:7b",
      name: "qwen2.5:7b",
      provider: "ollama",
      hosted: false,
    };
    expect(
      modelSelectionFromDefinition(row, orgConfig, "evalTarget"),
    ).toMatchObject({
      modelId: "ollama/qwen2.5:7b",
      source: "local",
      connectionRef: { kind: "localProvider", providerKey: "ollama" },
      nativeModelId: "qwen2.5:7b",
    });
    const orgOllama = { ...row, id: "llama3", name: "llama3" };
    expect(
      modelSelectionFromDefinition(orgOllama, orgConfig, "evalTarget")?.source,
    ).toBe("org");
  });

  it("org row whose provider id the config does not expose → null (keep legacy)", () => {
    const noIds: OrgVisibleConfig = {
      providers: orgConfig.providers.map(({ id: _id, ...rest }) => rest),
    };
    const row: ModelDefinition = {
      id: "gpt-4-turbo",
      name: "GPT-4 Turbo",
      provider: "openai",
      hosted: false,
    };
    expect(modelSelectionFromDefinition(row, noIds, "evalTarget")).toBeNull();
    expect(storedModelChoice(row, noIds, "evalTarget")).toEqual({
      modelId: "gpt-4-turbo",
    });
  });

  it("user-local rows → source local with providerKey / customProviderName", () => {
    expect(
      modelSelectionFromDefinition(
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", hosted: false },
        undefined,
        "chat",
      ),
    ).toEqual({
      modelId: "openai/gpt-4o",
      source: "local",
      connectionRef: { kind: "localProvider", providerKey: "openai" },
      nativeModelId: "gpt-4o",
      fallback: { provider: "openrouter", model: "none" },
    });
    expect(
      modelSelectionFromDefinition(
        {
          id: "custom:mine:m1",
          name: "m1",
          provider: "custom",
          customProviderName: "mine",
          hosted: false,
        },
        undefined,
        "evalTarget",
      ),
    ).toMatchObject({
      modelId: "custom:mine/m1",
      source: "local",
      connectionRef: {
        kind: "localProvider",
        providerKey: "custom",
        customProviderName: "mine",
      },
    });
  });

  it("never emits a key-like field, for any row of a composed list", () => {
    const withSecrets = {
      providers: orgConfig.providers.map((p) => ({
        ...p,
        apiKey: "sk-should-never-leak",
      })),
    } as unknown as OrgVisibleConfig;
    const models = buildAvailableModelsFromOrgConfig(withSecrets, [
      hostedHaiku,
    ]);
    expect(models.length).toBeGreaterThan(3);
    for (const model of models) {
      for (const purpose of ["chat", "evalTarget", "judge"] as const) {
        const selection = modelSelectionFromDefinition(
          model,
          withSecrets,
          purpose,
        );
        if (!selection) continue;
        expect(isModelSelection(selection)).toBe(true);
        const keys = collectKeys(selection);
        for (const key of keys) {
          expect(ALLOWED_KEYS.has(key)).toBe(true);
          if (key !== "providerKey") expect(key).not.toMatch(KEY_LIKE);
        }
        expect(JSON.stringify(selection)).not.toContain("sk-should-never-leak");
      }
    }
  });
});

describe("org rows carry their connection", () => {
  it("rows built from an org config build org selections without the config at hand", () => {
    const models = buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku]);
    const byok = models.find(
      (m) =>
        String(m.id) === "anthropic/claude-haiku-4.5" && m.hosted === false,
    )!;
    expect(byok.orgProvider).toEqual({
      providerKey: "openrouter",
      id: "orgprov_openrouter_1",
    });
    expect(
      modelSelectionFromDefinition(byok, undefined, "evalTarget")
        ?.connectionRef,
    ).toEqual({ kind: "orgProvider", id: "orgprov_openrouter_1" });
  });

  it("an org row without an exposed id never degrades to a local selection", () => {
    const noIds: OrgVisibleConfig = {
      providers: orgConfig.providers.map(({ id: _id, ...rest }) => rest),
    };
    const models = buildAvailableModelsFromOrgConfig(noIds, [hostedHaiku]);
    for (const model of models.filter((m) => m.orgProvider)) {
      expect(
        modelSelectionFromDefinition(model, undefined, "evalTarget"),
      ).toBeNull();
    }
  });
});

describe("org Azure deployments", () => {
  const azureConfig = (modelIds?: string[]): OrgVisibleConfig => ({
    providers: [
      {
        id: "orgprov_azure_1",
        providerKey: "azure",
        enabled: true,
        hasSecret: true,
        baseUrl: "https://contoso.openai.azure.com/openai",
        ...(modelIds ? { modelIds } : {}),
      },
    ],
  });

  it("deployment rows replace the static azure rows and carry the deployment", () => {
    const models = buildAvailableModelsFromOrgConfig(
      azureConfig(["prod-gpt51", " prod-gpt51 ", "eval.mini"]),
      [],
    );
    const azure = models.filter((m) => m.provider === "azure");
    expect(azure).toEqual([
      {
        id: "azure/prod-gpt51",
        name: "prod-gpt51 (Azure)",
        provider: "azure",
        nativeModelId: "prod-gpt51",
        orgProvider: { providerKey: "azure", id: "orgprov_azure_1" },
        hosted: false,
      },
      {
        id: "azure/eval.mini",
        name: "eval.mini (Azure)",
        provider: "azure",
        nativeModelId: "eval.mini",
        orgProvider: { providerKey: "azure", id: "orgprov_azure_1" },
        hosted: false,
      },
    ]);
  });

  it("the selection builder saves the deployment as nativeModelId", () => {
    const [row] = buildAvailableModelsFromOrgConfig(
      azureConfig(["prod-gpt51"]),
      [],
    ).filter((m) => m.provider === "azure");
    expect(modelSelectionFromDefinition(row, undefined, "evalTarget")).toEqual({
      modelId: "azure/prod-gpt51",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_azure_1" },
      nativeModelId: "prod-gpt51",
      fallback: { provider: "none", model: "none" },
    });
  });

  it("with no deployments configured, the static rows stay and name none", () => {
    const azure = buildAvailableModelsFromOrgConfig(azureConfig(), []).filter(
      (m) => m.provider === "azure",
    );
    expect(azure.map((m) => m.id)).toContain("azure/gpt-5.1");
    const selection = modelSelectionFromDefinition(
      azure.find((m) => m.id === "azure/gpt-5.1")!,
      undefined,
      "chat",
    );
    // No deployment is invented by stripping the prefix.
    expect(selection?.nativeModelId).toBeUndefined();
  });
});

describe("stored choices", () => {
  it("store the canonical id beside the selection and read back the picked row", () => {
    const models = buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku]);
    const byok = models.find(
      (m) =>
        String(m.id) === "anthropic/claude-haiku-4.5" && m.hosted === false,
    )!;
    const stored = storedModelChoice(byok, orgConfig, "evalTarget");
    expect(stored.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(stored.selection?.source).toBe("org");
    // Reload: the stored choice resolves to the org row, not the hosted twin.
    expect(findModelForStoredChoice(stored, models, orgConfig)).toBe(byok);
    // A legacy row with the same id keeps hosted-first.
    expect(
      findModelForStoredChoice(
        { modelId: "anthropic/claude-haiku-4.5" },
        models,
        orgConfig,
      )?.hosted,
    ).toBe(true);
  });

  it("bare BYOK ids round-trip through the canonical stored id", () => {
    const models = buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku]);
    const bare = models.find(
      (m) => m.provider === "openai" && !String(m.id).includes("/"),
    )!;
    expect(bare).toBeDefined();
    const stored = storedModelChoice(bare, orgConfig, "evalTarget");
    expect(stored).toMatchObject({
      modelId: `openai/${String(bare.id)}`,
      selection: { nativeModelId: String(bare.id), source: "org" },
    });
    expect(findModelForStoredChoice(stored, models, orgConfig)).toBe(bare);
  });
});

describe("case model chips", () => {
  it("attach the selection of the row the chip names, beside the unchanged id", () => {
    const models = buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku]);
    expect(
      caseModelEntry(
        { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
        models,
      ),
    ).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      selection: {
        modelId: "anthropic/claude-haiku-4.5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_openrouter_1" },
        fallback: { provider: "none", model: "none" },
      },
    });
    expect(
      caseModelEntry(
        { provider: "anthropic", model: "anthropic/claude-haiku-4.5" },
        models,
      ).selection?.source,
    ).toBe("hosted");
  });

  it("bare-id rows and unknown rows stay legacy", () => {
    const models = buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku]);
    const bare = models.find(
      (m) => m.provider === "openai" && !String(m.id).includes("/"),
    )!;
    expect(
      caseModelEntry({ provider: "openai", model: String(bare.id) }, models),
    ).toEqual({ provider: "openai", model: String(bare.id) });
    expect(
      caseModelEntry({ provider: "openai", model: "nope" }, models),
    ).toEqual({ provider: "openai", model: "nope" });
  });

  it("write the legacy pair alone when the deployment does not store selections", () => {
    const models = buildAvailableModelsFromOrgConfig(orgConfig, [hostedHaiku]);
    expect(
      caseModelEntry(
        { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
        models,
        false,
      ),
    ).toEqual({ provider: "openrouter", model: "anthropic/claude-haiku-4.5" });
  });
});
