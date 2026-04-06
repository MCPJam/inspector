import { describe, expect, it } from "vitest";
import {
  buildHistoricalCompareRunRecords,
  buildCompareRunRecord,
  mergeAdvancedConfigWithOverride,
  resolveIterationModelValue,
  resolveInitialCompareModelValues,
} from "../compare-playground-helpers";

describe("compare-playground-helpers", () => {
  it("prefers case models and dedupes the initial compare selection", () => {
    const selection = resolveInitialCompareModelValues({
      testCase: {
        models: [
          { provider: "openai", model: "gpt-5" },
          { provider: "anthropic", model: "claude-4.5-sonnet" },
          { provider: "openai", model: "gpt-5" },
        ],
      } as any,
      modelOptions: [
        { value: "openai/gpt-5" },
        { value: "anthropic/claude-4.5-sonnet" },
        { value: "google/gemini-2.5-pro" },
      ],
      preferredModelValue: "google/gemini-2.5-pro",
    });

    expect(selection).toEqual([
      "openai/gpt-5",
      "anthropic/claude-4.5-sonnet",
      "google/gemini-2.5-pro",
    ]);
  });

  it("merges shared config with per-model overrides", () => {
    const merged = mergeAdvancedConfigWithOverride({
      baseAdvancedConfig: {
        system: "Base system",
        temperature: 0.3,
      },
      override: {
        systemPrompt: "Focused override",
        temperature: "0.7",
        providerFlagsJson: '{"reasoningEffort":"high"}',
      },
    });

    expect(merged).toEqual({
      system: "Focused override",
      temperature: 0.7,
      reasoningEffort: "high",
    });
  });

  it("computes mismatch counts for a compare run record", () => {
    const record = buildCompareRunRecord({
      modelValue: "openai/gpt-5",
      modelLabel: "GPT-5",
      iteration: {
        status: "completed",
        result: "failed",
        resultSource: "derived",
        actualToolCalls: [
          {
            toolName: "get_incident",
            arguments: { incident_id: "123" },
          },
        ],
        tokensUsed: 1200,
        createdBy: "user",
        createdAt: 100,
        updatedAt: 900,
        startedAt: 200,
        iterationNumber: 1,
        _id: "iter-1",
        testCaseSnapshot: {
          title: "Incident test",
          query: "Find my incident",
          provider: "openai",
          model: "gpt-5",
          expectedToolCalls: [
            {
              toolName: "list_incidents",
              arguments: { assignee: "me" },
            },
          ],
        },
      } as any,
    });

    expect(record.result).toBe("failed");
    expect(record.metrics.toolCallCount).toBe(1);
    expect(record.metrics.missingCount).toBe(1);
    expect(record.metrics.unexpectedCount).toBe(1);
    expect(record.metrics.argumentMismatchCount).toBe(0);
    expect(record.metrics.mismatchCount).toBe(2);
  });

  it("uses persisted prompt-aware mismatch totals for multi-turn iterations", () => {
    const record = buildCompareRunRecord({
      modelValue: "openai/gpt-5",
      modelLabel: "GPT-5",
      iteration: {
        status: "completed",
        result: "failed",
        resultSource: "derived",
        actualToolCalls: [],
        metadata: {
          missingCount: 2,
          unexpectedCount: 1,
          argumentMismatchCount: 3,
          mismatchCount: 6,
        },
        tokensUsed: 100,
        createdBy: "user",
        createdAt: 1,
        updatedAt: 2,
        startedAt: 1,
        iterationNumber: 1,
        _id: "iter-mt",
        testCaseSnapshot: {
          title: "Multi",
          query: "Q1",
          provider: "openai",
          model: "gpt-5",
          expectedToolCalls: [{ toolName: "only_first_turn", arguments: {} }],
          promptTurns: [
            { id: "a", prompt: "A", expectedToolCalls: [] },
            { id: "b", prompt: "B", expectedToolCalls: [{ toolName: "b", arguments: {} }] },
          ],
        },
      } as any,
    });

    expect(record.metrics.missingCount).toBe(2);
    expect(record.metrics.unexpectedCount).toBe(1);
    expect(record.metrics.argumentMismatchCount).toBe(3);
    expect(record.metrics.mismatchCount).toBe(6);
  });

  it("sets mismatch counters to null for legacy multi-turn iterations without metadata", () => {
    const record = buildCompareRunRecord({
      modelValue: "openai/gpt-5",
      modelLabel: "GPT-5",
      iteration: {
        status: "completed",
        result: "passed",
        resultSource: "reported",
        actualToolCalls: [{ toolName: "x", arguments: {} }],
        tokensUsed: 50,
        createdBy: "user",
        createdAt: 1,
        updatedAt: 2,
        startedAt: 1,
        iterationNumber: 1,
        _id: "iter-legacy-mt",
        testCaseSnapshot: {
          title: "Legacy MT",
          query: "Q",
          provider: "openai",
          model: "gpt-5",
          expectedToolCalls: [],
          promptTurns: [
            { id: "a", prompt: "A", expectedToolCalls: [] },
            { id: "b", prompt: "B", expectedToolCalls: [{ toolName: "b", arguments: {} }] },
          ],
        },
      } as any,
    });

    expect(record.metrics.toolCallCount).toBe(1);
    expect(record.metrics.missingCount).toBeNull();
    expect(record.metrics.unexpectedCount).toBeNull();
    expect(record.metrics.argumentMismatchCount).toBeNull();
    expect(record.metrics.mismatchCount).toBeNull();
  });

  it("resolves an iteration model value from the snapshot", () => {
    expect(
      resolveIterationModelValue({
        testCaseSnapshot: {
          provider: "anthropic",
          model: "anthropic/claude-haiku-4.5",
        },
      } as any),
    ).toBe("anthropic/anthropic/claude-haiku-4.5");
  });

  it("hydrates historical compare records from the latest iteration per model", () => {
    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: [
        "openai/gpt-5-nano",
        "anthropic/anthropic/claude-haiku-4.5",
      ],
      modelLabelByValue: {
        "openai/gpt-5-nano": "GPT-5 Nano",
        "anthropic/anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
      },
      iterations: [
        {
          _id: "iter-old",
          createdBy: "user",
          createdAt: 100,
          updatedAt: 200,
          startedAt: 100,
          iterationNumber: 1,
          status: "completed",
          result: "passed",
          resultSource: "reported",
          actualToolCalls: [],
          tokensUsed: 10,
          testCaseSnapshot: {
            title: "Flowchart",
            query: "Draw a flowchart",
            provider: "openai",
            model: "gpt-5-nano",
            expectedToolCalls: [],
          },
        },
        {
          _id: "iter-new",
          createdBy: "user",
          createdAt: 300,
          updatedAt: 400,
          startedAt: 300,
          iterationNumber: 2,
          status: "completed",
          result: "failed",
          resultSource: "reported",
          actualToolCalls: [],
          tokensUsed: 20,
          testCaseSnapshot: {
            title: "Flowchart",
            query: "Draw a flowchart",
            provider: "openai",
            model: "gpt-5-nano",
            expectedToolCalls: [],
          },
        },
        {
          _id: "iter-claude",
          createdBy: "user",
          createdAt: 250,
          updatedAt: 350,
          startedAt: 250,
          iterationNumber: 1,
          status: "completed",
          result: "passed",
          resultSource: "reported",
          actualToolCalls: [],
          tokensUsed: 15,
          testCaseSnapshot: {
            title: "Flowchart",
            query: "Draw a flowchart",
            provider: "anthropic",
            model: "anthropic/claude-haiku-4.5",
            expectedToolCalls: [],
          },
        },
      ] as any,
    });

    expect(records["openai/gpt-5-nano"]?.iteration?._id).toBe("iter-new");
    expect(records["anthropic/anthropic/claude-haiku-4.5"]?.iteration?._id).toBe(
      "iter-claude",
    );
  });
});
