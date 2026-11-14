import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_NATIVE_MODEL_IDS,
  validateModelSelection,
} from "@mcpjam/sdk/browser";
import { HOSTED_MODEL_IDS } from "../hosted-model-ids.generated";
import { SUPPORTED_MODELS } from "../types";
import {
  canonicalModelIdForNative,
  canonicalPrefix,
} from "../canonical-model-id";

/**
 * Built-in models whose canonical id the hosted catalog doesn't list, so it
 * comes from the provider's vendor prefix. Reviewed: each provider's API
 * takes these ids verbatim (`createLlmModel` in server/utils/chat-helpers.ts)
 * and the catalog spells the vendor this way. A new entry here is a spelling
 * to check: if the provider names the model differently from the catalog (as
 * Anthropic's dashed ids do), add a reviewed exception instead.
 */
const OFF_CATALOG = [
  "openai/gpt-5.1",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "google/gemini-2.0-flash-exp",
  "mistralai/mistral-large-latest",
  "mistralai/mistral-small-latest",
  "mistralai/codestral-latest",
  "mistralai/ministral-8b-latest",
  "mistralai/ministral-3b-latest",
  "x-ai/grok-3",
  "x-ai/grok-3-mini",
  "x-ai/grok-4-fast-non-reasoning",
  "x-ai/grok-4-fast-reasoning",
];

const builtIn = SUPPORTED_MODELS.filter((m) => !String(m.id).includes("/"));

describe("canonicalModelIdForNative", () => {
  it("prefers a reviewed exception, then the catalog, then the prefix", () => {
    expect(canonicalModelIdForNative("anthropic", "claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(
      canonicalModelIdForNative("anthropic", "claude-sonnet-4-5-20250929"),
    ).toBe("anthropic/claude-sonnet-4.5");
    expect(canonicalModelIdForNative("xai", "grok-4.5")).toBe(
      "spacexai/grok-4.5",
    );
    expect(canonicalModelIdForNative("xai", "grok-3")).toBe("x-ai/grok-3");
    expect(canonicalModelIdForNative("openai", " gpt-5.1 ")).toBe(
      "openai/gpt-5.1",
    );
    expect(
      canonicalModelIdForNative(
        "bedrock",
        "anthropic.claude-sonnet-4-5-20250929-v1:0",
      ),
    ).toBe("bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  it("refuses a blank id or a provider that can't be a prefix", () => {
    expect(canonicalModelIdForNative("openai", " ")).toBeNull();
    expect(canonicalModelIdForNative("Not A Provider", "x")).toBeNull();
    expect(canonicalPrefix("toString")).toBe("toString");
  });

  it("names every Anthropic exception's catalog id", () => {
    for (const row of ANTHROPIC_NATIVE_MODEL_IDS) {
      expect(canonicalModelIdForNative("anthropic", row.nativeId)).toBe(
        row.canonicalId,
      );
    }
  });

  it("derives a canonical id a saved org selection accepts for every built-in model", () => {
    for (const model of builtIn) {
      const modelId = canonicalModelIdForNative(
        String(model.provider),
        String(model.id),
      );
      const result = validateModelSelection({
        modelId,
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_1" },
        nativeModelId: String(model.id),
        fallback: { provider: "none", model: "none" },
      });
      expect(result.ok, `${String(model.provider)} ${String(model.id)}`).toBe(
        true,
      );
    }
  });

  it("lists every built-in model the catalog doesn't spell", () => {
    // Fails when a new built-in model falls back to the vendor prefix, and
    // when the weekly catalog refresh adds, drops or respells one of these.
    // Check the spelling, then update OFF_CATALOG (or add a reviewed
    // exception); don't skip the test.
    const catalog = new Set<string>(HOSTED_MODEL_IDS);
    const offCatalog = builtIn
      .map((m) => canonicalModelIdForNative(String(m.provider), String(m.id)))
      .filter((id): id is string => !!id && !catalog.has(id));
    expect(
      offCatalog.sort(),
      "Built-in models whose canonical id the catalog doesn't list changed; review the spelling and update OFF_CATALOG",
    ).toEqual([...OFF_CATALOG].sort());
  });
});
