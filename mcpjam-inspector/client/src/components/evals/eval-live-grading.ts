/**
 * eval-live-grading — grade a single-model Quick Run conversation in place.
 *
 * The Preview pane is a live, ungraded Playground chat (`EvalLivePreview` →
 * `PlaygroundMain`): it never writes a test iteration, so the graded Run flow is
 * the only thing that normally produces a verdict. But users expect "I hit Quick
 * Run, did it pass?" answered right there. This derives the SAME deterministic
 * tool-call verdict the real runner computes — reusing `computeIterationPassed`
 * (→ `evaluateToolCalls`) so the live badge can never disagree with a graded Run
 * on the tool-call dimension.
 *
 * Multi-turn parity: the real runner grades each prompt turn against only the
 * tool calls made on THAT turn (`evaluateMultiTurnResults`), then passes the
 * iteration iff every turn passes. We mirror that here — bucket the live thread
 * by user turn and grade each turn with `computeIterationPassed` — so an
 * order-agnostic match can't let a call made on turn 1 satisfy a tool expected
 * on turn 2 (which would make the live badge show passed while a graded Run
 * fails).
 *
 * Scope: tool-call assertions + match options (order / extras / arguments /
 * negative-test) only. LLM-judge checks, predicates and `expectedOutput` are NOT
 * evaluated here (the live preview can't run the judge) — a full graded Run still
 * owns those. The caller surfaces that scoping in the badge tooltip.
 */
import type { UIMessage } from "ai";
import {
  getToolInfo,
  isDynamicTool,
  isToolPart,
} from "@/components/chat-v2/thread/thread-helpers";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import {
  flattenAssertedExpectedToolCalls,
  isPinnedTurn,
  type PromptTurn,
} from "@/shared/steps";
import { computeIterationPassed } from "./pass-criteria";
import type { EvalIteration } from "./types";

export type LiveToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

export type LiveVerdict = "passed" | "failed";

/**
 * Minimal projection of {@link EvalIteration} that {@link computeIterationPassed}
 * reads for the tool-call verdict. Typed against `EvalIteration` (rather than
 * erased with `as never`) so a shape change in the grading contract surfaces as a
 * type error here instead of letting the live badge silently diverge from a
 * graded Run.
 */
type LiveGradingIteration = Pick<
  EvalIteration,
  "resultSource" | "actualToolCalls"
> & {
  testCaseSnapshot: Pick<
    NonNullable<EvalIteration["testCaseSnapshot"]>,
    "expectedToolCalls" | "isNegativeTest" | "matchOptions"
  >;
};

/**
 * Pull the tool calls out of a single message. Mirrors the recorder's part walk
 * (`isToolPart`/`isDynamicTool` + `getToolInfo`) so a "call" here means the same
 * thing the backend records on an iteration. Non-assistant messages contribute
 * nothing.
 */
function collectToolCalls(message: UIMessage): LiveToolCall[] {
  if (message.role !== "assistant") return [];
  const calls: LiveToolCall[] = [];
  for (const part of message.parts ?? []) {
    if (!isToolPart(part) && !isDynamicTool(part)) continue;
    const info = getToolInfo(part as never);
    if (!info.toolName) continue;
    calls.push({
      toolName: info.toolName,
      arguments: (info.input ?? {}) as Record<string, unknown>,
    });
  }
  return calls;
}

/**
 * Flatten the tool calls the model actually made in the live thread, in order.
 */
export function extractActualToolCalls(messages: UIMessage[]): LiveToolCall[] {
  const calls: LiveToolCall[] = [];
  for (const message of messages) {
    calls.push(...collectToolCalls(message));
  }
  return calls;
}

/**
 * Bucket the live thread's tool calls by model turn. Each `user` message opens a
 * new turn; assistant tool calls accumulate into the open turn. This mirrors how
 * the runner builds `toolsCalledByPrompt` (one bucket per model turn) so per-turn
 * grading sees only the calls made in response to that turn's prompt — never a
 * call from an earlier or later turn. Tool calls before the first user message
 * (unusual in a Playground thread) are ignored.
 */
export function extractActualToolCallsByTurn(
  messages: UIMessage[],
): LiveToolCall[][] {
  const turns: LiveToolCall[][] = [];
  let current: LiveToolCall[] | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = [];
      turns.push(current);
      continue;
    }
    if (!current) continue;
    current.push(...collectToolCalls(message));
  }
  return turns;
}

/**
 * A negative test = the model is expected to call no tools. Pinned
 * (render-check) turns are model-free, so exclude them when deciding. Mirrors
 * `deriveIsNegativeTestFromPromptTurns` in the editor.
 */
function deriveIsNegativeTest(promptTurns: PromptTurn[]): boolean {
  const modelTurns = promptTurns.filter((turn) => !isPinnedTurn(turn));
  return (
    modelTurns.length > 0 &&
    modelTurns.every((turn) => turn.expectedToolCalls.length === 0)
  );
}

/**
 * Grade the live Quick-Run conversation against the current draft's tool-call
 * assertions, per turn. Returns the deterministic Passed/Failed verdict, or
 * `null` when the live preview can't faithfully reproduce what a graded Run would
 * score — so the caller stays quiet instead of showing a badge that could
 * disagree. We defer (return `null`) when:
 *   - there's nothing to grade (no asserted tool calls and not a negative test);
 *   - any turn carries widget interaction/assert steps (`widgetChecks`): the
 *     runner folds widget→host tool calls into a turn's actuals
 *     (`widgetToolCallsByPromptIndex`), but the live Playground preview never
 *     executes those authored steps, so its model-only view would diverge;
 *   - the thread's user turns don't line up 1:1 with the authored model turns —
 *     e.g. a partial run, or a synthetic follow-up `user` turn from a widget
 *     `ui/message` (which the runner folds into the PARENT turn, not a new one).
 */
export function gradeLiveToolCalls(params: {
  promptTurns: PromptTurn[];
  matchOptions?: EvalMatchOptions;
  messages: UIMessage[];
}): LiveVerdict | null {
  const { promptTurns, matchOptions, messages } = params;
  const isNegativeTest = deriveIsNegativeTest(promptTurns);

  // Nothing the live preview can deterministically judge: no asserted calls on
  // any turn and not a "should call nothing" test. Defer to a full graded Run.
  if (
    !isNegativeTest &&
    flattenAssertedExpectedToolCalls({ promptTurns }).length === 0
  ) {
    return null;
  }

  // Widget-interaction cases are owned by the graded Run. The live Playground
  // preview doesn't execute authored widget interact/assert steps, so it never
  // sees the widget→host tool calls the runner folds into a turn's actuals
  // (`widgetToolCallsByPromptIndex`). Grading tool-call assertions on a
  // model-only view could disagree with a graded Run, so defer.
  if (promptTurns.some((turn) => (turn.widgetChecks?.length ?? 0) > 0)) {
    return null;
  }

  // Pinned (render-check) turns are model-free fixtures, exempt from matching —
  // they always pass and emit no user message in the live thread. Grade only the
  // model turns, in order.
  const modelTurns = promptTurns.filter((turn) => !isPinnedTurn(turn));

  // No model turns means a pinned-only (model-free) case. The early gate above
  // can still pass here if a pinned turn declares `expectedToolCalls` (flattened
  // for display but exempt from matching), and the loop below would then run zero
  // times and vacuously return "passed". The live preview doesn't execute pinned
  // fixtures, so defer to the graded Run rather than claim a pass.
  if (modelTurns.length === 0) {
    return null;
  }

  const actualByTurn = extractActualToolCallsByTurn(messages);

  // The thread's user turns must line up 1:1 with the authored model turns. A
  // mismatch means the run is partial (fewer) or the thread has a synthetic
  // follow-up `user` turn — e.g. a widget `ui/message`, which the runner folds
  // into the parent turn rather than treating as a new turn. Per-turn
  // attribution would be unreliable, so defer instead of risking a wrong verdict.
  if (actualByTurn.length !== modelTurns.length) {
    return null;
  }

  for (let i = 0; i < modelTurns.length; i += 1) {
    const turn = modelTurns[i]!;
    const iteration: LiveGradingIteration = {
      resultSource: "derived",
      actualToolCalls: actualByTurn[i] ?? [],
      testCaseSnapshot: {
        expectedToolCalls: turn.expectedToolCalls ?? [],
        isNegativeTest,
        matchOptions,
      },
    };
    const turnPassed = computeIterationPassed(
      iteration as unknown as EvalIteration,
      undefined,
    );

    // Overall verdict mirrors `evaluateMultiTurnResults`: passed iff every turn
    // passed, so fail fast on the first failing turn.
    if (!turnPassed) return "failed";
  }

  return "passed";
}
