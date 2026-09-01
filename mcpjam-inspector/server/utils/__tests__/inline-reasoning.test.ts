import { describe, expect, it } from "vitest";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

import {
  withInlineReasoningExtracted,
  withOrgInlineReasoningExtracted,
} from "../inline-reasoning";
import {
  THINK_DELTAS,
  collectStreamParts,
  reasoningOf,
  textOf,
  thinkStreamModel,
} from "./helpers/think-model";

describe("withInlineReasoningExtracted", () => {
  it("moves a <think> block off the text channel", async () => {
    const parts = await collectStreamParts(
      withInlineReasoningExtracted(thinkStreamModel(THINK_DELTAS)),
    );

    expect(reasoningOf(parts)).toContain("2 plus 2.");
    expect(textOf(parts)).toBe("It is 4.");
  });

  it("leaves a response with no think block untouched", async () => {
    const parts = await collectStreamParts(
      withInlineReasoningExtracted(thinkStreamModel(["It is ", "4."])),
    );

    expect(textOf(parts)).toBe("It is 4.");
    expect(parts.some((p) => p.type === "reasoning-delta")).toBe(false);
  });
});

/**
 * Org models arrive as the AI SDK `LanguageModel` union, so the org entry point
 * has to cope with the two members that cannot carry middleware.
 */
describe("withOrgInlineReasoningExtracted", () => {
  it("extracts a <think> block from a v3 model", async () => {
    const wrapped = withOrgInlineReasoningExtracted(
      thinkStreamModel(THINK_DELTAS),
    );
    const parts = await collectStreamParts(wrapped as LanguageModelV3);

    expect(reasoningOf(parts)).toContain("2 plus 2.");
    expect(textOf(parts)).toBe("It is 4.");
  });

  it("hands back a bare model-id string untouched", () => {
    expect(withOrgInlineReasoningExtracted("openai/gpt-4o")).toBe(
      "openai/gpt-4o",
    );
  });

  it("hands back a legacy v2 model untouched", () => {
    // v2 has no `reasoning-delta` part to move the text onto, and
    // `wrapLanguageModel` only accepts v3 — passing it through is the honest
    // outcome, not a silent mis-wrap.
    const v2 = { specificationVersion: "v2" } as unknown as LanguageModel;
    expect(withOrgInlineReasoningExtracted(v2)).toBe(v2);
  });
});
