import type { EvalTraceBlobV1 } from "./eval-trace";

export type EvalStreamToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

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
  | { type: "complete"; iterationId?: string; iteration: unknown }
  | { type: "error"; message: string; details?: string };
