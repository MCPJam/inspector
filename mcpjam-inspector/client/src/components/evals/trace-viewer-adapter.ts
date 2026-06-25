// Inspector boundary shim over @mcpjam/chat-ui/trace.
//
// The Tier-A-compatible trace/replay adaptation LOGIC is single-sourced in the
// package. This module keeps two inspector-specific concerns at the boundary so
// chat-ui stays free of eval-domain and MCP-Apps-SDK type dependencies:
//   1. `TraceEnvelope` — the inspector's richer envelope (eval spans + browser
//      render artifacts). The package adapter only reads `messages` /
//      `widgetSnapshots`, so the envelope is structurally compatible with the
//      package's `TraceInput`.
//   2. The package returns placeholder widget/CSP types on `ToolRenderOverride`;
//      we bridge those back to the inspector's real MCP-Apps SDK types so
//      interactive consumers (TranscriptThread, live chat, Views) keep their
//      types. The read-only paths never read those widget fields, so the cast is
//      safe here.
import {
  adaptTraceToUiMessages as adaptTraceToUiMessagesImpl,
  buildToolRenderOverridesFromSnapshots as buildToolRenderOverridesFromSnapshotsImpl,
  type AdaptedTraceResult as PackageAdaptedTraceResult,
  type TraceSourceMessage,
  type TraceWidgetSnapshot,
} from "@mcpjam/chat-ui/trace";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceSpan,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";

export { snapshotsToTraceWidgetSnapshots } from "@mcpjam/chat-ui/trace";
export type {
  TraceContentPart,
  TraceMessage,
  TraceSourceMessage,
  TraceWidgetSnapshot,
} from "@mcpjam/chat-ui/trace";

type ToolResultDisplay = "sibling-text" | "attached-to-tool";

/**
 * Inspector trace envelope: the package's structural trace input plus
 * eval-domain spans / browser-render artifacts. Kept inspector-side so chat-ui
 * stays free of eval-domain types.
 */
export interface TraceEnvelope {
  traceVersion?: 1;
  messages?: TraceSourceMessage[];
  widgetSnapshots?: TraceWidgetSnapshot[];
  spans?: EvalTraceSpan[];
  widgetRenderObservations?: EvalTraceWidgetRenderObservationView[];
  browserInteractionSteps?: EvalTraceBrowserInteractionStepView[];
  /**
   * Resolved URL for the iteration's replay `.webm` (backend resolves
   * `videoBlobId → videoUrl` the same way it does screenshots). Iteration-level;
   * absent when no browser ran or the upload failed → no replay player.
   */
  videoUrl?: string | null;
  traceStartedAtMs?: number;
  traceEndedAtMs?: number;
  [key: string]: unknown;
}

/**
 * Inspector-typed adapter result: the package result carries placeholder
 * widget/CSP types on `ToolRenderOverride`; bridge to the inspector's real
 * MCP-Apps types so interactive consumers keep their types.
 */
export interface AdaptedTraceResult
  extends Omit<PackageAdaptedTraceResult, "toolRenderOverrides"> {
  toolRenderOverrides: Record<string, ToolRenderOverride>;
}

export function adaptTraceToUiMessages(params: {
  trace: TraceEnvelope | TraceSourceMessage | TraceSourceMessage[] | null;
  toolsMetadata?: Record<string, Record<string, unknown>>;
  toolServerMap?: ToolServerMap;
  connectedServerIds?: string[];
  toolResultDisplay?: ToolResultDisplay;
}): AdaptedTraceResult {
  // Only `toolRenderOverrides` needs the placeholder→real widget-type bridge;
  // narrow the cast to that field so the rest of the result keeps compile-time
  // checking against the package shape.
  const result = adaptTraceToUiMessagesImpl(params);
  // Stabilize message React keys across the streaming-trace → persisted-blob
  // swap. The package adapter assigns index-based ids (`trace-<role>-<index>`),
  // but the streaming envelope and the persisted blob reconstruct the message
  // list with different merge/skip patterns, so a tool-bearing message can land
  // on a different index at completion. `transcript-thread.tsx` keys rows by
  // `message.id`, so an id shift remounts that message's whole subtree —
  // reloading any mounted MCP App widget iframe (wiping live widget state, e.g.
  // a populated cart). Re-key tool-bearing messages by their first toolCallId
  // (stable across both representations) so the widget's row keeps its identity.
  // Non-tool rows keep the index-based id (no widget → a harmless text re-render
  // if their index shifts). toolCallId is unique per UI message here (call +
  // result are merged into one), so no key collisions; a `seen` guard is kept
  // for safety.
  const seenIds = new Set<string>();
  const stabilizedMessages = (result.messages ?? []).map((message, index) => {
    const parts = (message.parts ?? []) as Array<{ toolCallId?: unknown }>;
    const firstToolCallId = parts.find(
      (part) =>
        part &&
        typeof part === "object" &&
        typeof part.toolCallId === "string" &&
        part.toolCallId.length > 0,
    )?.toolCallId as string | undefined;
    let nextId = firstToolCallId
      ? `trace-tool-${firstToolCallId}`
      : (message.id ?? `trace-msg-${index}`);
    if (seenIds.has(nextId)) nextId = `${nextId}-${index}`;
    seenIds.add(nextId);
    return nextId === message.id ? message : { ...message, id: nextId };
  });
  return {
    ...result,
    messages: stabilizedMessages,
    toolRenderOverrides:
      result.toolRenderOverrides as AdaptedTraceResult["toolRenderOverrides"],
  };
}

export function buildToolRenderOverridesFromSnapshots(
  snapshots: TraceWidgetSnapshot[],
  options: { preferLiveWhenPossible?: boolean } = {},
): Record<string, ToolRenderOverride> {
  return buildToolRenderOverridesFromSnapshotsImpl(
    snapshots,
    options,
  ) as unknown as Record<string, ToolRenderOverride>;
}
