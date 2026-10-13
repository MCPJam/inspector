import { describe, expect, it } from "vitest";
import { comparisonKey } from "@mcpjam/sdk/browser";
import {
  mergePickedRows,
  resolveCompareSelectionRow,
  type CompareCard,
} from "@/lib/compare-cards";
import type { ModelDefinition } from "@/shared/types";

const fallback = { provider: "none", model: "none" } as const;
const gpt5: ModelDefinition = {
  id: "openai/gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: true,
} as ModelDefinition;
const haiku: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
} as ModelDefinition;
const gpt5Selection = {
  modelId: "openai/gpt-5",
  source: "hosted" as const,
  fallback,
};
const lateOrgCard = {
  modelId: "anthropic/claude-sonnet-4.5",
  source: "org" as const,
  connectionRef: { kind: "orgProvider" as const, id: "orgprov_late" },
  fallback,
};
const card = (model: ModelDefinition, selection: typeof gpt5Selection) =>
  ({
    key: comparisonKey(selection),
    model,
    selection,
    editableSelection: selection,
  }) as unknown as CompareCard;

describe("resolveCompareSelectionRow", () => {
  const orgGrok: ModelDefinition = {
    id: "grok-3",
    name: "Grok 3 (org)",
    provider: "xai",
    hosted: false,
  } as ModelDefinition;
  const localGrok: ModelDefinition = {
    id: "grok-3",
    name: "Grok 3 (local)",
    provider: "xai",
    hosted: false,
  } as ModelDefinition;
  const legacy = {
    source: "legacy" as const,
    modelId: "grok-3",
    provider: "xai",
  };

  it("resolves a stored legacy card to its one own-key row", () => {
    expect(resolveCompareSelectionRow(legacy, [gpt5, orgGrok], undefined)).toBe(
      orgGrok,
    );
  });

  it("drops a stored legacy card whose provider and id sit on two own-key rows", () => {
    // The legacy fields cannot say which connection ran it; the saved entry
    // survives in mergePickedRows, the card just does not render.
    expect(
      resolveCompareSelectionRow(legacy, [orgGrok, localGrok], undefined),
    ).toBeUndefined();
  });
});

describe("mergePickedRows", () => {
  it("keeps a saved card whose row has not loaded yet", () => {
    const next = mergePickedRows(
      [card(gpt5, gpt5Selection)],
      [gpt5, haiku],
      undefined,
      [gpt5Selection, lateOrgCard],
    );
    expect(next.map((entry) => entry.modelId)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-4.5",
    ]);
  });

  it("drops a resolved card the user unpicked", () => {
    const next = mergePickedRows(
      [card(gpt5, gpt5Selection)],
      [haiku],
      undefined,
      [gpt5Selection],
    );
    expect(next.map((entry) => entry.modelId)).toEqual([
      "anthropic/claude-haiku-4.5",
    ]);
  });
});
