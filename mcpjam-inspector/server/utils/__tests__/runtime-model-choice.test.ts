import { describe, expect, it } from "vitest";
import { readRuntimeModelChoice } from "../runtime-model-choice.js";
import {
  resolveChatSelection,
  streamSelectionFields,
} from "../selection-rail.js";
import { resolveExecutionContext } from "../host-execution-context.js";

const selection = {
  source: "hosted" as const,
  modelId: "openai/gpt-5",
  fallback: { provider: "none" as const, model: "none" as const },
};
const config = {
  modelId: selection.modelId,
  modelSelectionLabel: { selection, origin: "backfill" },
};
describe("runtime choice transport", () => {
  it("retains paired origin from configuration through every stream step", () => {
    const runtime = resolveExecutionContext({
      hostConfig: config,
      precedence: "host-wins",
    });
    const choice = resolveChatSelection({
      raw: undefined,
      inherited: runtime.routingSelection,
      inheritedOrigin: runtime.modelSelectionOrigin,
      model: { id: selection.modelId },
      hostWins: true,
      allowLocal: false,
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) throw new Error(choice.error);
    expect(
      streamSelectionFields(
        choice.selection,
        { id: selection.modelId },
        "/stream",
        choice.origin,
      ),
    ).toMatchObject({
      modelSelection: selection,
      modelSelectionOrigin: "backfill",
    });
  });
  it("clears inherited origin on a picker override", () => {
    const choice = resolveChatSelection({
      raw: selection,
      inherited: selection,
      inheritedOrigin: "backfill",
      model: { id: selection.modelId },
      hostWins: false,
      allowLocal: false,
    });
    expect(choice).toMatchObject({ ok: true, requestSelection: selection });
    expect(choice).not.toHaveProperty("origin");
  });
  it("refuses stale and malformed envelopes instead of running bare", () => {
    expect(() =>
      readRuntimeModelChoice({ ...config, modelId: "openai/gpt-4.1" }),
    ).toThrow();
    expect(() =>
      readRuntimeModelChoice({
        ...config,
        modelSelectionLabel: { selection, origin: "platform" },
      }),
    ).toThrow();
    expect(() =>
      readRuntimeModelChoice({
        ...config,
        modelSelectionLabel: { selection: {} },
      }),
    ).toThrow();
  });
});
