/**
 * Tier 3 recorder wiring types, shared across the trace render chain
 * (TraceViewer → Thread → transcript-thread → message-view → part-switch →
 * WidgetReplay). Kept decoupled from inspector domain types: `step` is `unknown`
 * here; the eval editor casts it to `ScriptedStep` when saving.
 *
 * Recording is armed for ONE widget target at a time. `part-switch` matches a
 * rendered widget against the target by (promptIndex, toolName) — promptIndex is
 * resolved from the widget's `toolCallId` via `resolvePromptIndex` (built from
 * the trace's spans by the editor) — and only the matching widget records.
 */

/** The single widget currently armed for recording. */
export interface RecordingTarget {
  promptIndex: number;
  toolName: string;
}

/** Emitted (host-assembled, tagged at the rendered tool part) per captured step. */
export interface RecorderStepEvent {
  promptIndex: number;
  toolName: string;
  /** Runtime-only — attribution/debug; NOT persisted into widgetChecks. */
  toolCallId: string;
  /** A ScriptedStep (typed `unknown` here to keep chat-v2 decoupled). */
  step: unknown;
}

/** Emitted when the recorder shim installs in a record-capable widget guest. */
export interface RecorderReadyEvent {
  promptIndex: number;
  toolName: string;
  toolCallId: string;
}

/** Result of replaying ONE scripted step against the live widget (mirrors the
 *  guest shim's `ReplayStepResult`). `deferred: "widgetToolCalled"` flags a step
 *  the shim can't judge alone, so the host evaluates it against its tool log. */
export interface ReplayStepResult {
  ok: boolean;
  reason?: string;
  deferred?: string;
}

/** Replays one scripted step against the live widget and resolves the result. */
export type ReplayStepFn = (step: unknown) => Promise<ReplayStepResult>;

/**
 * Emitted (tagged at the rendered tool part) when a record-capable widget can be
 * driven, so the host can REPLAY recorded steps against it. `replay` is `null`
 * when the widget unmounts / recording turns off — the host drops the handle.
 */
export interface ReplayControllerEvent {
  promptIndex: number;
  toolName: string;
  toolCallId: string;
  replay: ReplayStepFn | null;
}

/**
 * Recorder props threaded down the render chain. All optional + default off so
 * chat, playground, run-results, and trace replay are unaffected.
 */
export interface RecorderProps {
  /**
   * When true, EVERY rendered widget loads the capture shim on first render (the
   * surface is record-CAPABLE), so arming never reloads a widget. Reloading on
   * arm re-runs the widget's `ui/initialize` without closing the previous App
   * instance → a second AppBridge → misrouted handshake ("unknown message ID")
   * and the recorder never reports ready. With the shim always present, arming
   * is a host-side gate (which widget's steps get SAVED), not a reload.
   */
  recordCapable?: boolean;
  recordingTarget?: RecordingTarget | null;
  /** Resolve a widget's promptIndex from its runtime toolCallId (trace spans). */
  resolvePromptIndex?: (toolCallId: string) => number | undefined;
  onRecorderStep?: (event: RecorderStepEvent) => void;
  onRecorderReady?: (event: RecorderReadyEvent) => void;
  /** Published per record-capable widget so the host can replay steps against it. */
  onReplayControllerReady?: (event: ReplayControllerEvent) => void;
}

// ---------------------------------------------------------------------------
// Pure decision helpers (testable seams used by part-switch + the eval editor).
// ---------------------------------------------------------------------------

/**
 * Per-widget recorder decision, computed by `part-switch` for each rendered
 * widget. A widget records when its surface is record-capable (every widget
 * loads the shim) OR it is the armed target. The resolved `promptIndex` tags
 * emitted steps: prefer the widget's own (from trace spans), else the armed
 * target's, else 0 (single-turn live preview before spans exist).
 */
export function computeWidgetRecordMode(params: {
  recordCapable?: boolean;
  recordingTarget?: RecordingTarget | null;
  toolName: string;
  toolCallId: string | undefined;
  widgetPromptIndex: number | undefined;
}): { recordMode: boolean; promptIndex: number } {
  const {
    recordCapable,
    recordingTarget,
    toolName,
    toolCallId,
    widgetPromptIndex,
  } = params;
  // Match on BOTH turn and tool: the same widget tool can appear in multiple
  // turns, so toolName alone would arm/record the wrong instance. When the
  // widget's own turn can't be resolved yet (no spans, single-turn live preview)
  // fall back to tool-only — there's only one instance to record then anyway.
  const armedMatch =
    !!recordingTarget &&
    toolName === recordingTarget.toolName &&
    (widgetPromptIndex === undefined ||
      widgetPromptIndex === recordingTarget.promptIndex);
  const recordMode = !!toolCallId && (!!recordCapable || armedMatch);
  const promptIndex = widgetPromptIndex ?? recordingTarget?.promptIndex ?? 0;
  return { recordMode, promptIndex };
}

/**
 * Host-side SAVE gate. A record-capable surface emits steps for ANY clicked
 * widget; only the armed target's steps are persisted. Returns false when
 * nothing is armed or the event came from a different widget — keyed on BOTH
 * `promptIndex` and `toolName` so the same tool in another turn ("wrong target
 * does not record") is rejected. The event's `promptIndex` is the widget's
 * span-resolved turn (falling back to the armed target's only before spans
 * exist, where a single instance makes the comparison a no-op).
 */
export function shouldSaveRecorderStep(
  target: RecordingTarget | null | undefined,
  event: Pick<RecorderStepEvent, "toolName" | "promptIndex">,
): target is RecordingTarget {
  return (
    !!target &&
    event.toolName === target.toolName &&
    event.promptIndex === target.promptIndex
  );
}

/**
 * LIVE-scope save gate. Unlike `shouldSaveRecorderStep` (which persists only an
 * exact, manually-armed `{promptIndex, toolName}` target), the live eval Record
 * panel arms nothing: every widget rendered by the live chat is record-capable,
 * and a click should record into the turn that widget belongs to. So we accept
 * any step whose `promptIndex` resolved to a real turn (the host injects
 * `resolvePromptIndex` from the live message ordinals). `toolName` is carried
 * through for the saved step but is not gated on, since there is no armed tool.
 *
 * A negative / non-integer `promptIndex` means the widget's owning turn could
 * not be resolved yet (e.g. the toolCallId isn't in the live snapshot); drop
 * the step rather than misfile it into turn 0.
 */
export function shouldSaveLiveRecorderStep(
  event: Pick<RecorderStepEvent, "promptIndex">,
): boolean {
  return Number.isInteger(event.promptIndex) && event.promptIndex >= 0;
}

/**
 * The draft has diverged from the fingerprint captured at the shown preview run
 * — the rendered widget no longer matches the draft. Target-INDEPENDENT, so the
 * editor can gate "is the shown run still fresh?" before anything is armed (a
 * first click on a stale run must re-run, not arm the old widget). `null` run
 * fingerprint = no run captured yet ⇒ not diverged.
 */
export function fingerprintDiverged(
  previewRunFingerprint: string | null,
  currentDraftFingerprint: string,
): boolean {
  return (
    previewRunFingerprint !== null &&
    currentDraftFingerprint !== previewRunFingerprint
  );
}

/**
 * Recording is stale (disabled until re-run) when a target is armed but the
 * draft fingerprint has diverged from the one captured at the shown preview
 * run — the rendered widget no longer matches the draft, so recorded locators
 * could be wrong.
 */
export function isRecorderStale(params: {
  recordingTarget: RecordingTarget | null;
  previewRunFingerprint: string | null;
  currentDraftFingerprint: string;
}): boolean {
  const { recordingTarget, previewRunFingerprint, currentDraftFingerprint } =
    params;
  return (
    !!recordingTarget &&
    fingerprintDiverged(previewRunFingerprint, currentDraftFingerprint)
  );
}
