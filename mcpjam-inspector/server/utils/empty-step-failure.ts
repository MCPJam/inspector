/**
 * Classifying a model step that produced nothing.
 *
 * Shared by both chat engines: the hosted engine (`mcpjam-stream-handler.ts`)
 * reads Convex's per-step stream itself, and the direct BYOK routes watch the
 * AI SDK's UI stream with {@link createEmptyTurnWatcher}. Both must reach the
 * same verdict and the same sentence for the same provider behaviour, or a
 * model swapped between MCPJam-hosted and BYOK changes how its failure reads.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { UIMessageChunk } from "ai";
import { normalizeFinishReason } from "@/shared/eval-trace";

/**
 * Did THIS prompt already land a tool call that actually came back with a
 * result?
 *
 * Scoped to the current prompt by `promptMessageStartIndex` — a tool call from
 * an earlier turn says nothing about whether this one acted, and the whole
 * point of the caller's check is "this turn already did the work". Reading the
 * MESSAGES rather than `traceTurn.turnSpans` is what makes that hold on a
 * RESUMED turn: spans start empty in a fresh process, while the history is
 * seeded from the caller and carries the earlier steps. It is the same reason
 * `getPromptAssistantStepBaseIndex` (mcpjam-stream-handler.ts) recovers the step count from here.
 *
 * Reads the same id pairing as `hasUnresolvedToolCalls`, in the opposite
 * direction: that one asks whether any call is still outstanding, this one
 * whether any call is genuinely DONE. A call with no result is a turn still
 * mid-flight, which must not excuse an empty step.
 *
 * An `error-` output does NOT count. A tool that threw, or one auto-denied by
 * policy, is the model TRYING to act and being refused — the opposite of
 * having acted — so "every tool failed, then the model said nothing" stays a
 * failure. A domain error from a server that did reply travels the ordinary
 * `content` shape and counts as the completed round-trip it is.
 */
export function hasSettledToolCallThisPrompt(
  messageHistory: ModelMessage[],
  promptMessageStartIndex: number,
): boolean {
  const toolCallIds = new Set<string>();
  for (
    let index = Math.max(0, promptMessageStartIndex);
    index < messageHistory.length;
    index += 1
  ) {
    const message = messageHistory[index];
    if (!message || !Array.isArray((message as any).content)) continue;
    if (message.role === "assistant") {
      for (const part of (message as any).content) {
        if (part?.type === "tool-call" && part.toolCallId) {
          toolCallIds.add(part.toolCallId);
        }
      }
    } else if (message.role === "tool") {
      for (const part of (message as any).content) {
        if (part?.type !== "tool-result") continue;
        if (!toolCallIds.has(part.toolCallId)) continue;
        const outputType = part.output?.type;
        if (typeof outputType === "string" && outputType.startsWith("error-")) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

/**
 * The sentence every empty-step failure opens with, verbatim.
 *
 * This family is classified BY TEXT: `describe.ts`'s inspector-sentinel sniff
 * matches it to `provider/empty_response` ("The model returned no response, so
 * the turn could not complete"), and the eval runner's own fallback in
 * `drive-hosted-eval-turn.ts` emits the identical sentence when the engine
 * reported nothing structured. So detail is APPENDED to this prefix, never
 * substituted for it — a message that explains itself must stay classifiable.
 */
export const EMPTY_STEP_SENTINEL =
  "Backend step returned no content (stream error or empty response)";

/**
 * Explain a step that produced zero content parts.
 *
 * A step that emits no text, no reasoning and no tool call has failed at the
 * model layer — but the engine used to record it as a SUCCESS: the terminal
 * branch stamped `status: "ok"`, wrote the finish chunk and returned, leaving
 * the eval runner to infer the failure from `newMessages.length === 0` and
 * report a sentence that named no cause. The finish chunk held the answer the
 * whole time.
 *
 * The provider finish reasons that arrive with empty content are different
 * failures with different remedies, so they are named separately:
 *
 *  - `error` — the provider rejected its OWN tool call. Google reports this as
 *    `MALFORMED_FUNCTION_CALL`, and `@ai-sdk/google` maps it to `"error"` with
 *    no parts and NO throw, so a clean 200 arrives carrying nothing. The
 *    flash/lite tiers hit it routinely on non-trivial tool schemas.
 *  - `content-filter` — a safety filter blocked the response.
 *  - `length` — the output-token limit was reached before any content. With
 *    nothing visible, the budget almost always went to reasoning the provider
 *    does not stream back (OpenAI's reasoning models return none by default);
 *    measured on staging, `gpt-5-nano` hit this at 8192 tokens on the first
 *    step of a drawing request.
 *  - `stop` / `tool-calls` — the provider claims a clean finish and still sent
 *    nothing, which is the shape a routed-provider hiccup takes. A `stop`
 *    only reaches here when the turn settled NO tool call: the caller treats a
 *    quiet `stop` after real tool work as a deliberate finish, not a failure,
 *    so the "retry" advice below stays true for everything that still arrives.
 *
 * `toolInputErrors` is the OTHER road here, and the only one with a direct
 * remedy: the model emitted a tool call, the SDK rejected its input against
 * the schema, and `tool-input-error` carries no content part. The backend's
 * `experimental_repairToolCall` fires before this point and forecloses most of
 * them; what reaches here is what repair could not fix.
 *
 * `unfinishedToolNames` is the third: a `tool-input-start` whose input never
 * became available, because the stream ended mid-call. It also carries no
 * content part, so without it the message would claim "no tool call" about a
 * model that was halfway through writing one. Paired with `length` it is the
 * other way the output-token limit ends a step empty.
 *
 * `outputTokens` is the step's own usage, quoted so a reader can compare it
 * with the limit without opening the trace.
 */
export function describeEmptyStepFailure(options: {
  finishReason?: string;
  toolInputErrors?: readonly string[];
  unfinishedToolNames?: readonly string[];
  outputTokens?: number;
}): string {
  const finishReason = options.finishReason;
  const outputTokenCount =
    typeof options.outputTokens === "number" &&
    Number.isFinite(options.outputTokens) &&
    options.outputTokens > 0
      ? ` (${options.outputTokens} output tokens)`
      : "";
  const firstToolInputError = options.toolInputErrors?.[0];
  if (firstToolInputError) {
    const cutOff =
      finishReason === "length"
        ? ` The output-token limit was also reached${outputTokenCount}, so the call was most likely cut off before its input was complete.`
        : "";
    return `${EMPTY_STEP_SENTINEL} — the model's tool call was rejected before it could run and nothing else was emitted this step: ${firstToolInputError}${cutOff}`;
  }
  const unfinishedToolName = options.unfinishedToolNames?.[0];
  let cause: string;
  switch (finishReason) {
    case "error":
      cause =
        "The provider reported an error without returning a diagnostic. The underlying cause was not recorded.";
      break;
    case "content-filter":
      cause = "The provider's safety filter blocked the response.";
      break;
    case "length":
      cause = unfinishedToolName
        ? `The model ran out of output tokens${outputTokenCount} while writing the call's input.`
        : `The model reached its output-token limit${outputTokenCount} before producing anything visible, which usually means the budget went to reasoning the provider does not stream back.`;
      break;
    case "stop":
    case "tool-calls":
      cause =
        "The provider reported a clean finish and still returned nothing. The underlying cause was not recorded.";
      break;
    default:
      cause = "The provider ended the stream without a usable finish reason.";
  }
  const shape = unfinishedToolName
    ? `the model started a call to \`${unfinishedToolName}\` but the stream ended before the call was complete, so it never ran`
    : "the model emitted no text, no reasoning and no tool call";
  return `${EMPTY_STEP_SENTINEL} — ${shape} (finishReason: ${
    finishReason ?? "none reported"
  }). ${cause}`;
}

/**
 * The same empty-step verdict for a DIRECT (BYOK) turn, read off the AI SDK's
 * UI chunk stream instead of Convex's per-step stream.
 *
 * `streamText` records an empty final step as a normal finish, so without this
 * the chat showed a blank assistant bubble with no error and no telemetry.
 * Feed every chunk to `observe`, then ask `failureFor` when the `finish` chunk
 * arrives: a string means write it as the error instead of finishing.
 *
 * The verdict is about the LAST step only, because that is the one the turn
 * ends on — an earlier empty step would have ended the turn itself. It keeps
 * the hosted engine's carve-out exactly: a clean `stop` after a tool actually
 * came back this prompt is a deliberate quiet finish, not a failure.
 * `settledToolBeforeStream` covers the resumed turn, whose settled tool is in
 * the seeded history rather than in this stream.
 *
 * Unknown chunk types count as content, so a chunk this does not model can
 * only ever suppress the error, never invent one.
 */
export function createEmptyTurnWatcher(options: {
  settledToolBeforeStream: boolean;
}): {
  observe: (chunk: UIMessageChunk) => void;
  failureFor: (finishChunk: UIMessageChunk) => string | undefined;
} {
  let sawStep = false;
  let sawError = false;
  let settledTool = options.settledToolBeforeStream;
  let stepHasContent = false;
  let toolInputErrors: string[] = [];
  const unfinishedTools = new Map<string, string>();
  let outputTokens: number | undefined;

  return {
    observe(chunk) {
      switch (chunk.type) {
        case "start-step":
          sawStep = true;
          stepHasContent = false;
          toolInputErrors = [];
          unfinishedTools.clear();
          outputTokens = undefined;
          return;
        case "start":
        case "finish-step":
        case "finish":
        case "text-start":
        case "text-end":
        case "reasoning-start":
        case "reasoning-end":
        case "tool-input-delta":
        case "abort":
          return;
        case "message-metadata": {
          const metadata = chunk.messageMetadata as
            { outputTokens?: unknown } | null | undefined;
          if (typeof metadata?.outputTokens === "number") {
            outputTokens = metadata.outputTokens;
          }
          return;
        }
        case "error":
          sawError = true;
          return;
        case "text-delta":
        case "reasoning-delta":
          if (chunk.delta) stepHasContent = true;
          return;
        case "tool-input-start":
          unfinishedTools.set(chunk.toolCallId, chunk.toolName);
          return;
        case "tool-input-available":
          unfinishedTools.delete(chunk.toolCallId);
          stepHasContent = true;
          return;
        case "tool-input-error":
          unfinishedTools.delete(chunk.toolCallId);
          toolInputErrors.push(
            chunk.errorText ||
              "the model's tool input failed schema validation",
          );
          return;
        case "tool-output-available":
          settledTool = true;
          stepHasContent = true;
          return;
        default:
          stepHasContent = true;
      }
    },
    failureFor(finishChunk) {
      if (!sawStep || sawError || stepHasContent) return undefined;
      const finishReason = normalizeFinishReason(
        (finishChunk as { finishReason?: unknown }).finishReason,
      );
      if (
        finishReason === "stop" &&
        toolInputErrors.length === 0 &&
        settledTool
      ) {
        return undefined;
      }
      return describeEmptyStepFailure({
        finishReason,
        toolInputErrors,
        unfinishedToolNames: [...unfinishedTools.values()],
        outputTokens,
      });
    },
  };
}
