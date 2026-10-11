import { describe, expect, it } from "vitest";
import { ranTurnSelection } from "../session-model-selection";

const hostedRow = { id: "openai/gpt-5.4-nano", provider: "openai" };
const saved = {
  modelId: "openai/gpt-5",
  source: "local" as const,
  connectionRef: { kind: "localProvider" as const, providerKey: "openai" },
  nativeModelId: "gpt-5",
  settings: { reasoningEffort: "low" as const, temperature: 0.4 },
  fallback: { provider: "none" as const, model: "none" as const },
};

describe("ranTurnSelection", () => {
  it("records the routing selection with the effort the turn applied", () => {
    expect(
      ranTurnSelection({
        selection: saved,
        model: { id: "gpt-5", provider: "openai", hosted: false },
        reasoningEffort: "high",
      }),
    ).toEqual({
      ...saved,
      settings: { temperature: 0.4, reasoningEffort: "high" },
    });
  });

  it("drops the requested effort when the turn applied none", () => {
    const result = ranTurnSelection({
      selection: { ...saved, settings: { reasoningEffort: "low" } },
      model: { id: "gpt-5", provider: "openai", hosted: false },
      reasoningEffort: undefined,
    });
    expect(result).not.toHaveProperty("settings");
  });

  it("builds a hosted selection for a hosted model with no saved selection", () => {
    expect(
      ranTurnSelection({
        selection: undefined,
        model: hostedRow,
        reasoningEffort: "high",
      }),
    ).toMatchObject({
      modelId: "openai/gpt-5.4-nano",
      source: "hosted",
      settings: { reasoningEffort: "high" },
    });
  });

  it("records nothing for an own-key model with no saved selection", () => {
    expect(
      ranTurnSelection({
        selection: undefined,
        model: { id: "gpt-5", provider: "openai", hosted: false },
        reasoningEffort: "high",
      }),
    ).toBeUndefined();
  });

  it("sends a stored legacy selection as-is (it carries no settings)", () => {
    const legacy = { source: "legacy" as const, modelId: "grok-3" };
    expect(
      ranTurnSelection({
        selection: legacy,
        model: { id: "grok-3", hosted: false },
        reasoningEffort: "high",
      }),
    ).toBe(legacy);
  });
});
