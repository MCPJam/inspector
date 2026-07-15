/**
 * Pure decision helper for the eval live-preview auto-run.
 *
 * When the embedded preview (`EvalLivePreview` → `PlaygroundMain`) opens on a
 * widget case, it auto-sends the case prompt so the widget renders immediately.
 * But the case's model/settings arrive via an `evalChatHandoff` that
 * PlaygroundMain applies asynchronously (once the session bootstraps). If
 * auto-run fired first, the prompt would run against the Playground default
 * model instead of the case's. This gate holds auto-run until any pending
 * handoff has been consumed, so model/settings always bind first.
 */
export function shouldAutoRunPreview(params: {
  autoRunInput: string | undefined;
  alreadyRan: boolean;
  isSessionBootstrapComplete: boolean;
  isThreadEmpty: boolean;
  isStreaming: boolean;
  /** A model/settings handoff is present but not yet applied. */
  handoffPending: boolean;
}): boolean {
  const {
    autoRunInput,
    alreadyRan,
    isSessionBootstrapComplete,
    isThreadEmpty,
    isStreaming,
    handoffPending,
  } = params;
  if (alreadyRan) return false;
  if (!autoRunInput) return false;
  // Wait for the case model/settings to bind before sending.
  if (handoffPending) return false;
  if (!isSessionBootstrapComplete) return false;
  if (!isThreadEmpty || isStreaming) return false;
  return true;
}

/**
 * Gate for eval Quick Run: RE-RUN the case in the live preview. Unlike the
 * old "submit the composer" behavior, this resets the thread and re-sends the
 * case prompt fresh (so editing the left-pane prompt + Quick Run is reflected
 * on the right, instead of appending a follow-up into the existing chat). Fires
 * once per new `runPreviewRequest` nonce from the editor, once the session is
 * ready and any model/settings handoff has applied. It does NOT depend on
 * composer content — the prompt to run comes from the case, not the composer.
 */
export function shouldRunPreview(params: {
  runPreviewRequest: number | undefined;
  alreadyHandledRequest: number;
  isSessionBootstrapComplete: boolean;
  isStreaming: boolean;
  handoffPending: boolean;
}): boolean {
  const {
    runPreviewRequest,
    alreadyHandledRequest,
    isSessionBootstrapComplete,
    isStreaming,
    handoffPending,
  } = params;
  if (!runPreviewRequest) return false;
  if (runPreviewRequest <= alreadyHandledRequest) return false;
  if (handoffPending) return false;
  if (!isSessionBootstrapComplete) return false;
  if (isStreaming) return false;
  return true;
}
