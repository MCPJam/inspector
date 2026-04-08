import { describe, expect, it } from "vitest";
import {
  buildHistoricalCompareRunRecords,
  buildCompareRunRecord,
  mergeAdvancedConfigWithOverride,
  resolveIterationModelValue,
  resolveInitialCompareModelValues,
  resolveLatestCompareRunId,
} from "../compare-playground-helpers";
import type { CompareRunRecord } from "../types";

describe("compare-playground-helpers", () => {
  const makeIteration = (params: {
    id: string;
    modelValue: string;
    createdAt: number;
    updatedAt?: number;
    suiteRunId?: string;
    compareRunId?: string;
    result?: "passed" | "failed";
  }) => {
    const [provider, ...modelParts] = params.modelValue.split("/");
    return {
      _id: params.id,
      createdBy: "user",
      createdAt: params.createdAt,
      updatedAt: params.updatedAt ?? params.createdAt + 100,
      startedAt: params.createdAt,
      iterationNumber: 1,
      status: "completed",
      result: params.result ?? "passed",
      resultSource: "reported",
      actualToolCalls: [],
      tokensUsed: 10,
      suiteRunId: params.suiteRunId,
      metadata: params.compareRunId
        ? { compareRunId: params.compareRunId }
        : undefined,
      testCaseSnapshot: {
        title: "Flowchart",
        query: "Draw a flowchart",
        provider,
        model: modelParts.join("/"),
        expectedToolCalls: [],
      },
    } as any;
  };

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

  it("does not pad the compare selection from the catalog when the case already lists models", () => {
    const selection = resolveInitialCompareModelValues({
      testCase: {
        models: [
          { provider: "anthropic", model: "anthropic/claude-haiku-4.5" },
        ],
      } as any,
      modelOptions: [
        { value: "anthropic/anthropic/claude-haiku-4.5" },
        { value: "openai/gpt-oss-120b" },
        { value: "openai/gpt-5-nano" },
      ],
      preferredModelValue: null,
    });

    expect(selection).toEqual(["anthropic/anthropic/claude-haiku-4.5"]);
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

  it("builds a cancelled compare run record with elapsed duration", () => {
    const record = buildCompareRunRecord({
      modelValue: "openai/gpt-5",
      modelLabel: "GPT-5",
      iteration: null,
      cancelled: true,
      startedAt: 1000,
      completedAt: 5000,
    });

    expect(record.status).toBe("cancelled");
    expect(record.result).toBe("cancelled");
    expect(record.metrics.durationMs).toBe(4000);
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

  it("keeps compare status running when the returned iteration is still server-marked running", () => {
    const record = buildCompareRunRecord({
      modelValue: "openai/gpt-oss-120b",
      modelLabel: "GPT-OSS 120B",
      iteration: {
        _id: "iter-running",
        testCaseId: "case-1",
        createdBy: "u1",
        createdAt: 100,
        updatedAt: 200,
        iterationNumber: 1,
        status: "running",
        result: "pending",
        resultSource: "derived",
        actualToolCalls: [],
        tokensUsed: 0,
        startedAt: 100,
        testCaseSnapshot: {
          title: "T",
          query: "Q",
          provider: "openai",
          model: "gpt-oss-120b",
          expectedToolCalls: [{ toolName: "example", arguments: {} }],
        },
        suiteRunId: "run-1",
      } as any,
    });

    expect(record.status).toBe("running");
    expect(record.iteration).not.toBeNull();
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
            {
              id: "b",
              prompt: "B",
              expectedToolCalls: [{ toolName: "b", arguments: {} }],
            },
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
            {
              id: "b",
              prompt: "B",
              expectedToolCalls: [{ toolName: "b", arguments: {} }],
            },
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
    expect(
      records["anthropic/anthropic/claude-haiku-4.5"]?.iteration?._id,
    ).toBe("iter-claude");
  });

  it("does not replace an in-flight compare run with historical iterations", () => {
    const running = buildCompareRunRecord({
      modelValue: "openai/gpt-5-nano",
      modelLabel: "GPT-5 Nano",
      iteration: null,
      startedAt: Date.now(),
    });
    const inFlight: CompareRunRecord = {
      ...running,
      status: "running",
    };

    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: ["openai/gpt-5-nano"],
      modelLabelByValue: { "openai/gpt-5-nano": "GPT-5 Nano" },
      iterations: [
        {
          _id: "iter-stale",
          createdBy: "user",
          createdAt: 100,
          updatedAt: 30_000,
          startedAt: 100,
          iterationNumber: 1,
          status: "completed",
          result: "passed",
          resultSource: "reported",
          actualToolCalls: [],
          tokensUsed: 999,
          testCaseSnapshot: {
            title: "T",
            query: "Q",
            provider: "openai",
            model: "gpt-5-nano",
            expectedToolCalls: [],
          },
        },
      ] as any,
      existingRecords: { "openai/gpt-5-nano": inFlight },
    });

    expect(records["openai/gpt-5-nano"]?.status).toBe("running");
    expect(records["openai/gpt-5-nano"]?.iteration).toBeNull();
    expect(records["openai/gpt-5-nano"]?.metrics.durationMs).toBeNull();
  });

  it("does not replace a user-stopped compare run with historical iterations", () => {
    const stopped = buildCompareRunRecord({
      modelValue: "openai/gpt-5-nano",
      modelLabel: "GPT-5 Nano",
      iteration: null,
      cancelled: true,
      startedAt: 1000,
      completedAt: 5000,
    });

    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: ["openai/gpt-5-nano"],
      modelLabelByValue: { "openai/gpt-5-nano": "GPT-5 Nano" },
      iterations: [
        {
          _id: "iter-stale",
          createdBy: "user",
          createdAt: 100,
          updatedAt: 30_000,
          startedAt: 100,
          iterationNumber: 1,
          status: "completed",
          result: "passed",
          resultSource: "reported",
          actualToolCalls: [],
          tokensUsed: 999,
          testCaseSnapshot: {
            title: "T",
            query: "Q",
            provider: "openai",
            model: "gpt-5-nano",
            expectedToolCalls: [],
          },
        },
      ] as any,
      existingRecords: { "openai/gpt-5-nano": stopped },
    });

    expect(records["openai/gpt-5-nano"]?.status).toBe("cancelled");
    expect(records["openai/gpt-5-nano"]?.iteration).toBeNull();
  });

  it("drops compare rows that are no longer selected", () => {
    const prior = buildCompareRunRecord({
      modelValue: "openai/gpt-5-nano",
      modelLabel: "GPT-5 Nano",
      iteration: {
        _id: "iter-nano",
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
          title: "T",
          query: "Q",
          provider: "openai",
          model: "gpt-5-nano",
          expectedToolCalls: [],
        },
      } as any,
    });

    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: ["anthropic/anthropic/claude-haiku-4.5"],
      modelLabelByValue: {
        "anthropic/anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
      },
      iterations: [],
      testCase: { models: [] } as any,
      existingRecords: {
        "openai/gpt-5-nano": prior,
      },
    });

    expect(records["openai/gpt-5-nano"]).toBeUndefined();
  });

  it("resolves the latest tagged compare session id from quick runs only", () => {
    expect(
      resolveLatestCompareRunId([
        makeIteration({
          id: "suite-newer",
          modelValue: "openai/gpt-5-nano",
          createdAt: 500,
          suiteRunId: "suite-1",
          compareRunId: "cmp_suite_should_ignore",
        }),
        makeIteration({
          id: "quick-untagged-newest",
          modelValue: "openai/gpt-5-nano",
          createdAt: 450,
        }),
        makeIteration({
          id: "quick-tagged",
          modelValue: "openai/gpt-5-nano",
          createdAt: 400,
          compareRunId: "cmp_latest",
        }),
      ] as any),
    ).toBe("cmp_latest");
  });

  it("hydrates from the latest tagged compare session and keeps the newest retry per model within that session", () => {
    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: [
        "openai/gpt-5-nano",
        "anthropic/anthropic/claude-haiku-4.5",
        "google/gemini-2.5-pro",
      ],
      modelLabelByValue: {
        "openai/gpt-5-nano": "GPT-5 Nano",
        "anthropic/anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
        "google/gemini-2.5-pro": "Gemini 2.5 Pro",
      },
      iterations: [
        makeIteration({
          id: "cmp-old-openai",
          modelValue: "openai/gpt-5-nano",
          createdAt: 100,
          compareRunId: "cmp_old",
        }),
        makeIteration({
          id: "cmp-current-openai-old",
          modelValue: "openai/gpt-5-nano",
          createdAt: 300,
          compareRunId: "cmp_current",
          result: "failed",
        }),
        makeIteration({
          id: "cmp-current-openai-retry",
          modelValue: "openai/gpt-5-nano",
          createdAt: 360,
          compareRunId: "cmp_current",
        }),
        makeIteration({
          id: "cmp-current-claude",
          modelValue: "anthropic/anthropic/claude-haiku-4.5",
          createdAt: 340,
          compareRunId: "cmp_current",
        }),
        makeIteration({
          id: "quick-untagged-newer",
          modelValue: "anthropic/anthropic/claude-haiku-4.5",
          createdAt: 420,
        }),
        makeIteration({
          id: "suite-newer",
          modelValue: "openai/gpt-5-nano",
          createdAt: 500,
          suiteRunId: "suite-1",
        }),
      ] as any,
    });

    expect(records["openai/gpt-5-nano"]?.iteration?._id).toBe(
      "cmp-current-openai-retry",
    );
    expect(
      records["anthropic/anthropic/claude-haiku-4.5"]?.iteration?._id,
    ).toBe("cmp-current-claude");
    expect(records["google/gemini-2.5-pro"]).toBeUndefined();
  });

  it("prefers the explicitly selected compare session over newer history", () => {
    const preferredIteration = makeIteration({
      id: "cmp-selected-openai",
      modelValue: "openai/gpt-5-nano",
      createdAt: 300,
      compareRunId: "cmp_selected",
    });

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
        makeIteration({
          id: "cmp-newer-openai",
          modelValue: "openai/gpt-5-nano",
          createdAt: 500,
          compareRunId: "cmp_newer",
          result: "failed",
        }),
        makeIteration({
          id: "cmp-newer-claude",
          modelValue: "anthropic/anthropic/claude-haiku-4.5",
          createdAt: 490,
          compareRunId: "cmp_newer",
        }),
        preferredIteration,
        makeIteration({
          id: "cmp-selected-claude",
          modelValue: "anthropic/anthropic/claude-haiku-4.5",
          createdAt: 280,
          compareRunId: "cmp_selected",
        }),
      ] as any,
      preferredIteration: preferredIteration as any,
    });

    expect(records["openai/gpt-5-nano"]?.iteration?._id).toBe(
      "cmp-selected-openai",
    );
    expect(
      records["anthropic/anthropic/claude-haiku-4.5"]?.iteration?._id,
    ).toBe("cmp-selected-claude");
  });

  it("prefers iterations from the explicitly selected suite run", () => {
    const preferredIteration = makeIteration({
      id: "suite-selected-openai",
      modelValue: "openai/gpt-5-nano",
      createdAt: 200,
      suiteRunId: "suite-selected",
    });

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
        makeIteration({
          id: "quick-newer-openai",
          modelValue: "openai/gpt-5-nano",
          createdAt: 500,
          compareRunId: "cmp_newer",
        }),
        preferredIteration,
        makeIteration({
          id: "suite-selected-claude",
          modelValue: "anthropic/anthropic/claude-haiku-4.5",
          createdAt: 190,
          suiteRunId: "suite-selected",
        }),
      ] as any,
      preferredIteration: preferredIteration as any,
    });

    expect(records["openai/gpt-5-nano"]?.iteration?._id).toBe(
      "suite-selected-openai",
    );
    expect(
      records["anthropic/anthropic/claude-haiku-4.5"]?.iteration?._id,
    ).toBe("suite-selected-claude");
  });

  it("pins the explicitly selected iteration even when it is outside the recent history window", () => {
    const preferredIteration = makeIteration({
      id: "iter-clicked",
      modelValue: "openai/gpt-5-nano",
      createdAt: 50,
      suiteRunId: "suite-clicked",
      result: "failed",
    });

    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: ["openai/gpt-5-nano"],
      modelLabelByValue: {
        "openai/gpt-5-nano": "GPT-5 Nano",
      },
      iterations: [
        makeIteration({
          id: "iter-newer",
          modelValue: "openai/gpt-5-nano",
          createdAt: 500,
          compareRunId: "cmp_newer",
        }),
      ] as any,
      preferredIteration: preferredIteration as any,
    });

    expect(records["openai/gpt-5-nano"]?.iteration?._id).toBe("iter-clicked");
  });

  it("falls back to the latest quick-run iteration per model when historical compare runs are untagged", () => {
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
        makeIteration({
          id: "quick-openai-old",
          modelValue: "openai/gpt-5-nano",
          createdAt: 100,
        }),
        makeIteration({
          id: "quick-openai-new",
          modelValue: "openai/gpt-5-nano",
          createdAt: 250,
        }),
        makeIteration({
          id: "quick-claude",
          modelValue: "anthropic/anthropic/claude-haiku-4.5",
          createdAt: 200,
        }),
        makeIteration({
          id: "suite-openai-newer",
          modelValue: "openai/gpt-5-nano",
          createdAt: 400,
          suiteRunId: "suite-1",
        }),
      ] as any,
    });

    expect(records["openai/gpt-5-nano"]?.iteration?._id).toBe(
      "quick-openai-new",
    );
    expect(
      records["anthropic/anthropic/claude-haiku-4.5"]?.iteration?._id,
    ).toBe("quick-claude");
  });

  it("falls back to generic historical iterations only when there are no quick runs", () => {
    const records = buildHistoricalCompareRunRecords({
      selectedModelValues: ["openai/gpt-5-nano"],
      modelLabelByValue: {
        "openai/gpt-5-nano": "GPT-5 Nano",
      },
      iterations: [
        makeIteration({
          id: "suite-only",
          modelValue: "openai/gpt-5-nano",
          createdAt: 300,
          suiteRunId: "suite-1",
        }),
      ] as any,
    });

    expect(records["openai/gpt-5-nano"]?.iteration?._id).toBe("suite-only");
  });
});
