import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import { findModelForStoredChoice } from "@/components/chat-v2/shared/model-selection";
import {
  carryEffortToModel,
  environmentsForModelCell,
  selectionReasoningEffort,
  setEffortForRow,
  withReasoningEffort,
} from "../reasoning-effort-selection";

const fallback = { provider: "none", model: "none" } as const;
const hostedSel = (
  settings?: ModelSelection["settings"],
): ModelSelection => ({
  modelId: "openai/gpt-5",
  source: "hosted",
  fallback,
  ...(settings ? { settings } : {}),
});
const gpt5 = {
  id: "openai/gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: true,
  supportedReasoningEfforts: ["low", "high"],
} as ModelDefinition;
const gpt4o = {
  id: "openai/gpt-4o",
  name: "GPT-4o",
  provider: "openai",
  hosted: true,
} as ModelDefinition;
const byokGpt5 = {
  id: "gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: false,
} as ModelDefinition;

describe("withReasoningEffort", () => {
  it("sets, replaces and clears the effort while keeping other settings", () => {
    const set = withReasoningEffort(hostedSel({ temperature: 0.2 }), "high");
    expect(set.settings).toEqual({ temperature: 0.2, reasoningEffort: "high" });
    expect(selectionReasoningEffort(set)).toBe("high");
    expect(withReasoningEffort(set, "low").settings?.reasoningEffort).toBe(
      "low",
    );
    expect(withReasoningEffort(set, undefined).settings).toEqual({
      temperature: 0.2,
    });
  });

  it("drops an emptied settings object", () => {
    const cleared = withReasoningEffort(
      hostedSel({ reasoningEffort: "high" }),
      undefined,
    );
    expect("settings" in cleared).toBe(false);
  });
});

describe("carryEffortToModel", () => {
  const base = { purpose: "evalTarget", selectionsSupported: true } as const;

  it("keeps a supported effort on the new model", () => {
    const out = carryEffortToModel({
      ...base,
      row: gpt5,
      previousEffort: "high",
    });
    expect(out.kept).toBe("high");
    expect(out.selection?.settings?.reasoningEffort).toBe("high");
  });

  it("drops and reports an effort the new model does not list", () => {
    const out = carryEffortToModel({
      ...base,
      row: gpt4o,
      previousEffort: "high",
    });
    expect(out.dropped).toBe("high");
    expect(out.selection?.settings).toBeUndefined();
    expect(out.modelId).toBe("openai/gpt-4o");
  });

  it("drops it where the deployment stores no selections", () => {
    const out = carryEffortToModel({
      ...base,
      selectionsSupported: false,
      row: gpt5,
      previousEffort: "high",
    });
    expect(out).toMatchObject({
      modelId: "openai/gpt-5",
      selection: undefined,
      dropped: "high",
    });
  });

  it("stores a bare-id BYOK row under its canonical id when an effort is kept", () => {
    const out = carryEffortToModel({
      ...base,
      row: byokGpt5,
      previousEffort: "medium",
    });
    expect(out.kept).toBe("medium");
    expect(out.modelId).toBe("openai/gpt-5");
    expect(out.selection?.source).toBe("local");
    expect(out.selection?.nativeModelId).toBe("gpt-5");
  });
});

describe("setEffortForRow", () => {
  const args = { purpose: "evalTarget", row: byokGpt5 } as const;

  it("canonicalizes a bare-id row only when asked to", () => {
    const set = setEffortForRow({
      ...args,
      selection: undefined,
      effort: "high",
      bareIds: "canonicalize",
    });
    expect(set?.modelId).toBe("openai/gpt-5");
    expect(set?.selection?.settings?.reasoningEffort).toBe("high");
    expect(
      setEffortForRow({ ...args, selection: undefined, effort: "high" }),
    ).toBeNull();
  });

  it("a canonicalized bare BYOK row reads back as itself, never the hosted twin (Playground host switch)", () => {
    const set = setEffortForRow({
      ...args,
      selection: undefined,
      effort: "high",
      bareIds: "canonicalize",
    })!;
    const choice = { modelId: set.modelId, selection: set.selection };
    // What the Playground resolves: hosted `openai/gpt-5` sits beside the bare
    // BYOK `gpt-5`. A raw-id match would pick the hosted row and bill MCPJam.
    const rows = [gpt5, byokGpt5];
    expect(findModelForStoredChoice(choice, rows, undefined)).toBe(byokGpt5);
    expect(rows.find((m) => String(m.id) === set.modelId)).toBe(gpt5);
  });

  it("returns a synthesised bare-id row to its legacy shape when cleared", () => {
    expect(
      setEffortForRow({
        ...args,
        selection: undefined,
        effort: undefined,
        bareIds: "canonicalize",
      }),
    ).toEqual({ modelId: "gpt-5", selection: undefined });
  });

  it("edits the existing selection of a hosted row in place", () => {
    const out = setEffortForRow({
      purpose: "evalTarget",
      row: gpt5,
      selection: hostedSel(),
      effort: "low",
    });
    expect(out?.modelId).toBe("openai/gpt-5");
    expect(out?.selection?.settings?.reasoningEffort).toBe("low");
  });
});

describe("environmentsForModelCell", () => {
  const org = (settings?: ModelSelection["settings"]): ModelSelection => ({
    modelId: "openai/gpt-5",
    source: "org",
    connectionRef: { kind: "orgProvider", id: "org-key-1" },
    fallback,
    ...(settings ? { settings } : {}),
  });
  const env = (hostId: string, modelSelection?: ModelSelection) => ({
    hostId,
    modelId: "openai/gpt-5",
    modelSelection,
  });

  it("matches by comparisonKey: each effort of a model is its own cell", () => {
    const high = env("h1", hostedSel({ reasoningEffort: "high" }));
    const low = env("h1", hostedSel({ reasoningEffort: "low" }));
    const plain = env("h1", hostedSel());
    const cell = (picked?: ModelSelection) =>
      environmentsForModelCell([high, low, plain], {
        hostId: "h1",
        modelId: "openai/gpt-5",
        picked,
        efforts: true,
      });
    expect(cell(hostedSel({ reasoningEffort: "high" }))).toEqual([high]);
    expect(cell(hostedSel({ reasoningEffort: "low" }))).toEqual([low]);
    expect(cell(hostedSel())).toEqual([plain]);
    // An unlabelled pick keys as the bare id, like a plain hosted selection.
    expect(cell(undefined)).toEqual([plain]);
  });

  it("an unlabelled environment matches a plain pick of its id, as before", () => {
    const bare = env("h1");
    expect(
      environmentsForModelCell([bare], {
        hostId: "h1",
        modelId: "openai/gpt-5",
        picked: hostedSel(),
        efforts: true,
      }),
    ).toEqual([bare]);
  });

  it("matches on id alone where the deployment stores no selections", () => {
    const high = env("h1", hostedSel({ reasoningEffort: "high" }));
    const low = env("h1", hostedSel({ reasoningEffort: "low" }));
    expect(
      environmentsForModelCell([high, low], {
        hostId: "h1",
        modelId: "openai/gpt-5",
        picked: undefined,
        efforts: false,
      }),
    ).toEqual([high, low]);
  });

  it("does not count an environment on a different connection as a sibling", () => {
    const hosted = env("h1", hostedSel({ reasoningEffort: "high" }));
    const byok = env("h1", org());
    const out = environmentsForModelCell([hosted, byok], {
      hostId: "h1",
      modelId: "openai/gpt-5",
      picked: org({ reasoningEffort: "high" }),
      efforts: true,
    });
    // The org pick's effort (high) is only run by the HOSTED environment, which
    // is not the same selection identity, so nothing is reused.
    expect(out).toEqual([]);
  });

  it("returns none when no sibling of the same identity runs the picked effort", () => {
    const plain = env("h1", hostedSel());
    expect(
      environmentsForModelCell([plain], {
        hostId: "h1",
        modelId: "openai/gpt-5",
        picked: hostedSel({ reasoningEffort: "high" }),
        efforts: true,
      }),
    ).toEqual([]);
  });
});
