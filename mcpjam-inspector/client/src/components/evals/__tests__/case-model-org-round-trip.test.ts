import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import {
  buildAvailableModelsFromOrgConfig,
  type OrgVisibleConfig,
} from "@/components/chat-v2/shared/model-helpers";
import {
  caseModelEntry,
  caseModelEntryValue,
} from "@/components/chat-v2/shared/model-selection";
import {
  buildHistoricalCompareRunRecords,
  caseModelEntriesForCompareValues,
  caseModelEntriesUnchanged,
  parseModelValue,
  resolveInitialCompareModelValues,
  type CompareCaseModelEntry,
} from "../compare-playground-helpers";
import {
  buildTestCaseModelOptions,
  resolveSelectedTestCaseModelValue,
} from "../single-test-case-runner";
import type { EvalIteration } from "../types";

// A member of an organization that requires its own keys picks the offered
// OpenAI model for a case. That row's id is bare (`gpt-5`), so the case must
// be saved with the canonical id and the org connection, read back as the
// same picker row, and run as that saved entry. Saved as the bare pair, the
// launch reads a legacy id and the policy refuses it.

const hostedGpt5: ModelDefinition = {
  id: "openai/gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: true,
};

const strictOrgConfig: OrgVisibleConfig = {
  providers: [
    {
      id: "orgprov_openai_1",
      providerKey: "openai",
      enabled: true,
      hasSecret: true,
      runtimeLocation: "cloud",
      policyEligibility: { eligible: true },
    },
  ],
  aiKeyPolicy: { requireOrgKeys: true, revision: 2 },
};

function strictOrgModels(): {
  models: ModelDefinition[];
  row: ModelDefinition;
  value: string;
} {
  const models = buildAvailableModelsFromOrgConfig(strictOrgConfig, [
    hostedGpt5,
  ]);
  const row = models.find(
    (model) => model.provider === "openai" && String(model.id) === "gpt-5",
  );
  if (!row) throw new Error("the org OpenAI connection offers no gpt-5 row");
  return { models, row, value: `${row.provider}/${String(row.id)}` };
}

/** What the backend's read DTO returns for the stored entry. */
function reloaded(entry: CompareCaseModelEntry) {
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.selection ? { selection: entry.selection } : {}),
  };
}

describe("an organization model picked for a case under the policy", () => {
  it("is offered as the org row, not MCPJam's", () => {
    const { models, row } = strictOrgModels();
    expect(row.orgProvider).toEqual({
      providerKey: "openai",
      id: "orgprov_openai_1",
    });
    expect(models.some((model) => model.hosted === true)).toBe(false);
  });

  it("saves the canonical id with the org connection", () => {
    const { models, value } = strictOrgModels();
    const { provider, model } = parseModelValue(value);

    const entry = caseModelEntry({ provider, model }, models, true, {
      orgCanonicalIds: true,
    });

    expect(entry).toEqual({
      provider: "openai",
      model: "openai/gpt-5",
      selection: {
        modelId: "openai/gpt-5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_openai_1" },
        nativeModelId: "gpt-5",
        fallback: { provider: "none", model: "none" },
      },
    });
    // The backend refuses an entry whose model disagrees with its selection.
    expect(entry.model).toBe(entry.selection?.modelId);
  });

  it("round-trips through save, reload, re-save and run", () => {
    const { models, value } = strictOrgModels();
    const entryValue = (entry: CompareCaseModelEntry) =>
      caseModelEntryValue(entry, models);
    const build = (modelValue: string) => {
      const { provider, model } = parseModelValue(modelValue);
      return caseModelEntry({ provider, model }, models, true, {
        orgCanonicalIds: true,
      });
    };

    // Save: the editor's first save of the pick.
    const saved = caseModelEntriesForCompareValues(
      [value],
      [],
      build,
      entryValue,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]?.selection?.source).toBe("org");

    // Reload: the saved entry reads back as the same picker row, with no
    // extra "saved model" option beside it.
    const testCase = { models: saved.map(reloaded) };
    expect(entryValue(testCase.models[0]!)).toBe(value);
    const modelOptions = buildTestCaseModelOptions(models, testCase);
    expect(modelOptions.map((option) => option.value)).not.toContain(
      "openai/openai/gpt-5",
    );
    const preferred = resolveSelectedTestCaseModelValue({
      testCaseId: null,
      testCase,
      modelOptions,
      entryValue,
    });
    expect(preferred).toBe(value);
    expect(
      resolveInitialCompareModelValues({
        testCase,
        modelOptions,
        preferredModelValue: preferred,
        entryValue,
      }),
    ).toEqual([value]);

    // Re-save with the same pick: the saved entry is kept, nothing changes.
    const resaved = caseModelEntriesForCompareValues(
      [value],
      testCase.models,
      build,
      entryValue,
    );
    expect(resaved).toEqual(testCase.models);
    expect(caseModelEntriesUnchanged(testCase.models, resaved)).toBe(true);

    // Run: the request names the saved entry's own model and provider, which
    // is what the server matches to find the entry and its org selection.
    const runEntry = resaved[0]!;
    expect(parseModelValue(`${runEntry.provider}/${runEntry.model}`)).toEqual({
      provider: "openai",
      model: "openai/gpt-5",
    });

    // History: an iteration of that run shows in the pick's column.
    const iteration = {
      _id: "iter-1",
      createdBy: "user",
      createdAt: 1,
      updatedAt: 101,
      startedAt: 1,
      iterationNumber: 1,
      status: "completed",
      result: "passed",
      resultSource: "reported",
      actualToolCalls: [],
      tokensUsed: 10,
      metadata: { compareRunId: "compare-1" },
      testCaseSnapshot: {
        title: "t",
        query: "q",
        provider: "openai",
        model: "openai/gpt-5",
        selection: runEntry.selection,
        expectedToolCalls: [],
      },
    } as unknown as EvalIteration;
    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: [value],
      modelLabelByValue: { [value]: "GPT-5" },
      iterations: [iteration],
      testCase,
      entryValue,
    });
    expect(Object.keys(records)).toEqual([value]);
  });

  it("keeps the bare pair with the policy off", () => {
    const models = buildAvailableModelsFromOrgConfig(
      { providers: strictOrgConfig.providers },
      [hostedGpt5],
    );
    expect(
      caseModelEntry({ provider: "openai", model: "gpt-5" }, models),
    ).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("reads every other entry as provider/model, as before", () => {
    const { models } = strictOrgModels();
    expect(
      caseModelEntryValue({ provider: "openai", model: "gpt-5" }, models),
    ).toBe("openai/gpt-5");
    expect(
      caseModelEntryValue(
        {
          provider: "anthropic",
          model: "anthropic/claude-haiku-4.5",
          selection: {
            modelId: "anthropic/claude-haiku-4.5",
            source: "hosted",
            fallback: { provider: "none", model: "none" },
          },
        },
        models,
      ),
    ).toBe("anthropic/anthropic/claude-haiku-4.5");
  });
});
