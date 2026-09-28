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

/** What a recording reports about itself, as the trace carries it. */
export type IterationVideoMeta = {
  source?: string;
  fps?: number;
  durationMs?: number;
  distinctFrames?: number;
  truncated?: boolean;
};

/**
 * Pull the recording's own numbers out of a trace result.
 *
 * `undefined` for every trace written before recordings reported anything, and
 * for the local widget harness, which knows none of it. Read field by field
 * because the payload is server-defined and reaches the CLI untyped — a
 * partially-shaped answer yields the fields it does carry rather than nothing.
 */
export function extractIterationVideoMeta(
  result: unknown,
): IterationVideoMeta | undefined {
  const root = asRecord(result);
  if (!root) return undefined;
  const trace = asRecord(root.trace) ?? root;
  const meta = asRecord(trace.videoMeta);
  if (!meta) return undefined;
  const out: IterationVideoMeta = {};
  if (typeof meta.source === "string") out.source = meta.source;
  if (typeof meta.fps === "number") out.fps = meta.fps;
  if (typeof meta.durationMs === "number") out.durationMs = meta.durationMs;
  if (typeof meta.distinctFrames === "number") {
    out.distinctFrames = meta.distinctFrames;
  }
  if (typeof meta.truncated === "boolean") out.truncated = meta.truncated;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The file extension for a recording, from the recorder that made it.
 *
 * The URL is a Convex storage link and carries no extension, so `source` is
 * what there is to go on: the hosted daemon writes a fragmented MP4, the local
 * widget harness a Playwright `.webm`. An unknown or absent source falls back
 * to `.webm` — every recording that predates a second recorder is one of
 * those, and a file named for the wrong container is a file a player refuses
 * before it has read a byte.
 */
export function iterationVideoExtension(
  meta: IterationVideoMeta | undefined,
): "mp4" | "webm" {
  return meta?.source === "hosted" ? "mp4" : "webm";
}

/**
 * One line describing a recording, for a terminal.
 *
 * Built only from what the recorder reported — nothing is derived — and it
 * says `truncated` LOUDLY, because a take that stopped at its size cap is a
 * complete, playable prefix of the run and reads as the whole run otherwise.
 */
export function describeIterationVideo(
  meta: IterationVideoMeta | undefined,
): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (typeof meta.durationMs === "number" && meta.durationMs > 0) {
    parts.push(`${Math.round(meta.durationMs / 1000)}s`);
  }
  if (typeof meta.fps === "number" && meta.fps > 0) parts.push(`${meta.fps}fps`);
  if (typeof meta.distinctFrames === "number") {
    parts.push(`${meta.distinctFrames} distinct frames`);
  }
  if (meta.truncated) parts.push("STOPPED AT THE SIZE LIMIT");
  return parts.join(" · ");
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
