/**
 * Pull rendered widget screenshots out of an eval iteration trace.
 *
 * The trace payload is server-defined and reaches the CLI untyped, so we parse
 * `trace.widgetRenderObservations` defensively and keep only entries that
 * actually rendered an image (status "rendered" with a screenshot URL). Other
 * statuses (e.g. "skipped") carry no image and are dropped here — the command
 * layer decides how to report their absence.
 */

export type RenderedScreenshot = {
  toolName?: string;
  toolCallId?: string;
  promptIndex?: number;
  status: string;
  screenshotUrl: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Extract rendered screenshots from a `get_eval_iteration_trace` result. Accepts
 * either the full operation result (`{ trace: ... }`) or a bare trace object.
 *
 * Pulls BOTH widget render observations (the model-driven "did it paint?"
 * captures) AND per-step `browserInteractionSteps` screenshots (the authored
 * interact/assert step captures from the unified step engine), in that order.
 * Each carries a usable `screenshotUrl`; entries without an image are dropped.
 */
export function extractRenderedScreenshots(result: unknown): RenderedScreenshot[] {
  const root = asRecord(result);
  if (!root) return [];

  const trace = asRecord(root.trace) ?? root;
  const screenshots: RenderedScreenshot[] = [];

  const observations = trace.widgetRenderObservations;
  if (Array.isArray(observations)) {
    for (const entry of observations) {
      const obs = asRecord(entry);
      if (!obs) continue;
      const status = asString(obs.status);
      const screenshotUrl = asString(obs.screenshotUrl);
      if (status !== "rendered" || !screenshotUrl) continue;
      screenshots.push({
        status,
        screenshotUrl,
        toolName: asString(obs.toolName),
        toolCallId: asString(obs.toolCallId),
        promptIndex:
          typeof obs.promptIndex === "number" ? obs.promptIndex : undefined,
      });
    }
  }

  const interactions = trace.browserInteractionSteps;
  if (Array.isArray(interactions)) {
    for (const entry of interactions) {
      const step = asRecord(entry);
      if (!step) continue;
      const screenshotUrl = asString(step.screenshotUrl);
      if (!screenshotUrl) continue;
      const assertion = asRecord(step.assertion);
      // An assert step labels by its verdict; a pure interact by its action.
      const status = assertion
        ? assertion.passed === true
          ? "assert:passed"
          : "assert:failed"
        : (asString(step.action) ?? "interaction");
      // Prefer the human-readable target; fall back to the action verb.
      const label =
        asString(step.locatorLabel) ?? asString(step.action) ?? "interaction";
      screenshots.push({
        status,
        screenshotUrl,
        toolName: label,
        toolCallId: asString(step.toolCallId),
        promptIndex:
          typeof step.promptIndex === "number" ? step.promptIndex : undefined,
      });
    }
  }

  return screenshots;
}

/**
 * Pull the iteration-level replay video URL out of a `get_eval_iteration_trace`
 * result. The backend resolves the `.webm` storageId to a `videoUrl` at the
 * envelope root (one video per iteration); returns undefined when absent.
 */
export function extractIterationVideoUrl(result: unknown): string | undefined {
  const root = asRecord(result);
  if (!root) return undefined;
  const trace = asRecord(root.trace) ?? root;
  return asString(trace.videoUrl);
}

/**
 * Build a filesystem-safe PNG filename for a screenshot. Keeps the tool name
 * readable but strips anything that isn't alnum/dash/underscore so multi-render
 * iterations don't collide and nothing escapes the target directory.
 */
export function screenshotFilename(
  shot: RenderedScreenshot,
  index: number,
): string {
  const tool = (shot.toolName ?? "widget").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const suffix = shot.toolCallId
    ? shot.toolCallId.replace(/[^a-zA-Z0-9_-]+/g, "-")
    : String(index + 1);
  return `${tool}-${suffix}.png`;
}
