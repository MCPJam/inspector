import {
  getModelById,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
import { matchToolCalls } from "@/shared/eval-matching";
import { computeIterationResult } from "./pass-criteria";
import type {
  CompareModelOverride,
  CompareRunRecord,
  EvalCase,
  EvalIteration,
} from "./types";

const KNOWN_MODEL_PROVIDERS: ModelProvider[] = [
  "anthropic",
  "azure",
  "openai",
  "ollama",
  "deepseek",
  "google",
  "meta",
  "xai",
  "mistral",
  "moonshotai",
  "openrouter",
  "z-ai",
  "minimax",
  "custom",
];

function normalizeModelProvider(provider?: string): ModelProvider {
  return KNOWN_MODEL_PROVIDERS.includes(provider as ModelProvider)
    ? (provider as ModelProvider)
    : "custom";
}

export function createCompareSessionId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `cmp_${crypto.randomUUID()}`;
  }

  return `cmp_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function parseModelValue(modelValue: string) {
  const [provider, ...modelParts] = modelValue.split("/");
  return {
    provider,
    model: modelParts.join("/"),
  };
}

export function resolveModelOptionLabel(
  modelValue: string,
  modelLabelByValue: Record<string, string>,
) {
  return modelLabelByValue[modelValue] ?? modelValue;
}

const MISMATCH_METADATA_KEYS = [
  "missingCount",
  "unexpectedCount",
  "argumentMismatchCount",
  "mismatchCount",
] as const;

function readMetadataString(
  metadata: EvalIteration["metadata"],
  key: string,
): string | null {
  if (!metadata) {
    return null;
  }
  const value = metadata[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getIterationSortTime(iteration: EvalIteration): number {
  return iteration.startedAt ?? iteration.updatedAt ?? iteration.createdAt ?? 0;
}

function compareIterationsByNewest(a: EvalIteration, b: EvalIteration): number {
  return getIterationSortTime(b) - getIterationSortTime(a);
}

function isQuickRunIteration(
  iteration: Pick<EvalIteration, "suiteRunId">,
): boolean {
  return !iteration.suiteRunId;
}

function areCompareRecordMetricsEqual(
  left: CompareRunRecord["metrics"],
  right: CompareRunRecord["metrics"],
): boolean {
  return (
    left.durationMs === right.durationMs &&
    left.toolCallCount === right.toolCallCount &&
    left.tokensUsed === right.tokensUsed &&
    left.missingCount === right.missingCount &&
    left.unexpectedCount === right.unexpectedCount &&
    left.argumentMismatchCount === right.argumentMismatchCount &&
    left.mismatchCount === right.mismatchCount
  );
}

function areCompareRunRecordsEquivalent(
  existingRecords: Record<string, CompareRunRecord>,
  nextRecords: Record<string, CompareRunRecord>,
): boolean {
  const existingKeys = Object.keys(existingRecords);
  const nextKeys = Object.keys(nextRecords);

  if (existingKeys.length !== nextKeys.length) {
    return false;
  }

  for (const key of nextKeys) {
    const existing = existingRecords[key];
    const next = nextRecords[key];

    if (!existing || !next) {
      return false;
    }

    if (existing === next) {
      continue;
    }

    if (
      existing.modelValue !== next.modelValue ||
      existing.modelLabel !== next.modelLabel ||
      existing.provider !== next.provider ||
      existing.model !== next.model ||
      existing.status !== next.status ||
      existing.error !== next.error ||
      existing.startedAt !== next.startedAt ||
      existing.completedAt !== next.completedAt ||
      existing.result !== next.result ||
      existing.iteration?._id !== next.iteration?._id ||
      !areCompareRecordMetricsEqual(existing.metrics, next.metrics)
    ) {
      return false;
    }
  }

  return true;
}

export function resolveLatestCompareRunId(
  iterations: EvalIteration[],
): string | null {
  const latestTaggedQuickRun = [...iterations]
    .filter(isQuickRunIteration)
    .sort(compareIterationsByNewest)
    .find((iteration) =>
      readMetadataString(iteration.metadata, "compareRunId"),
    );

  return latestTaggedQuickRun
    ? readMetadataString(latestTaggedQuickRun.metadata, "compareRunId")
    : null;
}

function readFiniteMetadataNumber(
  metadata: EvalIteration["metadata"],
  key: (typeof MISMATCH_METADATA_KEYS)[number],
): number | null {
  if (!metadata) {
    return null;
  }
  const value = metadata[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/** Full server-side prompt-aware aggregate counts; all four keys required. */
function parsePersistedMismatchCounts(metadata: EvalIteration["metadata"]): {
  missingCount: number;
  unexpectedCount: number;
  argumentMismatchCount: number;
  mismatchCount: number;
} | null {
  const missingCount = readFiniteMetadataNumber(metadata, "missingCount");
  const unexpectedCount = readFiniteMetadataNumber(metadata, "unexpectedCount");
  const argumentMismatchCount = readFiniteMetadataNumber(
    metadata,
    "argumentMismatchCount",
  );
  const mismatchCount = readFiniteMetadataNumber(metadata, "mismatchCount");

  if (
    missingCount === null ||
    unexpectedCount === null ||
    argumentMismatchCount === null ||
    mismatchCount === null
  ) {
    return null;
  }

  return {
    missingCount,
    unexpectedCount,
    argumentMismatchCount,
    mismatchCount,
  };
}

function isMultiTurnTestCaseSnapshot(
  snapshot: EvalIteration["testCaseSnapshot"] | undefined,
): boolean {
  const turns = snapshot?.promptTurns;
  return Array.isArray(turns) && turns.length > 1;
}

export function resolveInitialCompareModelValues(params: {
  testCase: Pick<EvalCase, "models"> | null | undefined;
  modelOptions: Array<{ value: string }>;
  preferredModelValue?: string | null;
  maxModels?: number;
}) {
  const { testCase, modelOptions, preferredModelValue, maxModels = 3 } = params;
  const optionValues = new Set(modelOptions.map((option) => option.value));
  const values: string[] = [];

  const pushValue = (candidate: string | null | undefined) => {
    if (!candidate || values.includes(candidate)) return;
    if (!optionValues.has(candidate)) return;
    values.push(candidate);
  };

  for (const model of testCase?.models ?? []) {
    pushValue(`${model.provider}/${model.model}`);
  }

  pushValue(preferredModelValue);

  // Only auto-pick extra compare slots when the case does not already list models.
  // Otherwise we would pad to `maxModels` from the catalog and fight the user's
  // single-model (or N-model) configuration — e.g. Results showing prior compare columns.
  if (values.length === 0) {
    for (const option of modelOptions) {
      pushValue(option.value);
    }
  }

  return values.slice(0, maxModels);
}

export function resolveIterationModelValue(
  iteration: Pick<EvalIteration, "testCaseSnapshot">,
  testCase?: Pick<EvalCase, "models"> | null,
) {
  const provider =
    iteration.testCaseSnapshot?.provider ?? testCase?.models?.[0]?.provider;
  const model =
    iteration.testCaseSnapshot?.model ?? testCase?.models?.[0]?.model;

  if (!provider || !model) {
    return null;
  }

  return `${provider}/${model}`;
}

export function buildHistoricalCompareRunRecords(params: {
  selectedModelValues: string[];
  modelLabelByValue: Record<string, string>;
  iterations: EvalIteration[];
  testCase?: Pick<EvalCase, "models"> | null;
  existingRecords?: Record<string, CompareRunRecord>;
  preferredIteration?: EvalIteration | null;
}) {
  const {
    selectedModelValues,
    modelLabelByValue,
    iterations,
    testCase,
    existingRecords = {},
    preferredIteration = null,
  } = params;

  if (selectedModelValues.length === 0) {
    return existingRecords;
  }

  const selectedSet = new Set(selectedModelValues);
  const hadKeysNotInSelection = Object.keys(existingRecords).some(
    (key) => !selectedSet.has(key),
  );
  const preserveCompletedIterations = preferredIteration == null;

  // Keep only rows for the current compare selection; drop stale model keys.
  const nextRecords: Record<string, CompareRunRecord> = {};
  for (const modelValue of selectedModelValues) {
    const existing = existingRecords[modelValue];
    if (existing && (preserveCompletedIterations || !existing.iteration)) {
      nextRecords[modelValue] = existing;
    }
  }

  if (iterations.length === 0) {
    return hadKeysNotInSelection ? nextRecords : existingRecords;
  }

  const latestIterationByModel = new Map<string, EvalIteration>();
  const sortedIterations = [...iterations].sort(compareIterationsByNewest);
  const quickRunIterations = sortedIterations.filter(isQuickRunIteration);
  const latestCompareRunId = resolveLatestCompareRunId(sortedIterations);
  const preferredCompareRunId = preferredIteration
    ? readMetadataString(preferredIteration.metadata, "compareRunId")
    : null;
  const preferredSourceIterations = preferredIteration
    ? preferredCompareRunId && isQuickRunIteration(preferredIteration)
      ? quickRunIterations.filter(
          (iteration) =>
            readMetadataString(iteration.metadata, "compareRunId") ===
            preferredCompareRunId,
        )
      : preferredIteration.suiteRunId
        ? sortedIterations.filter(
            (iteration) => iteration.suiteRunId === preferredIteration.suiteRunId,
          )
        : []
    : [];
  const sourceIterations = preferredIteration
    ? preferredSourceIterations.length > 0
      ? preferredSourceIterations
      : [
          preferredIteration,
          ...quickRunIterations.filter(
            (iteration) => iteration._id !== preferredIteration._id,
          ),
        ]
    : latestCompareRunId != null
      ? quickRunIterations.filter(
          (iteration) =>
            readMetadataString(iteration.metadata, "compareRunId") ===
            latestCompareRunId,
        )
      : quickRunIterations.length > 0
        ? quickRunIterations
        : sortedIterations;

  for (const iteration of sourceIterations) {
    const modelValue = resolveIterationModelValue(iteration, testCase);
    if (!modelValue || latestIterationByModel.has(modelValue)) {
      continue;
    }
    latestIterationByModel.set(modelValue, iteration);
  }

  let changed = false;

  for (const modelValue of selectedModelValues) {
    if (preserveCompletedIterations && nextRecords[modelValue]?.iteration) {
      continue;
    }

    // In-flight or user-stopped compare rows have no `iteration` yet; do not
    // backfill from `recentIterations` or we show the wrong run's trace/latency.
    if (
      nextRecords[modelValue]?.status === "running" ||
      nextRecords[modelValue]?.status === "cancelled"
    ) {
      continue;
    }

    const iteration = latestIterationByModel.get(modelValue);
    if (!iteration) {
      continue;
    }

    nextRecords[modelValue] = buildCompareRunRecord({
      modelValue,
      modelLabel: resolveModelOptionLabel(modelValue, modelLabelByValue),
      iteration,
    });
    changed = true;
  }

  return changed || hadKeysNotInSelection
    ? areCompareRunRecordsEquivalent(existingRecords, nextRecords)
      ? existingRecords
      : nextRecords
    : existingRecords;
}

export function mergeAdvancedConfigWithOverride(params: {
  baseAdvancedConfig?: Record<string, unknown>;
  override?: CompareModelOverride;
}) {
  const { baseAdvancedConfig, override } = params;
  const next = {
    ...(baseAdvancedConfig ?? {}),
  };

  if (override?.systemPrompt !== undefined) {
    const trimmedSystem = override.systemPrompt.trim();
    if (trimmedSystem) {
      next.system = trimmedSystem;
    } else {
      delete next.system;
    }
  }

  if (override?.temperature !== undefined) {
    const trimmedTemperature = override.temperature.trim();
    if (!trimmedTemperature) {
      delete next.temperature;
    } else {
      const parsedTemperature = Number(trimmedTemperature);
      if (!Number.isFinite(parsedTemperature)) {
        throw new Error("Temperature override must be a valid number");
      }
      next.temperature = parsedTemperature;
    }
  }

  if (override?.providerFlagsJson !== undefined) {
    const trimmedFlags = override.providerFlagsJson.trim();
    if (!trimmedFlags) {
      return Object.keys(next).length > 0 ? next : undefined;
    }

    let parsedFlags: unknown;
    try {
      parsedFlags = JSON.parse(trimmedFlags);
    } catch {
      throw new Error("Provider flags override must be valid JSON");
    }

    if (
      !parsedFlags ||
      typeof parsedFlags !== "object" ||
      Array.isArray(parsedFlags)
    ) {
      throw new Error("Provider flags override must be a JSON object");
    }

    Object.assign(next, parsedFlags);
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function buildCompareRunRecord(params: {
  modelValue: string;
  modelLabel: string;
  iteration: EvalIteration | null;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  /** User or host aborted the in-flight stream before an iteration completed. */
  cancelled?: boolean;
}): CompareRunRecord {
  const {
    modelValue,
    modelLabel,
    iteration,
    error = null,
    startedAt,
    completedAt,
    cancelled = false,
  } = params;
  const { provider, model } = parseModelValue(modelValue);

  if (!iteration) {
    if (cancelled) {
      const end = completedAt ?? Date.now();
      const start = startedAt ?? null;
      const durationMs = start != null ? Math.max(end - start, 0) : null;
      return {
        modelValue,
        modelLabel,
        provider,
        model,
        status: "cancelled",
        iteration: null,
        error: null,
        startedAt: start,
        completedAt: end,
        result: "cancelled",
        metrics: {
          durationMs,
          toolCallCount: 0,
          tokensUsed: 0,
          missingCount: null,
          unexpectedCount: null,
          argumentMismatchCount: null,
          mismatchCount: null,
        },
      };
    }
    return {
      modelValue,
      modelLabel,
      provider,
      model,
      status: error ? "failed" : "idle",
      iteration: null,
      error,
      startedAt: startedAt ?? null,
      completedAt: completedAt ?? null,
      result: error ? "failed" : null,
      metrics: {
        durationMs: null,
        toolCallCount: 0,
        tokensUsed: 0,
        missingCount: null,
        unexpectedCount: null,
        argumentMismatchCount: null,
        mismatchCount: null,
      },
    };
  }

  const expectedToolCalls = iteration.testCaseSnapshot?.expectedToolCalls ?? [];
  const actualToolCalls = iteration.actualToolCalls ?? [];
  const durationMs =
    iteration.startedAt && iteration.updatedAt
      ? Math.max(iteration.updatedAt - iteration.startedAt, 0)
      : null;
  const result = computeIterationResult(iteration);

  const persisted = parsePersistedMismatchCounts(iteration.metadata);
  let missingCount: number | null;
  let unexpectedCount: number | null;
  let argumentMismatchCount: number | null;
  let mismatchCount: number | null;

  if (persisted) {
    ({ missingCount, unexpectedCount, argumentMismatchCount, mismatchCount } =
      persisted);
  } else if (!isMultiTurnTestCaseSnapshot(iteration.testCaseSnapshot)) {
    const match = matchToolCalls(
      expectedToolCalls,
      actualToolCalls,
      iteration.testCaseSnapshot?.isNegativeTest,
    );
    missingCount = match.missing.length;
    unexpectedCount = match.unexpected.length;
    argumentMismatchCount = match.argumentMismatches.length;
    mismatchCount =
      match.missing.length +
      match.unexpected.length +
      match.argumentMismatches.length;
  } else {
    missingCount = null;
    unexpectedCount = null;
    argumentMismatchCount = null;
    mismatchCount = null;
  }

  return {
    modelValue,
    modelLabel,
    provider,
    model,
    status: result === "pending" ? "running" : "completed",
    iteration,
    error,
    startedAt: startedAt ?? iteration.startedAt ?? iteration.createdAt,
    completedAt: completedAt ?? iteration.updatedAt ?? null,
    result,
    metrics: {
      durationMs,
      toolCallCount: actualToolCalls.length,
      tokensUsed: iteration.tokensUsed ?? 0,
      missingCount,
      unexpectedCount,
      argumentMismatchCount,
      mismatchCount,
    },
  };
}

export function resolveTraceModel(
  iteration: EvalIteration,
  testCase: EvalCase | null,
): ModelDefinition {
  const snapshotProvider = iteration.testCaseSnapshot?.provider;
  const snapshotModel = iteration.testCaseSnapshot?.model;
  const fallbackProvider = testCase?.models[0]?.provider;
  const fallbackModel = testCase?.models[0]?.model;

  const provider = snapshotProvider || fallbackProvider || "openai";
  const model = snapshotModel || fallbackModel || "unknown-model";
  const providerModelId =
    model.startsWith(`${provider}/`) || !provider
      ? model
      : `${provider}/${model}`;

  return (
    getModelById(providerModelId) ??
    getModelById(model) ?? {
      id: providerModelId,
      name: model.includes("/") ? model.split("/").slice(1).join("/") : model,
      provider: normalizeModelProvider(provider),
    }
  );
}

export function extractFinalAssistantOutput(
  adaptedMessages: Array<{ role: string; parts?: any[] }>,
) {
  const assistantMessage = [...adaptedMessages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!assistantMessage?.parts?.length) {
    return { text: null, json: null as unknown };
  }

  const textParts = assistantMessage.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);

  if (textParts.length > 0) {
    return {
      text: textParts.join("\n\n"),
      json: null,
    };
  }

  const jsonPart = assistantMessage.parts.find((part) => part?.type === "data");
  return {
    text: null,
    json: jsonPart ?? assistantMessage.parts,
  };
}
