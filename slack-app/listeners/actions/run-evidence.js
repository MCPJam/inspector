/**
 * Posting a finished run's screenshots into the thread that started it.
 *
 * A browser eval that fails has a picture of exactly where it failed. Until
 * now that picture lived in the app and the Slack thread got a link, so the
 * person who approved the run had to leave the conversation to find out what
 * broke. This puts the evidence where the decision was made.
 *
 * EVIDENCE NEVER FAILS THE COMPLETION MESSAGE. Every step here is
 * logged-and-skipped: the run's outcome has already been reported by the
 * watcher, and an upload that could turn a correct outcome message into an
 * unhandled rejection would be trading the important thing for the nice one.
 * There is no partial-failure path worth surfacing — a missing screenshot is
 * something the user can go and look at; a lost outcome is not.
 *
 * THE EXTRACTION IS MIRRORED, NOT IMPORTED. `@mcpjam/sdk/platform` exports
 * `selectStepScreenshots` with exactly these rules, and this bot deliberately
 * ships only its own runtime dependencies (~38 MB — see the Dockerfile), so
 * pulling the SDK in for one pure function would multiply the image for
 * nothing. The three decisions below are the ones that matter and the tests
 * pin them on both sides.
 */
import { getEvalRunSteps, listEvalRunIterations } from '../../agent/mcpjam-client.js';

/** Slack's own guidance is a handful of images per message; five is plenty. */
const MAX_SCREENSHOTS = 5;

/**
 * Iterations to look through. A suite runs every case × iteration, so a run can
 * have dozens; the first few contain the same story as the rest and each one
 * costs a request against a bot that is already holding a watcher open.
 */
const MAX_ITERATIONS = 3;

/** Per-image download budget. Signed artifact URLs are fast or they are broken. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/** Refuse anything implausible for a screenshot rather than buffering it. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Screenshot URLs from a page of steps, in author order.
 *
 * Mirrors `collectStepScreenshots` in `@mcpjam/sdk/platform`. Three decisions,
 * all deliberate:
 *   - ORDER by the steps' own `stepIndex`, not arrival order. The list is the
 *     story of what the run did, and out-of-order pictures tell it wrong.
 *   - DROP a repeated url. A video-backed run can reuse one frame across
 *     steps, and the same picture twice reads as two things having happened.
 *   - PREFER failing steps (see `selectStepScreenshots` below).
 *
 * @param {Array<Record<string, any>>} steps
 * @param {{ limit?: number, failedOnly?: boolean }} [options]
 * @returns {Array<{ url: string, stepId: string, stepIndex: number, status: string, label?: string }>}
 */
export function collectStepScreenshots(steps, options = {}) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ url: string, stepId: string, stepIndex: number, status: string, label?: string }>} */
  const found = [];
  const ordered = (Array.isArray(steps) ? [...steps] : []).sort(
    (left, right) => (left?.stepIndex ?? 0) - (right?.stepIndex ?? 0),
  );
  for (const step of ordered) {
    if (options.failedOnly && step?.status !== 'fail') continue;
    const url = step?.evidence?.screenshotUrl;
    if (typeof url !== 'string' || !url || seen.has(url)) continue;
    seen.add(url);
    found.push({
      url,
      stepId: String(step?.stepId ?? ''),
      stepIndex: Number(step?.stepIndex ?? 0),
      status: String(step?.status ?? ''),
      ...(step?.evidence?.locatorLabel ? { label: String(step.evidence.locatorLabel) } : {}),
    });
    if (options.limit !== undefined && found.length >= options.limit) break;
  }
  return found;
}

/**
 * The steps worth showing, preferring failures.
 *
 * When something failed, those steps ARE the answer and the passing ones are
 * noise. When nothing failed the run still deserves a picture, so fall back to
 * the whole sequence rather than returning nothing — otherwise a healthy run
 * would have to be special-cased to avoid reporting that it produced no
 * evidence.
 *
 * @param {Array<Record<string, any>>} steps
 * @param {number} limit
 */
export function selectStepScreenshots(steps, limit) {
  const failed = collectStepScreenshots(steps, { failedOnly: true, limit });
  if (failed.length > 0) return failed;
  return collectStepScreenshots(steps, { limit });
}

/**
 * Download one artifact, bounded.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Buffer>}
 */
async function fetchImageBytes(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(`image is ${declared} bytes, over the ${MAX_IMAGE_BYTES} cap`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    // Re-check after the fact: `content-length` is a claim, not a guarantee.
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`image is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES} cap`);
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A short, human caption for one screenshot.
 * @param {{ stepIndex: number, status: string, label?: string }} shot
 */
function captionFor(shot) {
  const where = shot.label ? ` — ${shot.label}` : '';
  return `Step ${shot.stepIndex + 1}${where}${shot.status === 'fail' ? ' (failed)' : ''}`;
}

/**
 * Post up to five of a finished run's screenshots into its thread.
 *
 * Called from the run watcher's completion hook, AFTER the outcome message has
 * been written. Resolves rather than rejects on every failure path.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {{
 *   runId: string,
 *   ctx: import('../../agent/slack-context.js').SlackContext,
 *   channelId: string,
 *   threadTs: string,
 *   logger: import('@slack/bolt').Logger,
 *   fetchImpl?: typeof fetch,
 * }} args
 * @returns {Promise<number>} how many images were uploaded
 */
export async function postRunEvidence(client, args) {
  const { logger } = args;
  /** @type {Array<{ url: string, stepId: string, stepIndex: number, status: string, label?: string }>} */
  const shots = [];
  try {
    const iterations = await listEvalRunIterations(args.runId, args.ctx, {
      limit: MAX_ITERATIONS,
    });
    for (const iteration of iterations.slice(0, MAX_ITERATIONS)) {
      if (shots.length >= MAX_SCREENSHOTS) break;
      const iterationId = typeof iteration?.id === 'string' ? iteration.id : null;
      if (!iterationId) continue;
      let steps;
      try {
        steps = await getEvalRunSteps(args.runId, iterationId, args.ctx);
      } catch (error) {
        // One unreadable iteration must not cost the others.
        logger.warn(`Could not read steps for iteration ${iterationId}: ${error}`);
        continue;
      }
      shots.push(...selectStepScreenshots(steps, MAX_SCREENSHOTS - shots.length));
    }
  } catch (error) {
    logger.warn(`Could not read run evidence for ${args.runId}: ${error}`);
    return 0;
  }

  if (shots.length === 0) return 0;

  /** @type {Array<{ file: Buffer, filename: string, title: string }>} */
  const uploads = [];
  for (const shot of shots) {
    try {
      uploads.push({
        file: await fetchImageBytes(shot.url, args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
        filename: `step-${shot.stepIndex + 1}.png`,
        title: captionFor(shot),
      });
    } catch (error) {
      // A screenshot we cannot download is one the user can still go and look
      // at in the app. Skip it and post the rest.
      logger.warn(`Could not download run evidence ${shot.url}: ${error}`);
    }
  }
  if (uploads.length === 0) return 0;

  try {
    await client.files.uploadV2({
      channel_id: args.channelId,
      thread_ts: args.threadTs,
      initial_comment: 'Here is what it looked like:',
      file_uploads: uploads,
    });
    return uploads.length;
  } catch (error) {
    // The outcome message is already correct and posted. This was the extra.
    logger.warn(`Could not upload run evidence for ${args.runId}: ${error}`);
    return 0;
  }
}
