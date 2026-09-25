import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import {
  applyFreeTierLocks,
  applyWorkloadCapabilityLocks,
  composeAvailableModels,
  FREE_TIER_MODEL_REASON,
  GUEST_LOCKED_MODEL_REASON,
  isJudgeEligibleModel,
  JUDGE_INELIGIBLE_REASON,
  judgeModelOptions,
  MODEL_WORKLOAD_POLICIES,
  OUT_OF_CREDITS_MODEL_REASON,
  retiringTag,
  sortModelsNewestFirst,
  unsupportedCapabilityReason,
  unverifiedCapabilityReason,
} from "../available-models";

const OBSERVED_AT = 1_790_000_000_000;

const hosted = (
  id: string,
  over: Partial<ModelDefinition> = {},
): ModelDefinition => ({
  id,
  name: id,
  provider: id.split("/")[0]!,
  hosted: true,
  guestAllowed: true,
  ...over,
});

const TOOLS_OK = hosted("openai/gpt-4o", {
  catalogObservedAt: OBSERVED_AT,
  observations: { tools: { status: "supported", source: "gateway-catalog" } },
});
const TOOL_LESS = hosted("openai/gpt-5.6-luna", {
  catalogObservedAt: OBSERVED_AT,
  observations: {
    tools: { status: "unsupported", source: "gateway-catalog" },
  },
});
// The catalog was read with observations, but none for tools.
const TOOLS_UNKNOWN = hosted("newvendor/model-x", {
  catalogObservedAt: OBSERVED_AT,
});
// A backend that predates observations: nothing to act on.
const LEGACY = hosted("anthropic/claude-haiku-4.5");
const BYOK: ModelDefinition = {
  id: "openai/gpt-5.6-luna",
  name: "Luna (own key)",
  provider: "openai",
  hosted: false,
};

describe("applyWorkloadCapabilityLocks", () => {
  it("leaves every row untouched when the surface needs no capability", () => {
    const models = [TOOLS_OK, TOOL_LESS, TOOLS_UNKNOWN, LEGACY, BYOK];
    expect(applyWorkloadCapabilityLocks(models, "chat")).toBe(models);
    expect(applyWorkloadCapabilityLocks(models, undefined)).toBe(models);
  });

  it("never hides a model: the result has the same rows in the same order", () => {
    const models = [TOOLS_OK, TOOL_LESS, TOOLS_UNKNOWN, LEGACY, BYOK];
    for (const workload of Object.keys(MODEL_WORKLOAD_POLICIES)) {
      const out = applyWorkloadCapabilityLocks(models, workload as never);
      expect(out.map((model) => String(model.id))).toEqual(
        models.map((model) => String(model.id)),
      );
    }
  });

  it("disables a tool-less model when the workload needs tools", () => {
    for (const workload of [
      "mcpChat",
      "host",
      "evalTarget",
      "persona",
    ] as const) {
      const [row] = applyWorkloadCapabilityLocks([TOOL_LESS], workload);
      expect(row).toMatchObject({
        disabled: true,
        disabledReason: unsupportedCapabilityReason("tools"),
      });
    }
  });

  it("disables an unverified model for evals and personas, tagged not verified", () => {
    for (const workload of ["evalTarget", "persona"] as const) {
      const [row] = applyWorkloadCapabilityLocks([TOOLS_UNKNOWN], workload);
      expect(row).toMatchObject({
        disabled: true,
        disabledReason: unverifiedCapabilityReason("tools", "disable"),
        unverifiedCapabilities: ["tools"],
      });
    }
  });

  it("allows an unverified model in MCP chat with a warning", () => {
    const [row] = applyWorkloadCapabilityLocks([TOOLS_UNKNOWN], "mcpChat");
    expect(row.disabled).toBeUndefined();
    expect(row.unverifiedCapabilities).toEqual(["tools"]);
    expect(row.warningReason).toBe(unverifiedCapabilityReason("tools", "warn"));
  });

  it("acts on nothing while the catalog carries no observations (older backend, BYOK)", () => {
    // Without `catalogObservedAt` an absent observation means "not reported",
    // so every model selectable today stays selectable, even for evals.
    const models = [LEGACY, BYOK];
    const out = applyWorkloadCapabilityLocks(models, "evalTarget");
    expect(out).toEqual(models);
  });

  it("keeps a supported model enabled and an existing lock's reason", () => {
    const guestLocked = {
      ...TOOL_LESS,
      disabled: true,
      disabledReason: GUEST_LOCKED_MODEL_REASON,
    };
    const [ok, locked] = applyWorkloadCapabilityLocks(
      [TOOLS_OK, guestLocked],
      "evalTarget",
    );
    expect(ok).toEqual(TOOLS_OK);
    expect(locked.disabledReason).toBe(GUEST_LOCKED_MODEL_REASON);
  });
});

describe("applyFreeTierLocks", () => {
  const PRICEY = hosted("anthropic/claude-opus-5", { freeTierEligible: false });
  const CHEAP = hosted("openai/gpt-4o-mini", { freeTierEligible: true });

  it("no-ops unless the subject is free-tier-only", () => {
    const models = [PRICEY, CHEAP, LEGACY, BYOK];
    expect(applyFreeTierLocks(models, false)).toBe(models);
  });

  it("locks only hosted rows the catalog marks ineligible, with the upgrade/credits/BYOK copy", () => {
    const [pricey, cheap, legacy, byok] = applyFreeTierLocks(
      [PRICEY, CHEAP, LEGACY, { ...BYOK, freeTierEligible: false }],
      true,
    );
    expect(pricey).toMatchObject({
      disabled: true,
      disabledReason: FREE_TIER_MODEL_REASON,
    });
    expect(FREE_TIER_MODEL_REASON).toMatch(/upgrade/i);
    expect(FREE_TIER_MODEL_REASON).toMatch(/credits/i);
    expect(FREE_TIER_MODEL_REASON).toMatch(/own API key/i);
    expect(cheap.disabled).toBeUndefined();
    // No field from an older backend: unchanged.
    expect(legacy.disabled).toBeUndefined();
    // BYOK is a way out, never locked.
    expect(byok.disabled).toBeUndefined();
  });

  it("composes beside the out-of-credits lock, which still wins", () => {
    const base = {
      orgConfig: undefined,
      isAuthenticated: true,
      isOllamaRunning: false,
      ollamaModels: [],
      hasToken: () => false,
      getOpenRouterSelectedModels: () => [],
      getAzureBaseUrl: () => "",
      customProviders: [],
      hostedCatalog: [PRICEY, CHEAP],
    };
    const freeTier = composeAvailableModels({ ...base, freeTierOnly: true });
    const byId = (models: ModelDefinition[], id: string) =>
      models.find((model) => String(model.id) === id)!;
    expect(byId(freeTier, "anthropic/claude-opus-5").disabledReason).toBe(
      FREE_TIER_MODEL_REASON,
    );
    expect(byId(freeTier, "openai/gpt-4o-mini").disabled).toBeUndefined();

    const broke = composeAvailableModels({
      ...base,
      freeTierOnly: true,
      outOfCredits: true,
    });
    expect(byId(broke, "anthropic/claude-opus-5").disabledReason).toBe(
      OUT_OF_CREDITS_MODEL_REASON,
    );
  });
});

describe("sortModelsNewestFirst", () => {
  it("orders by release date descending, undated rows last in their original order", () => {
    const models = [
      hosted("a/old", { releasedAt: 1_000 }),
      hosted("a/undated-1"),
      hosted("a/new", { releasedAt: 3_000 }),
      hosted("a/undated-2"),
      hosted("a/mid", { releasedAt: 2_000 }),
    ];
    expect(sortModelsNewestFirst(models).map((m) => String(m.id))).toEqual([
      "a/new",
      "a/mid",
      "a/old",
      "a/undated-1",
      "a/undated-2",
    ]);
  });

  it("keeps a catalog with no release dates in its incoming order", () => {
    const models = [hosted("z/b"), hosted("z/a"), hosted("z/c")];
    expect(sortModelsNewestFirst(models)).toEqual(models);
  });
});

describe("retiringTag", () => {
  it("names the retirement date, and nothing without one", () => {
    expect(
      retiringTag(hosted("a/b", { deprecatedAt: Date.UTC(2027, 2, 3) })),
    ).toBe("Retiring Mar 3, 2027");
    expect(retiringTag(hosted("a/b"))).toBeUndefined();
  });
});

describe("judge model rows (purpose: judge)", () => {
  const row = (
    id: string,
    extra: Partial<ModelDefinition> = {}
  ): ModelDefinition => ({
    id,
    name: id,
    provider: "openai",
    hosted: true,
    ...extra,
  });

  it("admits hosted rows only", () => {
    expect(isJudgeEligibleModel(row("openai/gpt-5-mini"))).toBe(true);
    expect(
      isJudgeEligibleModel(row("gpt-4o", { hosted: false }))
    ).toBe(false);
  });

  it("keeps every hosted row while the catalog carries no observations", () => {
    expect(
      isJudgeEligibleModel(row("openai/gpt-5-mini", { judgeEligible: false }))
    ).toBe(true);
  });

  it("follows judge_eligible, else the ZDR observation, once observed", () => {
    const observed = { catalogObservedAt: OBSERVED_AT };
    expect(
      isJudgeEligibleModel(row("a/1", { ...observed, judgeEligible: true }))
    ).toBe(true);
    expect(
      isJudgeEligibleModel(row("a/2", { ...observed, judgeEligible: false }))
    ).toBe(false);
    expect(isJudgeEligibleModel(row("a/3", observed))).toBe(false);
    expect(
      isJudgeEligibleModel(
        row("a/4", {
          ...observed,
          observations: {
            openRouterZdr: { status: "supported", source: "openrouter-zdr" },
          },
        })
      )
    ).toBe(true);
  });

  it("adds the managed default and appends an ineligible current value disabled", () => {
    const { models, currentIneligible } = judgeModelOptions(
      [
        row("openai/gpt-5-mini"),
        row("openai/gpt-5-mini", { provider: "openrouter", hosted: false }),
        row("gpt-4o", { hosted: false, name: "GPT-4o" }),
      ],
      { currentModelId: "gpt-4o", managedDefaultModelId: "openai/gpt-5.4-mini" }
    );
    expect(currentIneligible).toBe(true);
    expect(models.map((model) => String(model.id))).toEqual([
      "openai/gpt-5-mini",
      "openai/gpt-5.4-mini",
      "gpt-4o",
    ]);
    expect(models[0]!.hosted).toBe(true);
    expect(models[1]).toMatchObject({ hosted: true, disabled: false });
    expect(models[2]).toMatchObject({
      name: "GPT-4o",
      disabled: true,
      disabledReason: JUDGE_INELIGIBLE_REASON,
    });
  });

  it("does not mark an eligible current value", () => {
    expect(
      judgeModelOptions([row("openai/gpt-5-mini")], {
        currentModelId: "openai/gpt-5-mini",
        managedDefaultModelId: "openai/gpt-5-mini",
      })
    ).toEqual({ models: [row("openai/gpt-5-mini")], currentIneligible: false });
  });
});
