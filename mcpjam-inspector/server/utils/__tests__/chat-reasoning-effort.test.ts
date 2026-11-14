import { describe, expect, it } from "vitest";
import {
  directChatEffort,
  hostSelectionForTurn,
  parseChatReasoningEffort,
  resolveChatReasoningEffort,
  withoutCustomProviderEffort,
} from "../chat-reasoning-effort";

const HOST_SELECTION = {
  modelId: "openai/gpt-5",
  source: "hosted",
  settings: { reasoningEffort: "medium" },
  fallback: { provider: "openrouter", model: "none" },
} as never;

describe("parseChatReasoningEffort", () => {
  it("reads a known level, treats absent/null as none, rejects anything else", () => {
    expect(parseChatReasoningEffort("high")).toEqual({
      ok: true,
      effort: "high",
    });
    expect(parseChatReasoningEffort(undefined)).toEqual({ ok: true });
    expect(parseChatReasoningEffort(null)).toEqual({ ok: true });
    for (const bad of ["ultra", "", 3, {}]) {
      const result = parseChatReasoningEffort(bad);
      expect(result.ok).toBe(false);
    }
  });
});

describe("resolveChatReasoningEffort", () => {
  it("the body's effort wins over the host's, which is the default", () => {
    expect(
      resolveChatReasoningEffort({
        bodyEffort: "low",
        hostSelection: HOST_SELECTION,
        hostWins: false,
      }),
    ).toBe("low");
    expect(
      resolveChatReasoningEffort({
        hostSelection: HOST_SELECTION,
        hostWins: false,
      }),
    ).toBe("medium");
    expect(resolveChatReasoningEffort({ hostWins: false })).toBeUndefined();
  });

  it("a host-wins turn ignores the body's effort", () => {
    expect(
      resolveChatReasoningEffort({
        bodyEffort: "low",
        hostSelection: HOST_SELECTION,
        hostWins: true,
      }),
    ).toBe("medium");
    expect(
      resolveChatReasoningEffort({ bodyEffort: "low", hostWins: true }),
    ).toBeUndefined();
  });
});

describe("hostSelectionForTurn", () => {
  it("only applies to the model the selection names", () => {
    expect(hostSelectionForTurn(HOST_SELECTION, "openai/gpt-5")).toBe(
      HOST_SELECTION,
    );
    expect(
      hostSelectionForTurn(HOST_SELECTION, "openai/gpt-5-mini"),
    ).toBeUndefined();
    expect(hostSelectionForTurn(undefined, "openai/gpt-5")).toBeUndefined();
  });
});

describe("directChatEffort", () => {
  it("no effort is a no-op", () => {
    expect(
      directChatEffort({ providerKey: "openai", modelId: "gpt-5.1" }),
    ).toEqual({ ok: true });
  });

  it("maps a supported provider to provider options", () => {
    expect(
      directChatEffort({
        providerKey: "openai",
        modelId: "gpt-5.1",
        effort: "high",
      }),
    ).toEqual({
      ok: true,
      providerOptions: { openai: { reasoningEffort: "high" } },
    });
  });

  it("refuses a provider or level it cannot apply", () => {
    const unknown = directChatEffort({
      providerKey: "ollama",
      modelId: "llama3",
      effort: "high",
    });
    expect(unknown).toMatchObject({ ok: false });
    const level = directChatEffort({
      providerKey: "openai",
      modelId: "gpt-5",
      effort: "xhigh",
    });
    expect(level).toMatchObject({ ok: false });
  });

  it("an explicit temperature with an effort stays refused", () => {
    const result = directChatEffort({
      providerKey: "openai",
      modelId: "gpt-5.1",
      effort: "high",
      explicitTemperature: 0.7,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("cannot both be applied");
  });
});


describe("explicit selection effort authority", () => {
  const selected = { modelId: "openai/gpt-5", source: "org", connectionRef: { kind: "orgProvider", id: "conn-1" }, fallback: { provider: "none", model: "none" } } as const;
  it("does not restore host effort after an explicit clear", () => {
    expect(resolveChatReasoningEffort({ hostSelection: HOST_SELECTION, requestSelection: selected, hostWins: false })).toBeUndefined();
  });
  it("uses selected effort, then a top-level override; scenarios retain host authority", () => {
    const requestSelection = { ...selected, settings: { reasoningEffort: "high" as const } };
    expect(resolveChatReasoningEffort({ hostSelection: HOST_SELECTION, requestSelection, hostWins: false })).toBe("high");
    expect(resolveChatReasoningEffort({ hostSelection: HOST_SELECTION, requestSelection, bodyEffort: "low", hostWins: false })).toBe("low");
    expect(resolveChatReasoningEffort({ hostSelection: HOST_SELECTION, requestSelection, bodyEffort: "low", hostWins: true })).toBe("medium");
  });
});

describe("withoutCustomProviderEffort", () => {
  const customSelection = {
    modelId: "custom:gateway:gpt-x",
    source: "org",
    connectionRef: { kind: "orgProvider", id: "conn-custom" },
    settings: { reasoningEffort: "high", temperature: 0.3 },
    fallback: { provider: "none", model: "none" },
  } as const;
  const customModel = { provider: "custom" } as const;

  it("drops the request's effort and the selection's saved one, keeping other settings", () => {
    const result = withoutCustomProviderEffort({
      modelDefinition: customModel,
      reasoningEffort: "low",
      routingSelection: customSelection,
    });
    expect(result.omitted).toBe("low");
    expect(result.prepare.reasoningEffort).toBeUndefined();
    expect(result.prepare.routingSelection).toEqual({
      ...customSelection,
      settings: { temperature: 0.3 },
    });
  });

  it("drops an effort that only the saved selection carries", () => {
    const result = withoutCustomProviderEffort({
      modelDefinition: customModel,
      routingSelection: {
        ...customSelection,
        settings: { reasoningEffort: "medium" },
      },
    });
    expect(result.omitted).toBe("medium");
    expect(result.prepare.routingSelection).not.toHaveProperty("settings");
  });

  it("leaves every other provider, and a custom turn with no effort, as it was", () => {
    const openai = {
      modelDefinition: { provider: "openai" } as const,
      reasoningEffort: "high" as const,
    };
    expect(withoutCustomProviderEffort(openai)).toEqual({ prepare: openai });
    const noEffort = { modelDefinition: customModel };
    expect(withoutCustomProviderEffort(noEffort)).toEqual({
      prepare: noEffort,
    });
  });
});
