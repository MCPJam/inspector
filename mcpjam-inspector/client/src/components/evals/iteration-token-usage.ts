import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { EvalIteration } from "./types";

export type IterationTokenBreakdown = {
  inputTokens: number;
  outputTokens: number;
};

function aggregateLlmTokenTotals(spans: EvalTraceSpan[]): IterationTokenBreakdown | null {
  const llm = spans.filter((s) => s.category === "llm");
  let inputSum = 0;
  let inputN = 0;
  let outputSum = 0;
  let outputN = 0;
  for (const s of llm) {
    if (typeof s.inputTokens === "number") {
      inputSum += s.inputTokens;
      inputN++;
    }
    if (typeof s.outputTokens === "number") {
      outputSum += s.outputTokens;
      outputN++;
    }
  }
  if (!inputN && !outputN) return null;
  return {
    inputTokens: inputN ? inputSum : 0,
    outputTokens: outputN ? outputSum : 0,
  };
}

function readMetadataNumber(
  metadata: EvalIteration["metadata"],
  key: string,
): number | null {
  if (!metadata) return null;
  const value = metadata[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function reconcileWithTotalTokens(
  inputTokens: number,
  outputTokens: number,
  tokensUsed: number,
): IterationTokenBreakdown {
  const sum = inputTokens + outputTokens;
  if (tokensUsed <= 0 || tokensUsed <= sum) {
    return { inputTokens, outputTokens };
  }
  if (inputTokens === 0 && outputTokens > 0) {
    return { inputTokens: tokensUsed - outputTokens, outputTokens };
  }
  if (outputTokens === 0 && inputTokens > 0) {
    return { inputTokens, outputTokens: tokensUsed - inputTokens };
  }
  return { inputTokens, outputTokens };
}

/** True when input/output were persisted or traced, not inferred from total-only legacy rows. */
export function hasRecordedTokenBreakdown(iteration: EvalIteration): boolean {
  const metaInput = readMetadataNumber(iteration.metadata, "inputTokens");
  const metaOutput = readMetadataNumber(iteration.metadata, "outputTokens");
  if (metaInput !== null && metaOutput !== null) return true;

  const spans = (iteration as EvalIteration & { spans?: EvalTraceSpan[] }).spans;
  if (spans?.length && aggregateLlmTokenTotals(spans)) return true;

  return false;
}

/** Per-iteration input/output tokens when recorded on metadata, spans, or legacy total only. */
export function readIterationTokenBreakdown(
  iteration: EvalIteration,
): IterationTokenBreakdown | null {
  const tokensUsed =
    typeof iteration.tokensUsed === "number" && Number.isFinite(iteration.tokensUsed)
      ? iteration.tokensUsed
      : 0;

  const metaInput = readMetadataNumber(iteration.metadata, "inputTokens");
  const metaOutput = readMetadataNumber(iteration.metadata, "outputTokens");
  if (metaInput !== null || metaOutput !== null) {
    return reconcileWithTotalTokens(
      metaInput ?? 0,
      metaOutput ?? 0,
      tokensUsed,
    );
  }

  const spans = (iteration as EvalIteration & { spans?: EvalTraceSpan[] }).spans;
  if (spans?.length) {
    const fromSpans = aggregateLlmTokenTotals(spans);
    if (fromSpans) {
      return reconcileWithTotalTokens(
        fromSpans.inputTokens,
        fromSpans.outputTokens,
        tokensUsed,
      );
    }
  }

  if (iteration.result !== "pending" && tokensUsed > 0) {
    return { inputTokens: 0, outputTokens: tokensUsed };
  }

  return null;
}
