import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";

/**
 * Build `frozenScreenshotUrl` tool-render overrides from a run's recorded
 * captures, so the Chat tab shows the captured widget instead of a live
 * re-render (which drifts to the widget's default state once its MCP server is
 * gone). See [[project_eval_chat_frozen_replay]].
 *
 * Merged onto `base` (the snapshot-derived overrides) keyed by `toolCallId` —
 * the SAME id the transcript tool part carries (`adaptTraceToUiMessages` re-keys
 * the message id but leaves the tool part's `toolCallId`).
 *
 * Picks the LATEST screenshot per tool call across BOTH the initial render
 * observation AND every subsequent interaction-step capture (each `interact`
 * click screenshots the widget after the action). So the Chat tab shows the
 * widget's FINAL post-interaction state — e.g. after "Add to cart" / opening the
 * cart — not just the opening render. Sorting by `ts` means a re-render or a
 * later failed attempt can't shadow the good capture. Returns `base` unchanged
 * when there's nothing to add.
 */
export function buildFrozenScreenshotOverrides(
  base: Record<string, ToolRenderOverride>,
  observations: readonly EvalTraceWidgetRenderObservationView[],
  interactionSteps: readonly EvalTraceBrowserInteractionStepView[] = []
): Record<string, ToolRenderOverride> {
  const latestByTool = new Map<string, { url: string; ts: number }>();
  const consider = (
    toolCallId: string,
    url: string | null | undefined,
    ts: number
  ) => {
    if (!url) return;
    const prev = latestByTool.get(toolCallId);
    if (!prev || ts > prev.ts) latestByTool.set(toolCallId, { url, ts });
  };
  for (const obs of observations) {
    if (obs.status === "rendered")
      consider(obs.toolCallId, obs.screenshotUrl, obs.ts);
  }
  // Interaction-step captures are later than the initial render (they happen on
  // each click), so they win on `ts` — surfacing the post-interaction state.
  for (const step of interactionSteps) {
    consider(step.toolCallId, step.screenshotUrl, step.ts);
  }
  if (latestByTool.size === 0) return base;
  const merged = { ...base };
  for (const [toolCallId, { url }] of latestByTool) {
    merged[toolCallId] = {
      ...merged[toolCallId],
      frozenScreenshotUrl: url,
    };
  }
  return merged;
}
