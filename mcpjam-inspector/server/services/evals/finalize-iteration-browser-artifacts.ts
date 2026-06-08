import type { ConvexHttpClient } from "convex/browser";
import type {
  BrowserInteractionStepPayload,
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
  SerializedBrowserInteractionStep,
  SerializedWidgetRenderObservation,
  WidgetRenderObservationPayload,
} from "@/shared/eval-trace";
import { logger } from "../../utils/logger.js";
import { uploadScreenshotBlob } from "../../utils/mcp-app-widget-capture.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";

/**
 * PR 6b: serialize browser-rendered MCP App eval artifacts for the backend.
 *
 * These run inside `finalizeEvalIteration` exactly ONCE per iteration, BEFORE
 * the W2 per-turn fanout or the W1 single-call fallback consume the result, so
 * a screenshot blob is never uploaded twice. Each helper:
 *   - uploads the transient base64 screenshot (`screenshotBase64` →
 *     `screenshotBlobId`) — best-effort: a failed upload drops the blob id but
 *     KEEPS the row (status / timings / console errors stay useful for replay),
 *   - runs the record through `sanitizeForConvexTransport` ($-key escaping is
 *     required for the `widgetToolCalls[].args: v.any()` field on steps),
 *   - retains `promptIndex` so the fanout can bucket per turn.
 *
 * Uploads are sequential (not `Promise.all`): under the harness budgets
 * (≤ 12 steps + a few observations per iteration) the wall-clock cost is dwarfed
 * by the rest of the fanout, and the convex-test storage mock expects serial
 * writes. Batch only if real evals show latency (see PR plan risks).
 */
export async function serializeRenderObservationsForBackend(
  observations: RunnerWidgetRenderObservation[] | undefined,
  convexClient: ConvexHttpClient,
): Promise<SerializedWidgetRenderObservation[]> {
  if (!observations?.length) return [];
  const out: SerializedWidgetRenderObservation[] = [];
  for (const obs of observations) {
    let screenshotBlobId: string | undefined;
    if (obs.screenshotBase64) {
      try {
        screenshotBlobId = await uploadScreenshotBlob(
          convexClient,
          obs.screenshotBase64,
        );
      } catch (err) {
        logger.warn("[eval-persist] dropped render-obs screenshot upload", {
          toolCallId: obs.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Drop the transient base64; keep every other field (incl. promptIndex).
    const { screenshotBase64: _screenshotBase64, ...rest } = obs;
    const serialized: SerializedWidgetRenderObservation = {
      ...rest,
      ...(screenshotBlobId ? { screenshotBlobId } : {}),
    };
    // No $-key risk on observations (no v.any fields), but stay consistent with
    // widgets and route through the sanitizer regardless.
    out.push(sanitizeForConvexTransport(serialized));
  }
  return out;
}

export async function serializeBrowserStepsForBackend(
  steps: RunnerBrowserInteractionStep[] | undefined,
  convexClient: ConvexHttpClient,
): Promise<SerializedBrowserInteractionStep[]> {
  if (!steps?.length) return [];
  const out: SerializedBrowserInteractionStep[] = [];
  for (const step of steps) {
    let screenshotBlobId: string | undefined;
    if (step.screenshotBase64) {
      try {
        screenshotBlobId = await uploadScreenshotBlob(
          convexClient,
          step.screenshotBase64,
        );
      } catch (err) {
        logger.warn("[eval-persist] dropped browser-step screenshot upload", {
          toolCallId: step.toolCallId,
          stepIndex: step.stepIndex,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Drop the transient base64; keep every other field (incl. promptIndex).
    const { screenshotBase64: _screenshotBase64, ...rest } = step;
    const serialized: SerializedBrowserInteractionStep = {
      ...rest,
      ...(screenshotBlobId ? { screenshotBlobId } : {}),
    };
    // $-keys can appear inside widgetToolCalls[].args (v.any() on the backend
    // validator). sanitizeForConvexTransport handles the escape.
    out.push(sanitizeForConvexTransport(serialized));
  }
  return out;
}

/** Strip `promptIndex` for the backend turn payload — the backend stamps it
 *  from `turn.promptIndex` server-side. */
export function toObservationPayload(
  obs: SerializedWidgetRenderObservation,
): WidgetRenderObservationPayload {
  const { promptIndex: _promptIndex, ...payload } = obs;
  return payload;
}

export function toBrowserStepPayload(
  step: SerializedBrowserInteractionStep,
): BrowserInteractionStepPayload {
  const { promptIndex: _promptIndex, ...payload } = step;
  return payload;
}
