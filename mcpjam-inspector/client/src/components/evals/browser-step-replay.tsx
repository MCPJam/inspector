/**
 * browser-step-replay.tsx — the shared vocabulary and UI for one recorded
 * browser interaction step, plus the filmstrip that ties a run's steps to its
 * replay video.
 *
 * Every surface that shows what the headless-Chromium harness did — the eval
 * Browser/Replay tab, `ShareUsageThreadDetail`, a swarm run's session pane, and
 * the Trace timeline's interaction detail pane — reads the same
 * `browserInteractionSteps` rows. They used to each render their own `<img>` and
 * their own label logic. One owner now: the labels/verdicts live here, and the
 * detail pane is a component both the timeline and the filmstrip mount.
 *
 * The filmstrip is what makes the recording navigable. Each step carries
 * `videoOffsetMs` — its offset into the run's `.webm`, from the recording-start
 * origin — which existed end-to-end with no consumer. Selecting a frame seeks
 * the video to that offset and shows that step's detail; scrubbing the video
 * highlights the frame it lands on. Three views, one cursor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { EvalTraceBrowserInteractionStepView } from "@/shared/eval-trace";

/** Verdict for an interaction step: asserts use `assertion`, actions use `ok`. */
export type BrowserStepStatus = "ok" | "error" | "unknown";

/**
 * How far SHORT of a manually selected step's offset the playhead may sit and
 * still count as "on" it. A seek resolves to the nearest decodable frame, which
 * in a low-keyframe-rate `.webm` can land a few hundred ms before the requested
 * offset; without this slack a click would release its own selection.
 *
 * One-sided on purpose. The undershoot is the only case that needs protecting,
 * and a symmetric window would hold the pin for half a second AFTER the step,
 * hiding any interaction that happened inside it — the filmstrip would visibly
 * skip frames during ordinary playback.
 */
const SEEK_UNDERSHOOT_TOLERANCE_MS = 500;

export const BROWSER_STEP_STATUS_BADGE_CLASS: Record<
  BrowserStepStatus,
  string
> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  error: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  unknown: "border-border/50 bg-muted/40 text-muted-foreground",
};

/** Human-readable verb for an interaction step's action enum. */
export function browserStepActionVerb(action: string): string {
  switch (action) {
    case "left_click":
      return "Click";
    case "double_click":
      return "Double-click";
    case "right_click":
      return "Right-click";
    case "mouse_move":
      return "Move";
    case "type":
      return "Type";
    case "key":
      return "Key";
    case "scroll":
      return "Scroll";
    case "wait":
      return "Wait";
    case "screenshot":
      return "Assert";
    default:
      return action;
  }
}

/** Label for an interaction step, e.g. `Interact · Click "Add to cart"`. */
export function browserStepLabel(
  step: EvalTraceBrowserInteractionStepView,
): string {
  const verb = browserStepActionVerb(step.action);
  const target = step.locatorLabel?.trim();
  return target ? `Interact · ${verb} ${target}` : `Interact · ${verb}`;
}

export function browserStepStatus(
  step: EvalTraceBrowserInteractionStepView,
): BrowserStepStatus {
  if (step.assertion) return step.assertion.passed ? "ok" : "error";
  if (step.ok === true) return "ok";
  if (step.ok === false) return "error";
  return "unknown";
}

/** Stable identity for a step across the video, the filmstrip, and the trace. */
export function browserStepKey(
  step: EvalTraceBrowserInteractionStepView,
): string {
  return `${step.toolCallId}:${step.stepIndex}`;
}

/**
 * Normalize a replay video URL: an empty string means "no video", the same way
 * the trace viewer reads it. Kept here so the tab gate and the player agree.
 */
export function replayVideoUrl(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Does this run have anything to replay? Observations OR steps OR a video.
 *
 * ONE owner. This predicate was spelled out independently in the trace viewer,
 * `ShareUsageThreadDetail`, the swarm live pane, and the eval quick-run column —
 * each copy annotated with a plea that the copies not disagree. They did:
 * one accepted an empty-string `videoUrl` the player then treated as absent.
 */
export function hasReplayArtifacts(source: {
  widgetRenderObservations?: unknown[] | null;
  browserInteractionSteps?: unknown[] | null;
  videoUrl?: unknown;
}): boolean {
  return (
    (source.widgetRenderObservations?.length ?? 0) > 0 ||
    (source.browserInteractionSteps?.length ?? 0) > 0 ||
    replayVideoUrl(source.videoUrl) !== null
  );
}

function statusLabel(status: BrowserStepStatus): string {
  return status === "ok" ? "OK" : status === "error" ? "Failed" : "Unknown";
}

/**
 * One step's full record: label, timing, coordinate, screenshot, the widget→host
 * tool calls it triggered, and any `ui/message` it sent back to chat.
 *
 * `leading` is the surface's own glyph (the Trace timeline passes its category
 * glyph; the filmstrip passes none), so this component owns the content without
 * reaching into either surface's iconography.
 */
export function BrowserStepDetail({
  step,
  leading,
  className,
}: {
  step: EvalTraceBrowserInteractionStepView;
  leading?: React.ReactNode;
  className?: string;
}) {
  const status = browserStepStatus(step);
  const calls = step.widgetToolCalls ?? [];
  // Computer Use steps target a pixel; surface it so every replay surface
  // carries the coordinate, not just the Trace tab.
  const coordinate =
    step.coordinateX != null && step.coordinateY != null
      ? `(${step.coordinateX}, ${step.coordinateY})`
      : null;

  return (
    <div
      data-testid="browser-step-detail"
      className={cn("flex flex-col gap-4", className)}
    >
      <div className="flex items-center gap-2">
        {leading}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {browserStepLabel(step)}
          </p>
          <p className="text-xs text-muted-foreground">
            App interaction · {step.elapsedMs}ms
            {coordinate ? ` · ${coordinate}` : ""}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
            BROWSER_STEP_STATUS_BADGE_CLASS[status],
          )}
        >
          {statusLabel(status)}
        </span>
      </div>

      {step.assertion && !step.assertion.passed && step.assertion.reason ? (
        <p className="text-xs text-red-500">{step.assertion.reason}</p>
      ) : null}

      {step.screenshotUrl ? (
        <img
          src={step.screenshotUrl}
          alt={browserStepLabel(step)}
          className="max-h-72 w-full rounded-md border border-border/50 object-contain"
        />
      ) : null}

      {calls.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Widget tool calls
          </p>
          {calls.map((call, i) => (
            <div
              key={`${call.name}-${i}`}
              className="flex items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-xs"
            >
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                  call.ok ? "bg-emerald-500" : "bg-destructive",
                )}
                aria-hidden
              />
              <span className="font-mono text-foreground">{call.name}</span>
              {call.error ? (
                <span className="truncate text-red-500">{call.error}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {step.followUps && step.followUps.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Sent message to chat
          </p>
          {step.followUps.map((text, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-xs"
            >
              <span aria-hidden>↳</span>
              <span className="truncate text-foreground">{text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Pick the step the video's playhead is currently on: the last step whose
 * offset is at or before `currentMs`. Before the first step's offset, nothing is
 * current — the video is still in its pre-interaction lead-in.
 *
 * Exported for tests: this is the whole of the video→filmstrip direction.
 */
export function stepAtVideoOffset(
  steps: EvalTraceBrowserInteractionStepView[],
  currentMs: number,
): EvalTraceBrowserInteractionStepView | null {
  let current: EvalTraceBrowserInteractionStepView | null = null;
  for (const step of steps) {
    if (step.videoOffsetMs == null) continue;
    if (step.videoOffsetMs <= currentMs) current = step;
    else break;
  }
  return current;
}

/**
 * Video + filmstrip + step detail, kept in sync.
 *
 * `steps` may include steps with no `videoOffsetMs` (a run recorded before the
 * offset was stamped, or one where no video was captured). Those still appear in
 * the filmstrip and are still selectable — they just can't seek. That is a
 * deliberate degradation: the screenshots are the record, the video is the
 * convenience.
 */
export function BrowserStepFilmstrip({
  steps,
  videoUrl,
  /** True while the run is still going, so a missing video isn't yet a loss. */
  isRunning = false,
  className,
}: {
  steps: EvalTraceBrowserInteractionStepView[];
  videoUrl?: string | null;
  isRunning?: boolean;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Set only by video playback, so a manual selection isn't immediately
  // overwritten by the `seeking` → `timeupdate` echo of its own seek.
  const [playheadKey, setPlayheadKey] = useState<string | null>(null);
  // The offset (in seconds) `selectStep` last seeked to, held until the video
  // reports the seek finished. Not a "swallow the next timeupdate" boolean: a
  // playback tick can reach the handler before the seek lands, and a one-shot
  // boolean would spend itself on that unrelated tick and drop the user's pin.
  // Cleared by `seeked` — the browser's own signal that the seek is done.
  const pendingSeekTargetRef = useRef<number | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  const resolvedVideoUrl = replayVideoUrl(videoUrl);

  const ordered = useMemo(
    () =>
      [...steps].sort(
        (a, b) =>
          (a.videoOffsetMs ?? Number.POSITIVE_INFINITY) -
            (b.videoOffsetMs ?? Number.POSITIVE_INFINITY) ||
          a.promptIndex - b.promptIndex ||
          a.ts - b.ts,
      ),
    [steps],
  );

  const activeKey = selectedKey ?? playheadKey ?? null;
  const activeStep = useMemo(
    () => ordered.find((step) => browserStepKey(step) === activeKey) ?? null,
    [ordered, activeKey],
  );

  const seekable = resolvedVideoUrl != null && !videoFailed;
  // "Screenshots preserved" has to be TRUE to be said: a run can have steps
  // whose screenshot upload dropped, leaving rows with no frame at all.
  const hasAnyScreenshot = ordered.some((step) => step.screenshotUrl);

  const selectStep = useCallback(
    (step: EvalTraceBrowserInteractionStepView) => {
      setSelectedKey(browserStepKey(step));
      const video = videoRef.current;
      if (!video || !seekable || step.videoOffsetMs == null) return;
      // Seek, don't play: the point is to look at the frame this step produced.
      const target = step.videoOffsetMs / 1000;
      pendingSeekTargetRef.current = target;
      video.currentTime = target;
    },
    [seekable],
  );

  // The seek this component asked for has landed. Nothing to do but stop
  // treating later ticks as pre-seek noise — `onTimeUpdate` decides from the
  // playhead position whether the pin is still current.
  const onSeeked = useCallback(() => {
    pendingSeekTargetRef.current = null;
  }, []);

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const current = stepAtVideoOffset(ordered, video.currentTime * 1000);
    setPlayheadKey(current ? browserStepKey(current) : null);
    // A seek we asked for hasn't landed: this tick reports a position from
    // BEFORE the click, so it says nothing about whether the pin is stale.
    if (pendingSeekTargetRef.current != null) return;
    // The pin holds while the playhead is still SHORT of the pinned step's own
    // offset: browsers resolve a seek to the nearest decodable frame, which can
    // land just before what was asked for, and releasing there would slide the
    // selection to the previous step the instant the user clicked one. Once
    // playback reaches or passes the step, control goes back to the video.
    if (selectedKey != null) {
      const pinned = ordered.find(
        (step) => browserStepKey(step) === selectedKey,
      );
      if (pinned?.videoOffsetMs != null) {
        const shortfallMs = pinned.videoOffsetMs - video.currentTime * 1000;
        if (shortfallMs > 0 && shortfallMs < SEEK_UNDERSHOOT_TOLERANCE_MS) {
          return;
        }
      }
    }
    // Playback has moved on, so the manual pin is stale — release it and let the
    // filmstrip follow the video again.
    setSelectedKey(null);
  }, [ordered, selectedKey]);

  // A run whose steps arrive before its video (mid-run, or a dropped upload)
  // must not keep showing a stale failure state once the video lands.
  useEffect(() => {
    setVideoFailed(false);
  }, [videoUrl]);

  if (ordered.length === 0 && !resolvedVideoUrl) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-border/40 py-8 text-xs text-muted-foreground"
        data-testid="browser-filmstrip-empty"
      >
        {isRunning
          ? "Finalizing replay…"
          : "No app interactions were recorded."}
      </div>
    );
  }

  return (
    <section
      className={cn("flex min-w-0 flex-col gap-3", className)}
      data-testid="browser-step-filmstrip"
    >
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Replay
          <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">
            screen recording of the app interactions in this run
          </span>
        </h3>
        {resolvedVideoUrl && !videoFailed ? (
          <video
            ref={videoRef}
            src={resolvedVideoUrl}
            controls
            preload="metadata"
            onTimeUpdate={onTimeUpdate}
            onSeeked={onSeeked}
            onError={() => setVideoFailed(true)}
            className="w-full rounded-md border border-border/60 bg-black"
            data-testid="browser-replay-video"
          />
        ) : (
          <p
            className="rounded-md border border-dashed border-border/50 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground"
            data-testid="browser-replay-video-unavailable"
          >
            {isRunning
              ? "Finalizing replay — the recording is written when the run ends."
              : videoFailed
                ? hasAnyScreenshot
                  ? "Recording failed to load — screenshots preserved."
                  : "Recording failed to load, and no screenshots were captured."
                : hasAnyScreenshot
                  ? "Video unavailable — screenshots preserved."
                  : "Partial capture — no recording, and no screenshots survived."}
          </p>
        )}
      </div>

      {ordered.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div
            className="flex min-w-0 gap-2 overflow-x-auto pb-1"
            data-testid="browser-filmstrip-track"
          >
            {ordered.map((step) => {
              const key = browserStepKey(step);
              const status = browserStepStatus(step);
              const isActive = key === activeKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectStep(step)}
                  aria-pressed={isActive}
                  title={browserStepLabel(step)}
                  data-testid="browser-filmstrip-frame"
                  data-step-key={key}
                  data-active={isActive ? "true" : "false"}
                  className={cn(
                    "flex w-28 shrink-0 flex-col gap-1 rounded-md border p-1 text-left transition-colors",
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-border/50 hover:border-border",
                  )}
                >
                  {step.screenshotUrl ? (
                    <img
                      src={step.screenshotUrl}
                      alt={browserStepLabel(step)}
                      loading="lazy"
                      className="h-16 w-full rounded-sm border border-border/40 bg-background object-cover object-top"
                    />
                  ) : (
                    <div className="flex h-16 w-full items-center justify-center rounded-sm border border-dashed border-border/50 bg-muted/20 text-[10px] text-muted-foreground">
                      No frame
                    </div>
                  )}
                  <span className="truncate text-[10px] font-medium text-foreground">
                    {browserStepActionVerb(step.action)}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[10px]",
                      status === "error"
                        ? "text-red-500"
                        : "text-muted-foreground",
                    )}
                  >
                    {step.videoOffsetMs != null
                      ? formatOffset(step.videoOffsetMs)
                      : `turn ${step.promptIndex + 1}`}
                  </span>
                </button>
              );
            })}
          </div>

          {activeStep ? (
            <BrowserStepDetail
              step={activeStep}
              className="rounded-lg bg-muted/5 px-4 py-4"
            />
          ) : (
            <p className="px-1 text-[11px] text-muted-foreground">
              Select a frame to see the interaction that produced it.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
