/**
 * Pulling the visual evidence out of an eval run's steps.
 *
 * A browser eval's steps carry `evidence.screenshotUrl` — already RESOLVED by
 * the platform, so a consumer gets a fetchable URL rather than a storage key it
 * would have to know how to sign. This module is the small amount of shape
 * knowledge that sits between "a page of steps" and "the pictures a person
 * wants to see", kept here so every surface that shows run evidence agrees on
 * what counts as evidence and in what order.
 *
 * NOT THE CLI'S TRACE EXTRACTOR. The CLI reads a different payload (the
 * iteration trace) with a different shape. Sharing a name between the two would
 * invite one to be "fixed" to match the other, and they are not the same thing.
 *
 * Pure and runtime-agnostic on purpose (no fetch, no Node built-ins): the
 * caller decides how to fetch and how to display, which is the part that
 * differs per surface.
 */
import type { PlatformEvalStepResult } from "./types.js";

/** One screenshot, with enough context for a caption. */
export interface StepScreenshot {
  url: string;
  stepId: string;
  stepIndex: number;
  status: PlatformEvalStepResult["status"];
  /** The interaction target, when the step recorded one (a button label). */
  label?: string;
}

export interface CollectScreenshotsOptions {
  /**
   * Stop after this many. A run can have hundreds of steps and every surface
   * that shows them has a limit; taking it here keeps the cap in one place
   * instead of each caller slicing a list it already paid to build.
   */
  limit?: number;
  /**
   * Only steps that FAILED. When a run fails, the failing step is what someone
   * wants to look at, and the twenty green ones before it are noise.
   */
  failedOnly?: boolean;
}

/**
 * Screenshot URLs from a page of steps, in author order.
 *
 * Order is the steps' own `stepIndex`, not their arrival order: the list is the
 * story of what the run did, and out-of-order pictures tell it wrong.
 * Duplicates are dropped — a video-backed run can repeat one frame URL across
 * steps, and the same picture twice reads as two things having happened.
 */
export function collectStepScreenshots(
  steps: readonly PlatformEvalStepResult[],
  options: CollectScreenshotsOptions = {}
): StepScreenshot[] {
  // Checked BEFORE the loop, not only after a push: the post-push check alone
  // would return one entry for `limit: 0`, and this is exported public API
  // whose contract has to hold without a caller knowing that.
  if (options.limit !== undefined && options.limit <= 0) return [];
  const seen = new Set<string>();
  const found: StepScreenshot[] = [];
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  for (const step of ordered) {
    if (options.failedOnly && step.status !== "fail") continue;
    const url = step.evidence?.screenshotUrl;
    if (typeof url !== "string" || !url || seen.has(url)) continue;
    seen.add(url);
    found.push({
      url,
      stepId: step.stepId,
      stepIndex: step.stepIndex,
      status: step.status,
      ...(step.evidence?.locatorLabel
        ? { label: step.evidence.locatorLabel }
        : {}),
    });
    if (options.limit !== undefined && found.length >= options.limit) break;
  }
  return found;
}

/**
 * The steps worth showing, preferring failures.
 *
 * When anything failed, those steps ARE the answer and the passing ones are
 * noise. When nothing failed, the run still deserves a picture — so fall back
 * to the whole sequence rather than returning nothing, which a caller would
 * have to special-case to avoid reporting "no evidence" for a healthy run.
 */
export function selectStepScreenshots(
  steps: readonly PlatformEvalStepResult[],
  limit: number
): StepScreenshot[] {
  const failed = collectStepScreenshots(steps, { failedOnly: true, limit });
  if (failed.length > 0) return failed;
  return collectStepScreenshots(steps, { limit });
}
