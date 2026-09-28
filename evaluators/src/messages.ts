import { buildIterationTranscript } from "./predicates/transcript.js";
import type {
  IterationTranscript,
  TranscriptCaptureState,
  TranscriptToolCall,
  TranscriptToolResult,
} from "./predicates/types.js";
import type {
  EvaluatorContextV1,
  EvaluatorResult,
} from "./contract/evaluator-types.js";
import type { Evaluator, EvaluatorRunOptions } from "./evaluators/types.js";
import { runEvaluatorsProjected } from "./evaluators/run.js";

export type MessageCapture = {
  toolCalls: TranscriptCaptureState;
  toolResults: TranscriptCaptureState;
  text: TranscriptCaptureState;
};
export type NormalizedMessages =
  | {
      status: "recognized";
      transcript: IterationTranscript;
      capture: MessageCapture;
      diagnostics: string[];
    }
  | { status: "unsupported" | "invalid"; diagnostics: string[] };
export type NormalizeMessagesOptions = {
  /** The producer, not the presence of a message array, establishes complete capture. */
  capture?: Partial<MessageCapture>;
  maxMessages?: number;
  maxBytes?: number;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Normalize generic message/tool parts. No unrecognized input becomes empty evidence. */
export function normalizeMessages(
  input: unknown,
  options: NormalizeMessagesOptions = {},
): NormalizedMessages {
  const messages = Array.isArray(input)
    ? input
    : record(input)
      ? input.messages
      : undefined;
  if (!Array.isArray(messages))
    return {
      status: "unsupported",
      diagnostics: [
        "Expected a message array or an object containing messages",
      ],
    };
  const maxMessages = options.maxMessages ?? 1000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxMessages) ||
    maxMessages < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    return { status: "invalid", diagnostics: ["Invalid normalization limits"] };
  if (messages.length > maxMessages)
    return {
      status: "invalid",
      diagnostics: ["Message count exceeds the normalization limit"],
    };
  try {
    if (new TextEncoder().encode(JSON.stringify(messages)).length > maxBytes)
      return {
        status: "invalid",
        diagnostics: ["Messages exceed the normalization byte limit"],
      };
  } catch {
    return {
      status: "invalid",
      diagnostics: ["Messages are not JSON serializable"],
    };
  }
  const calls: TranscriptToolCall[] = [];
  const results: TranscriptToolResult[] = [];
  const canonical: Array<{ role: string; content: unknown }> = [];
  const callNames = new Map<string, string>();
  for (const raw of messages) {
    if (
      !record(raw) ||
      typeof raw.role !== "string" ||
      !["system", "user", "assistant", "tool"].includes(raw.role)
    )
      return {
        status: "unsupported",
        diagnostics: ["Unsupported message role or shape"],
      };
    const parts: unknown[] =
      typeof raw.content === "string"
        ? [{ type: "text", text: raw.content }]
        : Array.isArray(raw.content)
          ? raw.content
          : raw.content === null && Array.isArray(raw.tool_calls)
            ? []
            : [];
    if (
      raw.content !== undefined &&
      raw.content !== null &&
      typeof raw.content !== "string" &&
      !Array.isArray(raw.content)
    )
      return {
        status: "unsupported",
        diagnostics: ["Unsupported message content"],
      };
    const normalizedParts: unknown[] = [];
    for (const part of [
      ...parts,
      ...(Array.isArray(raw.tool_calls) ? raw.tool_calls : []),
    ]) {
      if (!record(part))
        return { status: "invalid", diagnostics: ["Malformed message part"] };
      if (part.type === "text" && typeof part.text === "string") {
        normalizedParts.push(part);
        continue;
      }
      if (
        part.type === "tool-call" ||
        part.type === "tool_use" ||
        part.type === "function"
      ) {
        const fn = record(part.function) ? part.function : part;
        const toolName = part.toolName ?? fn.name;
        const callId = part.toolCallId ?? part.id;
        let args = part.input ?? part.args ?? fn.arguments ?? {};
        try {
          if (typeof args === "string") args = JSON.parse(args);
        } catch {
          return {
            status: "invalid",
            diagnostics: ["Malformed tool arguments"],
          };
        }
        if (typeof toolName !== "string" || !toolName || !record(args))
          return { status: "invalid", diagnostics: ["Malformed tool call"] };
        calls.push({ toolName, arguments: args });
        if (typeof callId === "string") callNames.set(callId, toolName);
        normalizedParts.push({
          type: "tool-call",
          toolName,
          toolCallId: callId,
          input: args,
        });
        continue;
      }
      if (part.type === "tool-result" || part.type === "tool_result") {
        const callId = part.toolCallId ?? part.tool_use_id;
        const toolName =
          part.toolName ??
          (typeof callId === "string" ? callNames.get(callId) : undefined);
        if (typeof toolName !== "string")
          return {
            status: "invalid",
            diagnostics: ["Tool result has no resolvable call identity"],
          };
        const output = part.output ?? part.result ?? part.content;
        results.push({
          toolName,
          toolCallId: typeof callId === "string" ? callId : undefined,
          text: typeof output === "string" ? output : JSON.stringify(output),
          size: {
            bytes: new TextEncoder().encode(JSON.stringify(output) ?? "")
              .length,
            basis: "model_visible_output",
            complete: output !== undefined,
          },
        });
        normalizedParts.push({
          type: "tool-result",
          toolName,
          toolCallId: callId,
          output:
            part.is_error === true
              ? {
                  isError: true,
                  content: [{ type: "text", text: String(output) }],
                }
              : output,
        });
        continue;
      }
      return {
        status: "unsupported",
        diagnostics: [
          "Unsupported message part; capture completeness cannot be established",
        ],
      };
    }
    if (raw.role === "tool" && typeof raw.tool_call_id === "string") {
      const toolName = callNames.get(raw.tool_call_id);
      if (!toolName)
        return {
          status: "invalid",
          diagnostics: ["Tool result has no matching call"],
        };
      results.push({
        toolName,
        toolCallId: raw.tool_call_id,
        text:
          typeof raw.content === "string"
            ? raw.content
            : JSON.stringify(raw.content),
        size: {
          bytes: new TextEncoder().encode(JSON.stringify(raw.content) ?? "")
            .length,
          basis: "model_visible_output",
          complete: raw.content !== undefined,
        },
      });
      normalizedParts.splice(0, normalizedParts.length, {
        type: "tool-result",
        toolName,
        toolCallId: raw.tool_call_id,
        output: raw.content,
      });
    }
    canonical.push({ role: raw.role, content: normalizedParts });
  }
  const capture: MessageCapture = {
    toolCalls: options.capture?.toolCalls ?? "absent",
    toolResults: options.capture?.toolResults ?? "absent",
    text: options.capture?.text ?? "complete",
  };
  if (
    Object.values(capture).some(
      (value) => !["complete", "partial", "absent"].includes(value),
    )
  )
    return { status: "invalid", diagnostics: ["Invalid capture state"] };
  const transcript = buildIterationTranscript({
    toolCalls: calls,
    trace: canonical,
    toolResults: results,
    resultsCaptured: capture.toolResults === "complete",
  });
  transcript.capture!.toolResults = capture.toolResults;
  return {
    status: "recognized",
    transcript,
    capture,
    diagnostics:
      capture.toolCalls === "complete" && capture.toolResults === "complete"
        ? []
        : ["Tool evidence completeness was not established"],
  };
}

/** Evaluate normalized evidence without treating absent tool capture as observed absence. */
export function runMessageEvaluators(
  evaluators: readonly Evaluator[],
  normalized: NormalizedMessages,
  context: Omit<EvaluatorContextV1, "transcript">,
  options?: EvaluatorRunOptions,
): Promise<EvaluatorResult[]> {
  const guarded = evaluators.map((evaluator) => ({
    ...evaluator,
    evaluate: (ctx: EvaluatorContextV1, signal?: AbortSignal) => {
      const rule = (evaluator as { rule?: { type: string } }).rule;
      const needsTools =
        !rule ||
        ![
          "responseCloseTo",
          "responseContains",
          "responseMatches",
          "responseNotContains",
          "noEndingQuestion",
          "turnCountUnder",
          "tokenBudgetUnder",
          "latencyUnder",
        ].includes(rule.type);
      if (
        normalized.status !== "recognized" ||
        (needsTools &&
          (normalized.capture.toolCalls !== "complete" ||
            normalized.capture.toolResults !== "complete"))
      )
        throw new Error(
          "Required message/tool evidence is unsupported or incomplete",
        );
      return evaluator.evaluate(ctx, signal);
    },
  }));
  return runEvaluatorsProjected(
    guarded,
    {
      ...context,
      transcript:
        normalized.status === "recognized"
          ? normalized.transcript
          : { toolCalls: [] },
    },
    options,
  );
}
