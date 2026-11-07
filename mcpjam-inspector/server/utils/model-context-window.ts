import type { ModelMessage } from "ai";
import {
  CONTEXT_COMPACTION_PART,
  estimateModelTokens,
  fitMessagesToModelContext,
  type ContextCompactionReport,
} from "@/shared/model-context-budget";
import { getModelById } from "@/shared/types";
import { hostedCatalogContextLength } from "../services/hosted-model-catalog.js";
import { logger } from "./logger";

function validWindow(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * The model's context window for budgeting a step: the caller's own value,
 * else the hosted catalog's, else the built-in model list's. Unknown when none
 * has a usable number.
 */
export function resolveModelContextTokens(
  modelId: string,
  explicit?: number,
  provider?: string,
): number | undefined {
  return (
    validWindow(explicit) ??
    validWindow(hostedCatalogContextLength(modelId, provider)) ??
    validWindow(getModelById(modelId)?.contextLength)
  );
}

function serializedSize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Bound one model step's messages (see `fitMessagesToModelContext`). A failure
 * here sends the messages unchanged, as before PLB-300, so a bug cannot break
 * a turn that would have worked.
 */
export function fitStepForModel(args: {
  messages: ModelMessage[];
  modelId: string;
  provider?: string;
  contextTokens?: number;
  systemPrompt?: string;
  /**
   * Every tool the turn can use, not one step's advertised subset: a count
   * that moves between steps would move the cleared set mid-turn.
   */
  tools?: unknown;
  dropEarlierReasoning?: boolean;
}): { messages: ModelMessage[]; report?: ContextCompactionReport } {
  try {
    return fitMessagesToModelContext(args.messages, {
      contextTokens: resolveModelContextTokens(
        args.modelId,
        args.contextTokens,
        args.provider,
      ),
      fixedTokens:
        estimateModelTokens(args.systemPrompt ?? "") +
        estimateModelTokens(serializedSize(args.tools)),
      dropEarlierReasoning: args.dropEarlierReasoning,
    });
  } catch (error) {
    logger.warn("[context-budget] fit failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { messages: args.messages };
  }
}

/** The chat's one compaction part per turn; later steps replace its data. */
export function contextCompactionChunk(
  turnId: string,
  report: ContextCompactionReport,
) {
  return {
    type: CONTEXT_COMPACTION_PART,
    id: `context-compaction-${turnId}`,
    data: report,
  } as const;
}
