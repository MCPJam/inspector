/**
 * eval-step-replay.ts — the single, pure "one row per authored step" assembler.
 *
 * Joins the THREE persisted sources for an eval iteration into an ordered
 * `EvalStepReplay[]` (exactly one entry per authored `TestStep`, in author
 * order):
 *
 *   1. `iteration.testCaseSnapshot.steps`     — the authored step list (identity + kind)
 *   2. `iteration.metadata.stepResults`        — the per-step VERDICT (status + reason),
 *      written at finalize from the runner's `StepExecutionState`. The authoritative
 *      source: every kind (prompt/toolCall/interact/assert) gets a row, keyed by `stepId`.
 *   3. the resolved trace envelope             — per-step EVIDENCE (screenshots, video,
 *      widget→host tool calls), bucketed by `authoredStepId` with a
 *      `promptIndex`+`toolCallId` fallback for pre-`authoredStepId` runs.
 *
 * Used by the public `/eval-runs/:runId/iterations/:id/steps` v1 route (and is a
 * natural fit for the client Steps view — `trace-timeline.tsx` /
 * `predicates-list.tsx` / `browser-artifacts-view.tsx` derive the same facts ad
 * hoc today and can adopt this later).
 *
 * Back-compat: when `metadata.stepResults` is absent (a run finalized before the
 * field existed) the assembler degrades to a best-effort verdict derived from
 * `metadata.skippedSteps` + the browser-artifact rows, so old runs still render.
 */

import type { TestStep } from "./steps";
import type { EvalStepStatus } from "./eval-stream-events";

export type EvalStepResultStatus = "ok" | "fail" | "skipped" | "pending";

/**
 * One verdict row per authored step. Persisted at `testIteration.metadata.stepResults`
 * (open `v.record`, so no Convex schema change). Mirrors the runner's
 * `StepAssertionResult` / `InteractionFailure` / `SkippedStep` collapsed onto the
 * authored step list — `stepId` is the join key the persisted predicates lost.
 */
export type EvalStepResultRecord = {
  stepId: string;
  stepIndex: number;
  kind: TestStep["kind"];
  status: EvalStepResultStatus;
  reason?: string;
};

/** Public-safe evidence for one step, lifted from the resolved trace envelope. */
export type EvalStepEvidence = {
  /** Widget→host tool calls a click/interact triggered (name + sanitized args). */
  toolCalls?: Array<{ name: string; args: unknown; ok: boolean; error?: string }>;
  /** Resolved screenshot URL (render observation or interaction step). */
  screenshotUrl?: string;
  /** Resolved iteration replay `.webm` URL (iteration-level; same on every row). */
  videoUrl?: string;
  /** Playback offset for this step within the replay video, when known (M2). */
  videoOffsetMs?: number;
  /** "scripted" (authored interact/assert) vs "computer_use" (model-driven). */
  source?: "computer_use" | "scripted";
  /** Human-readable interaction target (e.g. the button label). */
  locatorLabel?: string;
};

/** One assembled row: authored-step identity + verdict + evidence. */
export type EvalStepReplay = EvalStepResultRecord & {
  evidence?: EvalStepEvidence;
};

/** Structural subset of the resolved trace envelope this assembler reads. */
export type StepReplayEnvelope = {
  widgetRenderObservations?: ReadonlyArray<Record<string, unknown>>;
  browserInteractionSteps?: ReadonlyArray<Record<string, unknown>>;
  videoUrl?: string | null;
};

/** Structural subset of `testIteration.metadata` this assembler reads. */
export type StepReplayMetadata = {
  stepResults?: ReadonlyArray<Record<string, unknown>>;
  skippedSteps?: ReadonlyArray<Record<string, unknown>>;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Evidence keyed for lookup: by authoredStepId (primary) + promptIndex:toolCallId (fallback). */
type EvidenceIndex = {
  byStepId: Map<string, Record<string, unknown>>;
  byPromptTool: Map<string, Record<string, unknown>>;
};

function indexRows(rows: ReadonlyArray<Record<string, unknown>>): EvidenceIndex {
  const byStepId = new Map<string, Record<string, unknown>>();
  const byPromptTool = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const stepId = str(row.authoredStepId);
    // First write wins so the earliest matching artifact represents the step.
    if (stepId && !byStepId.has(stepId)) byStepId.set(stepId, row);
    const pi = num(row.promptIndex);
    const tc = str(row.toolCallId);
    if (pi !== undefined && tc) {
      const key = `${pi}:${tc}`;
      if (!byPromptTool.has(key)) byPromptTool.set(key, row);
    }
  }
  return { byStepId, byPromptTool };
}

function evidenceFor(
  stepId: string,
  index: EvidenceIndex,
): Record<string, unknown> | undefined {
  return index.byStepId.get(stepId);
}

function toEvidence(
  interaction: Record<string, unknown> | undefined,
  render: Record<string, unknown> | undefined,
  videoUrl: string | undefined,
): EvalStepEvidence | undefined {
  const ev: EvalStepEvidence = {};
  const screenshotUrl =
    str(interaction?.screenshotUrl) ?? str(render?.screenshotUrl);
  if (screenshotUrl) ev.screenshotUrl = screenshotUrl;
  // The replay video is iteration-level, so it's only meaningful PER STEP when
  // the step is seekable (has an offset). Attaching it to every bare step would
  // be noise; fetch the whole-iteration video from the trace endpoint instead.
  const offset = num(interaction?.videoOffsetMs);
  if (offset !== undefined) {
    ev.videoOffsetMs = offset;
    if (videoUrl) ev.videoUrl = videoUrl;
  }
  const source = str(interaction?.source);
  if (source === "computer_use" || source === "scripted") ev.source = source;
  const locatorLabel = str(interaction?.locatorLabel);
  if (locatorLabel) ev.locatorLabel = locatorLabel;
  const widgetToolCalls = interaction?.widgetToolCalls;
  if (Array.isArray(widgetToolCalls) && widgetToolCalls.length > 0) {
    ev.toolCalls = widgetToolCalls.map((c: Record<string, unknown>) => ({
      name: str(c.name) ?? "",
      args: c.args,
      ok: c.ok === true,
      ...(str(c.error) ? { error: str(c.error) } : {}),
    }));
  }
  return Object.keys(ev).length > 0 ? ev : undefined;
}

/** Best-effort status when `metadata.stepResults` is absent (pre-change runs). */
function fallbackStatus(
  step: TestStep,
  skippedIds: Set<string>,
  interaction: Record<string, unknown> | undefined,
): { status: EvalStepResultStatus; reason?: string } {
  if (skippedIds.has(step.id)) return { status: "skipped" };
  const assertion = interaction?.assertion as
    | { passed?: boolean; reason?: string }
    | undefined;
  if (assertion && typeof assertion.passed === "boolean") {
    return {
      status: assertion.passed ? "ok" : "fail",
      ...(assertion.reason ? { reason: assertion.reason } : {}),
    };
  }
  if (interaction && typeof interaction.ok === "boolean") {
    return { status: interaction.ok ? "ok" : "fail" };
  }
  // prompt/toolCall (and predicate asserts whose verdict we can't key by stepId
  // without the persisted rows) degrade to "pending" rather than a false "ok".
  return { status: "pending" };
}

/**
 * Persisted per-step verdicts (`metadata.stepResults`) keyed by `stepId`, in the
 * `EvalStepStatus` shape the Steps view's row renderer consumes. This is the
 * completed-run analogue of the live `step_status` stream: it lets a finished
 * iteration's Steps tab show each assert/interact verdict inline, instead of
 * leaning on a separate predicate-gate footer.
 *
 * `"pending"` rows (a step that never evaluated — e.g. an assert that didn't run)
 * are omitted so their row stays neutral rather than reading as a pass/fail.
 * Returns an empty map when the field is absent (runs finalized before
 * `stepResults` existed) — the Steps view then falls back to artifact-derived
 * verdicts, exactly as before.
 */
export function parseStepStatusById(
  metadata: StepReplayMetadata | undefined,
): Map<string, EvalStepStatus> {
  const map = new Map<string, EvalStepStatus>();
  for (const r of metadata?.stepResults ?? []) {
    const stepId = str(r.stepId);
    const status = str(r.status);
    if (!stepId) continue;
    if (status === "ok" || status === "fail" || status === "skipped") {
      map.set(stepId, status);
    }
  }
  return map;
}

/**
 * Assemble the ordered per-authored-step replay. Pure; no I/O. `steps` is the
 * authored list (`testCaseSnapshot.steps`); `metadata` is `iteration.metadata`;
 * `envelope` is the resolved trace envelope from `getTestIterationBlob`.
 */
export function assembleStepResults(
  steps: ReadonlyArray<TestStep>,
  metadata: StepReplayMetadata | undefined,
  envelope: StepReplayEnvelope | undefined,
): EvalStepReplay[] {
  const records = new Map<string, EvalStepResultRecord>();
  for (const r of metadata?.stepResults ?? []) {
    const stepId = str(r.stepId);
    if (!stepId) continue;
    records.set(stepId, {
      stepId,
      stepIndex: num(r.stepIndex) ?? 0,
      kind: (str(r.kind) ?? "prompt") as TestStep["kind"],
      status: (str(r.status) ?? "pending") as EvalStepResultStatus,
      ...(str(r.reason) ? { reason: str(r.reason) } : {}),
    });
  }
  const skippedIds = new Set<string>(
    (metadata?.skippedSteps ?? [])
      .map((s) => str(s.stepId))
      .filter((id): id is string => Boolean(id)),
  );

  const interactions = indexRows(envelope?.browserInteractionSteps ?? []);
  const renders = indexRows(envelope?.widgetRenderObservations ?? []);
  const videoUrl = str(envelope?.videoUrl ?? undefined);

  return steps.map((step, stepIndex) => {
    const interaction = evidenceFor(step.id, interactions);
    const render = evidenceFor(step.id, renders);
    const persisted = records.get(step.id);
    const verdict =
      persisted ?? {
        stepId: step.id,
        stepIndex,
        kind: step.kind,
        ...fallbackStatus(step, skippedIds, interaction),
      };
    const evidence = toEvidence(interaction, render, videoUrl);
    return { ...verdict, ...(evidence ? { evidence } : {}) };
  });
}
