import type {
  EvalTraceBrowserAction,
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { detectUIType } from "@/lib/mcp-ui/mcp-apps-utils";

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

/** The saved copy can mount as a live App: it has HTML and UI tool metadata.
 *  PartSwitch reads its UI type from that metadata, so without it the tool
 *  call would show as a bare tool card. */
function canMountSavedApp(override: ToolRenderOverride | undefined): boolean {
  return (
    !!override?.cachedWidgetHtmlUrl &&
    detectUIType(override.toolMetadata, undefined) !== null
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
 * - the run acted on that App (a step that passes `changedAppState`, such as a
 *   click or typing), because the saved copy would re-open at its default
 *   state, not where the run left it; or
 * - there is no saved copy that can mount as an App, as a backup.
 *
 * The run's recorded console errors and blocked requests stay on the override
 * either way, so the Chat tab can still show them next to the live App.
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
  // Keep the live App (saved copy) unless the run acted on it. Its picture stays
  // as a backup that PartSwitch shows only if the App can't render under the
  // host being viewed.
  const fallbackByTool = new Map<string, string>();
  for (const [toolCallId, { url }] of [...latestByTool]) {
    if (
      !clickedToolCallIds.has(toolCallId) &&
      canMountSavedApp(base[toolCallId])
    ) {
      latestByTool.delete(toolCallId);
      fallbackByTool.set(toolCallId, url);
    }
  }
  const recordedErrorsFor = (toolCallId: string) => {
    const errors = errorsByTool.get(toolCallId);
    const consoleErrors = [...(errors?.consoleErrors ?? [])];
    const blockedRequests = [...(errors?.blockedRequests ?? [])];
    return consoleErrors.length || blockedRequests.length
      ? { recordedWidgetErrors: { consoleErrors, blockedRequests } }
      : {};
  };
  let merged: Record<string, ToolRenderOverride> | undefined;
  const set = (toolCallId: string, override: ToolRenderOverride) => {
    merged ??= { ...base };
    merged[toolCallId] = override;
  };
  for (const [toolCallId, { url, resourceUri }] of latestByTool) {
    set(toolCallId, {
      ...base[toolCallId],
      frozenScreenshotUrl: url,
      ...(base[toolCallId]?.resourceUri || !resourceUri ? {} : { resourceUri }),
      ...recordedErrorsFor(toolCallId),
    });
  }
  for (const [toolCallId, url] of fallbackByTool) {
    set(toolCallId, {
      ...base[toolCallId],
      fallbackScreenshotUrl: url,
      ...recordedErrorsFor(toolCallId),
    });
  }
  // A live App keeps the errors the run recorded for it.
  for (const toolCallId of errorsByTool.keys()) {
    if (
      latestByTool.has(toolCallId) ||
      fallbackByTool.has(toolCallId) ||
      !base[toolCallId]
    )
      continue;
    const errors = recordedErrorsFor(toolCallId);
    if (errors.recordedWidgetErrors) {
      set(toolCallId, { ...base[toolCallId], ...errors });
    }
  }
  return merged ?? base;
}
