import { describe, expect, it } from "vitest";
import {
  directChatEffort,
  hostSelectionForTurn,
  parseChatReasoningEffort,
  resolveChatReasoningEffort,
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
