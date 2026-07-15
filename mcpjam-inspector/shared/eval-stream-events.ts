import type { EvalTraceBlobV1 } from "./eval-trace";
import type { TestStepKind } from "./steps";

export type EvalStreamToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

/**
 * Lifecycle status for one authored step (or, at turn granularity, the
 * implicit turn that an authored step expands into). Drives the live "ticking"
 * of the left-pane step cards during a quick run.
 *
 * v1 is keyed by `turnIndex` + `kind` (turn granularity): a `prompt`/`toolCall`
 * step maps 1:1 to a turn, while `interact`/`assert` steps fold into a turn's
 * widget checks (`stepsToPromptTurns`) and report at turn resolution. `stepId`
 * is optional now and becomes the primary key once authored-step identity is
 * threaded through the conversion (per-card ticking) — adding it later is not a
 * breaking change.
 */
// `skipped` (PR6/PR5): a step the fail-fast engine never ran because an earlier
// `assert`/`interact` failed. The step card greys out rather than ticking ok/fail.
export type EvalStepStatus = "running" | "ok" | "fail" | "skipped";

export type EvalStreamEvent =
  | { type: "turn_start"; turnIndex: number; prompt: string }
  | { type: "text_delta"; content: string }
  | {
      type: "tool_call";
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      result: unknown;
      isError?: boolean;
    }
  | {
      type: "step_finish";
      stepNumber: number;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      type: "trace_snapshot";
      turnIndex: number;
      stepIndex?: number;
      snapshotKind: "step_finish" | "turn_finish" | "failure";
      trace: EvalTraceBlobV1;
      actualToolCalls: EvalStreamToolCall[];
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }
  | { type: "turn_finish"; turnIndex: number }
  | {
      type: "step_status";
      turnIndex: number;
      stepId?: string;
      kind: TestStepKind;
      status: EvalStepStatus;
      detail?: string;
    }
  | { type: "complete"; iterationId?: string; iteration: unknown }
  | { type: "error"; message: string; details?: string };
