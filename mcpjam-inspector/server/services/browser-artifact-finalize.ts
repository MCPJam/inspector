/**
 * browser-artifact-finalize.ts — the ONE terminal step for any runner that
 * drives the headless-Chromium MCP App harness.
 *
 * It exists because of an ordering constraint that is easy to get wrong and
 * silent when you do: the replay `.webm` only reaches disk when Playwright's
 * browser context closes, so `collectVideo()` must run BEFORE the runner tears
 * Chromium down — at *every* terminal site, not just the happy one. Uploading
 * and attaching the bytes, by contrast, needs no browser at all, and must not
 * happen while one is held open: a stalled upload would otherwise pin Chromium
 * (and, for a session run, the MCP client manager behind it) for as long as it
 * hangs.
 *
 * Hence the shape below — capture, then optional teardown, then persist:
 *
 *     capture artifacts + video  (needs the browser alive)
 *            ↓
 *     teardown()                 (browser, then manager — the widget bridge
 *                                 dispatches through the manager, so the
 *                                 harness must die first)
 *            ↓
 *     sink                       (network only)
 *
 * Two sinks, deliberately — an eval iteration and a synthetic session. Not a
 * flag pile: the two differ in where the bytes go, not in the lifecycle above.
 */

import type { ConvexHttpClient } from "convex/browser";
import type { EvalTraceVideoMeta } from "@/shared/eval-trace";
import { logger } from "../utils/logger.js";
import type { BrowserSessionContext } from "./browser-session-context.js";
import { finalizeEvalIteration } from "./evals/finalize-iteration.js";
import type { SuiteRunRecorder } from "./evals/recorder.js";

/** Params the recorder and the direct finalizer both accept. */
export type EvalIterationFinishParams = Parameters<
  SuiteRunRecorder["finishIteration"]
>[0];

/**
 * Send a finished eval iteration to whichever writer this run has: the
 * suite-run recorder, or — on the quick-run path, where `runId === null` and
 * there is no recorder — `finalizeEvalIteration` directly.
 *
 * This ternary used to be hand-copied at each finalize site, which is how one
 * site could quietly diverge (the `systemPrompt`-slot bug had to be fixed in
 * both). One owner now.
 */
export async function dispatchEvalIterationFinalize(args: {
  recorder: SuiteRunRecorder | null;
  convexClient: ConvexHttpClient;
  finishParams: EvalIterationFinishParams;
}): Promise<void> {
  if (args.recorder) {
    await args.recorder.finishIteration(args.finishParams);
    return;
  }
  await finalizeEvalIteration({
    ...args.finishParams,
    convexClient: args.convexClient,
  });
}

/** Where a captured terminal payload goes. */
export type BrowserArtifactFinalizeSink =
  | {
      kind: "eval";
      recorder: SuiteRunRecorder | null;
      convexClient: ConvexHttpClient;
      /** Everything but the video fields, which this module supplies. */
      finishParams: Omit<
        EvalIterationFinishParams,
        "videoBytes" | "videoMime" | "videoMeta"
      >;
    }
  | {
      kind: "session";
      /**
       * Persist the session's terminal state. Called AFTER `teardown`, with the
       * captured video (or null when the harness never launched / recording
       * failed). Must not throw.
       */
      persist: (videoBytes: Buffer | null) => Promise<void>;
    };

/**
 * Capture the run's terminal browser artifacts, optionally tear the runtime
 * down, then persist — in that order, guaranteed.
 *
 * `collectVideo()` is idempotent and fail-soft, so this is safe even when the
 * harness never launched (a prompt-only iteration → `videoBytes` is null) and a
 * later `dispose()` stays a no-op for the video.
 */
export async function finalizeWithBrowserArtifacts(args: {
  browser: BrowserSessionContext;
  /**
   * Optional capture that needs the harness fully intact — a session run drains
   * its last turn's screenshots here. Runs FIRST, before `collectVideo()` (which
   * closes the Playwright context to flush the `.webm`) and before `teardown`.
   * Must not throw.
   */
  captureBeforeTeardown?: () => Promise<void>;
  /**
   * Runtime teardown that must sit BETWEEN capture and persistence (a session
   * run disposes the browser then the MCP manager here). Omitted by callers
   * that own teardown in their own `finally` — eval runners do, and their
   * behavior is unchanged. Must not throw.
   */
  teardown?: () => Promise<void>;
  /**
   * A recording made somewhere other than the local harness — today, the one a
   * hosted daemon wrote on a per-run box, collected before that box was
   * released.
   *
   * A FALLBACK, with explicit precedence: `collectVideo()` above wins whenever
   * it produced bytes. `videoBlobId` is first-write-wins on the backend, so
   * two videos racing for one iteration would land on whichever call arrived
   * first — a coin toss decided by network timing. There is no conflict today
   * (a hosted iteration has no local Chromium to record), and stating the
   * order here is what keeps it that way if one ever appears.
   */
  fallbackVideo?: {
    bytes: Buffer;
    mime: string;
    meta?: EvalTraceVideoMeta;
  } | null;
  sink: BrowserArtifactFinalizeSink;
  /** Log prefix so each surface stays greppable. */
  logScope: string;
}): Promise<void> {
  // FIRST, while the harness is fully intact. `collectVideo()` below closes the
  // Playwright context to flush the `.webm`, so anything that wants a live page
  // has to run ahead of it — the hook's contract says "while the browser is
  // alive", and running it after would have made that quietly false.
  if (args.captureBeforeTeardown) {
    try {
      await args.captureBeforeTeardown();
    } catch (err) {
      logger.warn(`[${args.logScope}] terminal artifact capture failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Contractually fail-soft, but guarded anyway: this runs on a terminal path
  // where the result is already decided, so nothing here may be allowed to
  // change it — and a throw before `teardown` below would leak Chromium.
  let videoBytes: Buffer | null = null;
  try {
    videoBytes = await args.browser.collectVideo();
  } catch (err) {
    logger.warn(`[${args.logScope}] replay video collection failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (args.teardown) {
    try {
      await args.teardown();
    } catch (err) {
      logger.warn(`[${args.logScope}] terminal teardown failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (args.sink.kind === "session") {
    // The session sink takes bytes alone and has no hosted path — a synthetic
    // session runs the local harness. Passing the fallback here would need a
    // mime it cannot carry, so it is not offered rather than half-offered.
    await args.sink.persist(videoBytes);
    return;
  }

  // The local harness first, the fallback only if it produced nothing. See
  // `fallbackVideo` above for why the order is stated rather than left to
  // whichever write reaches the backend first.
  const video =
    videoBytes && videoBytes.length > 0
      ? { bytes: videoBytes, mime: "video/webm", meta: WIDGET_VIDEO_META }
      : args.fallbackVideo ?? null;

  await dispatchEvalIterationFinalize({
    recorder: args.sink.recorder,
    convexClient: args.sink.convexClient,
    finishParams: {
      ...args.sink.finishParams,
      ...(video
        ? {
            videoBytes: video.bytes,
            videoMime: video.mime,
            ...(video.meta ? { videoMeta: video.meta } : {}),
          }
        : {}),
    },
  });
}

/**
 * What the local widget harness's recording says about itself.
 *
 * Only the source. Playwright writes the `.webm` itself and tells us nothing
 * about it — no duration, no frame count, and no way to know it was cut short
 * — so claiming any of those here would be inventing them. The reader's UI
 * shows what is present and nothing else.
 */
const WIDGET_VIDEO_META: EvalTraceVideoMeta = { source: "widget" };
