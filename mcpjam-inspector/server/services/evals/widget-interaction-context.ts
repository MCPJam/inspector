/**
 * PR2 (flagged): feed model-visible widget→host tool calls — recorded by
 * `Interact` steps in `browserInteractionSteps` — to the eval model as a
 * per-turn system-prompt addendum, so the model reasons over a widget
 * interaction (e.g. "Add to cart") on its next turn.
 *
 * This is the headless analogue of Playground's widget→model flow. Playground
 * does it in the browser (`addToolOutput` into `useChat` messages +
 * `sendAutomaticallyWhen` auto-continue) — machinery that doesn't exist in the
 * headless Node runner. So we reuse the SAME server-side mechanism Playground
 * uses for `ui/update-model-context`: a system-prompt addendum
 * (`buildWidgetInteractionContextSystemPrompt`). Because it only touches the
 * system prompt string, it has ZERO effect on the message arrays, the
 * persisted transcript, or the matcher feed — the human still sees the
 * app-attributed card (PR1), and `widgetToolCallsByPromptIndex` stays the
 * single matcher source.
 */

import { isAppOnlyTool } from "@mcpjam/sdk/host-config/internal";
import type { RunnerBrowserInteractionStep } from "@/shared/eval-trace";
import { buildWidgetInteractionContextSystemPrompt } from "../../utils/chat-v2-orchestration.js";

/**
 * Flatten recorded widget→host tool calls to the MODEL-VISIBLE, successful ones
 * with a captured result. Per SEP-1865, a call whose `_meta.ui.visibility` is
 * exactly `["app"]` is UI-only and must never enter model context — excluded
 * here via the SDK's `isAppOnlyTool` predicate (default/absent visibility ⇒
 * `["model","app"]` ⇒ included). Error calls and pre-PR1 calls without a
 * recorded `result` carry no model-useful content, so they're skipped too.
 */
export function collectModelVisibleWidgetCalls(
  steps: readonly RunnerBrowserInteractionStep[]
): Array<{ toolName: string; result: unknown }> {
  const out: Array<{ toolName: string; result: unknown }> = [];
  for (const step of steps) {
    for (const call of step.widgetToolCalls ?? []) {
      if (!call.ok || call.result === undefined) continue;
      if (isAppOnlyTool({ ui: { visibility: call.visibility } })) continue;
      out.push({ toolName: call.name, result: call.result });
    }
  }
  return out;
}

/**
 * Build the eval widget-interaction system-prompt addendum from the browser
 * session's recorded interaction steps. Returns `""` when there are no
 * model-visible widget calls yet, so callers can join it conditionally.
 */
export function buildEvalWidgetContextSystemPrompt(
  steps: readonly RunnerBrowserInteractionStep[]
): string {
  return buildWidgetInteractionContextSystemPrompt(
    collectModelVisibleWidgetCalls(steps)
  );
}

/** Join a base system prompt with the widget-interaction addendum (skips empties). */
export function withWidgetContextSystemPrompt(
  base: string,
  steps: readonly RunnerBrowserInteractionStep[]
): string {
  const addendum = buildEvalWidgetContextSystemPrompt(steps);
  return [base, addendum].filter((s) => s.trim().length > 0).join("\n\n");
}
