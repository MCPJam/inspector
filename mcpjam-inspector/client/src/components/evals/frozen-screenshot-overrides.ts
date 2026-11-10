import type {
  EvalTraceBrowserAction,
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";

/**
 * Actions that can move the App away from its opening state. `screenshot`
 * (also what scripted asserts map to), `mouse_move` and `wait` only look, so
 * the saved copy still matches what the run saw.
 */
const APP_STATE_CHANGING_ACTIONS: ReadonlySet<EvalTraceBrowserAction> =
  new Set([
    "left_click",
    "double_click",
    "right_click",
    "type",
    "key",
    "scroll",
  ]);

/** A step that actually acted on the App: a state-changing action that did
 *  not fail and was not skipped (a `note` marks a step that never ran). */
function changedAppState(step: EvalTraceBrowserInteractionStepView): boolean {
  return (
    APP_STATE_CHANGING_ACTIONS.has(step.action) &&
    step.ok !== false &&
    !step.note
  );
}

/**
 * Build `frozenScreenshotUrl` tool-render overrides from a run's recorded
 * captures. See [[project_eval_chat_frozen_replay]].
 *
 * By default the Chat tab shows the REAL App, loaded from the run's saved copy
 * (`cachedWidgetHtmlUrl` on the snapshot-derived `base` override). The recorded
 * picture is a screenshot of the whole headless test page, not the App, so it
 * is used only when:
 * - the run clicked inside that App (it has interaction steps), because the
 *   saved copy would re-open at its default state, not where the run left it; or
 * - there is no saved copy to load, as a backup.
 *
 * Merged onto `base` keyed by `toolCallId` — the SAME id the transcript tool
 * part carries (`adaptTraceToUiMessages` re-keys the message id but leaves the
 * tool part's `toolCallId`).
 *
 * Picks the LATEST screenshot per tool call across BOTH the initial render
 * observation AND every interaction-step capture, so a picture shows the
 * widget's FINAL post-interaction state. Sorting by `ts` means a re-render or a
 * later failed attempt can't shadow the good capture. Returns `base` unchanged
 * when there's nothing to add.
 */
export function buildFrozenScreenshotOverrides(
  base: Record<string, ToolRenderOverride>,
  observations: readonly EvalTraceWidgetRenderObservationView[],
  interactionSteps: readonly EvalTraceBrowserInteractionStepView[] = [],
): Record<string, ToolRenderOverride> {
  const latestByTool = new Map<
    string,
    { url: string; ts: number; resourceUri?: string }
  >();
  const errorsByTool = new Map<
    string,
    { consoleErrors: Set<string>; blockedRequests: Set<string> }
  >();
  const consider = (
    toolCallId: string,
    url: string | null | undefined,
    ts: number,
    resourceUri?: string,
  ) => {
    if (!url) return;
    const prev = latestByTool.get(toolCallId);
    if (!prev || ts > prev.ts) {
      latestByTool.set(toolCallId, {
        url,
        ts,
        resourceUri: resourceUri ?? prev?.resourceUri,
      });
    }
  };
  for (const obs of observations) {
    const errors = errorsByTool.get(obs.toolCallId) ?? {
      consoleErrors: new Set<string>(),
      blockedRequests: new Set<string>(),
    };
    for (const error of obs.consoleErrors ?? [])
      errors.consoleErrors.add(error);
    for (const request of obs.blockedRequests ?? []) {
      errors.blockedRequests.add(request);
    }
    errorsByTool.set(obs.toolCallId, errors);
    if (obs.status === "rendered")
      consider(obs.toolCallId, obs.screenshotUrl, obs.ts, obs.resourceUri);
  }
  // Interaction-step captures are later than the initial render (they happen on
  // each click), so they win on `ts` — surfacing the post-interaction state.
  const clickedToolCallIds = new Set<string>();
  for (const step of interactionSteps) {
    if (changedAppState(step)) clickedToolCallIds.add(step.toolCallId);
    consider(step.toolCallId, step.screenshotUrl, step.ts);
  }
  // Keep the live App (saved copy) unless the run clicked in it.
  for (const toolCallId of [...latestByTool.keys()]) {
    if (
      !clickedToolCallIds.has(toolCallId) &&
      base[toolCallId]?.cachedWidgetHtmlUrl
    ) {
      latestByTool.delete(toolCallId);
    }
  }
  if (latestByTool.size === 0) return base;
  const merged = { ...base };
  for (const [toolCallId, { url, resourceUri }] of latestByTool) {
    const errors = errorsByTool.get(toolCallId);
    const consoleErrors = [...(errors?.consoleErrors ?? [])];
    const blockedRequests = [...(errors?.blockedRequests ?? [])];
    merged[toolCallId] = {
      ...merged[toolCallId],
      frozenScreenshotUrl: url,
      ...(merged[toolCallId]?.resourceUri || !resourceUri
        ? {}
        : { resourceUri }),
      ...(consoleErrors.length || blockedRequests.length
        ? { recordedWidgetErrors: { consoleErrors, blockedRequests } }
        : {}),
    };
  }
  return merged;
}
