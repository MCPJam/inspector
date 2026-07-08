/**
 * Pure helpers for deriving recording targets from what a run ACTUALLY rendered
 * (not only what the authored spec asserts). Kept out of React so the
 * filter/dedupe/authority rules are unit-tested directly.
 *
 * A "rendered widget target" is a `{promptIndex, toolName}` pair the recorder
 * can arm — `promptIndex` is the same turn index the trace spans carry, which is
 * what `RecordingTarget.promptIndex` / `part-switch`'s widget match expect.
 */
import type {
  EvalTraceSpan,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { RecordingTarget } from "@/components/chat-v2/thread/recorder-types";

export type RenderedWidgetTarget = { promptIndex: number; toolName: string };

/** Minimal trace shape this module reads — either the persisted blob (cast to
 *  carry `widgetRenderObservations`) or the live streaming envelope (spans). */
export type RenderedTraceSource = {
  spans?: EvalTraceSpan[];
  widgetRenderObservations?: EvalTraceWidgetRenderObservationView[];
};

/**
 * Widgets a run rendered, per turn.
 *
 * `widgetRenderObservations` is AUTHORITATIVE: its presence (even empty) means
 * the run has resolved which UI resources actually rendered, so we use it and
 * ignore spans — an empty/render-less run correctly yields no targets. Only when
 * observations are absent (mid-stream, before the persisted blob resolves) do we
 * fall back to tool SPANS, which are optimistic ("the tool was called", not "a
 * widget rendered") and may include non-widget tools (the caller filters those).
 */
export function deriveRenderedWidgetTargets(
  trace: RenderedTraceSource | null | undefined,
): RenderedWidgetTarget[] {
  if (!trace) return [];
  const out: RenderedWidgetTarget[] = [];
  const seen = new Set<string>();
  const push = (promptIndex: number, toolName: string) => {
    const key = `${promptIndex}:${toolName}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ promptIndex, toolName });
  };

  // Authoritative path: observations present (array, possibly empty).
  if (trace.widgetRenderObservations) {
    for (const obs of trace.widgetRenderObservations) {
      if (obs.status === "rendered") push(obs.promptIndex, obs.toolName);
    }
    return out;
  }

  // Optimistic fallback: tool spans (replaced once observations resolve).
  for (const span of trace.spans ?? []) {
    if (
      span.category === "tool" &&
      typeof span.promptIndex === "number" &&
      typeof span.toolName === "string"
    ) {
      push(span.promptIndex, span.toolName);
    }
  }
  return out;
}

/**
 * Build the recorder's `toolCallId → promptIndex` resolver entries.
 *
 * The recording TARGETS use the render observations' `promptIndex` (authored-turn
 * numbering). Tool SPANS number turns by the live message ordinal, which diverges
 * whenever a widget follow-up (e.g. a cart-view `ui/message`) inserts an extra
 * turn — so a span can call a widget "turn 2" that the target calls "turn 1", and
 * the exact-match save gate silently drops the click. Spans are the base (present
 * during streaming before observations resolve); observations OVERRIDE so the
 * resolved promptIndex matches the armed target. Returns entries (Map-ready),
 * dedup-stable by insertion order.
 */
export function buildToolCallPromptIndex(
  spans: Array<{ toolCallId?: string; promptIndex?: number }> | undefined,
  observations:
    | Array<{ toolCallId?: string; promptIndex?: number }>
    | undefined,
): Array<[string, number]> {
  const byToolCallId = new Map<string, number>();
  for (const span of spans ?? []) {
    if (
      typeof span.toolCallId === "string" &&
      typeof span.promptIndex === "number"
    ) {
      byToolCallId.set(span.toolCallId, span.promptIndex);
    }
  }
  for (const obs of observations ?? []) {
    if (
      typeof obs.toolCallId === "string" &&
      typeof obs.promptIndex === "number"
    ) {
      byToolCallId.set(obs.toolCallId, obs.promptIndex);
    }
  }
  return [...byToolCallId.entries()];
}

/**
 * Merge spec-authored targets with run-rendered ones. Authored targets keep
 * their order/priority; rendered targets are filtered to widget tools
 * (`widgetToolNames`) and appended, deduped by `{promptIndex, toolName}` so a
 * widget that is both asserted and rendered appears exactly once.
 */
export function mergeRecordingTargets(
  authored: RecordingTarget[],
  rendered: RenderedWidgetTarget[],
  widgetToolNames: Set<string>,
): RecordingTarget[] {
  const out: RecordingTarget[] = [];
  const seen = new Set<string>();
  const push = (promptIndex: number, toolName: string) => {
    const key = `${promptIndex}:${toolName}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ promptIndex, toolName });
  };
  for (const t of authored) push(t.promptIndex, t.toolName);
  for (const t of rendered) {
    if (widgetToolNames.has(t.toolName)) push(t.promptIndex, t.toolName);
  }
  return out;
}
