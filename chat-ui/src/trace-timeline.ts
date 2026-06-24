// Public subpath: `@mcpjam/chat-ui/trace-timeline`.
//
// The recorded-trace waterfall (per-span latency + token timeline). Kept on its
// own subpath so the heavier timeline graph (portal tooltip, axis measuring)
// stays out of the default transcript bundle. Tier-A clean: provider-free, no
// design-system / posthog / inspector imports.
export {
  TraceTimeline,
  buildPromptGroups,
  collectStepSpanIdsWithChildren,
  selectAxisTickPercents,
  type TraceTimelineProps,
  type TraceRevealSelection,
  type TimelineFilter,
} from "./internal/trace-timeline/trace-timeline";
export {
  TRACE_TIMELINE_FILTERS,
  timelineFilterLabel,
} from "./internal/trace-timeline/recorded-trace-toolbar";
export type {
  TraceSpan,
  TraceSpanCategory,
  TraceSpanStatus,
} from "./internal/trace-timeline/eval-trace";
