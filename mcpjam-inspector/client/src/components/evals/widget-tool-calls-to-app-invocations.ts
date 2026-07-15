import type { EvalTraceBrowserInteractionStepView } from "@/shared/eval-trace";
import type { AppToolInvocation } from "@/components/chat-v2/thread/app-tool-invocations";

/**
 * Reconstruct `AppToolInvocation[]` from a completed run's persisted
 * `browserInteractionSteps`, so the Chat tab renders each widget→host
 * `tools/call` as the same MCP-branded `AppToolInvocationPart` card the live
 * Playground shows — nested under the model tool call that mounted the widget.
 *
 * An eval run is frozen (dead server, recorded screenshot), so it can't re-fire
 * the live host bridge that builds `appToolInvocations` in Playground. This is
 * the frozen-replay analogue: it rebuilds the invocations from the recorded
 * `widgetToolCalls`, which now carry the tool `result` (see PR1) so the card's
 * expander can show the output.
 *
 * Every widget call renders here regardless of `visibility` — the human auditor
 * should see app-initiated calls (refresh buttons included). `visibility` only
 * gates whether a call additionally enters the MODEL's context (a separate,
 * runner-side concern), never whether it's shown.
 *
 * Sibling to `frozen-screenshot-overrides.ts` (same input shape): both map
 * `EvalTraceBrowserInteractionStepView[]` onto a render-layer structure keyed by
 * the parent `toolCallId`.
 */
export function buildAppToolInvocationsFromBrowserSteps(
  steps: readonly EvalTraceBrowserInteractionStepView[]
): AppToolInvocation[] {
  const out: Array<{ ts: number; order: number; inv: AppToolInvocation }> = [];
  for (const step of steps) {
    const calls = step.widgetToolCalls ?? [];
    calls.forEach((call, callIndex) => {
      const input =
        call.args && typeof call.args === "object" && !Array.isArray(call.args)
          ? (call.args as Record<string, unknown>)
          : undefined;
      out.push({
        ts: step.ts,
        order: step.stepIndex * 1000 + callIndex,
        inv: {
          // Stable + unique per (toolCallId, stepIndex, callIndex).
          id: `${step.toolCallId}:app-tool:${step.stepIndex}-${callIndex}`,
          // The model tool call that mounted the widget — matches the transcript
          // tool part's `toolCallId`, so the card slots under the right bubble.
          parentToolCallId: step.toolCallId,
          toolName: call.name,
          ...(input ? { input } : {}),
          // Recorded calls are always complete (no "running").
          status: call.ok ? "success" : "error",
          ...(call.ok ? {} : { errorText: call.error }),
          // `result` is absent on the error path and on pre-PR1 legacy runs;
          // `AppToolInvocationPart` degrades gracefully when `output` is undefined.
          ...(call.ok && call.result !== undefined
            ? { output: call.result }
            : {}),
          startedAt: step.ts,
          completedAt: step.ts + call.elapsedMs,
        },
      });
    });
  }
  // Fire order: by capture time, then step/call index for calls sharing a `ts`.
  out.sort((a, b) => a.ts - b.ts || a.order - b.order);
  return out.map((entry) => entry.inv);
}
